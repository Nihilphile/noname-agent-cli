'use strict';

// A deliberately small finite language.  It never evaluates JavaScript and
// leaves all legality decisions to the game's current visible choice.
const MAX_STEPS = 256;
const { parsePlay, matchesCard, formatCard } = require('./play-language.cjs');
const { createNames } = require('./experimental-format.cjs');
const invalid = message => Object.assign(new Error(message), { code: 'invalid_play' });

function validatePlan(plan) {
  if (!plan || plan.kind !== 'play-plan' || !Array.isArray(plan.groups) || !plan.groups.length) throw invalid('需要 parsePlay 返回的计划。');
  let count = 0;
  for (const group of plan.groups) {
    if (!Array.isArray(group) || !group.length) throw invalid('每个 | 分组都必须包含操作。');
    for (const step of group) {
      if (!step || !['act', 'card', 'select', 'end'].includes(step.kind) || typeof step.raw !== 'string') throw invalid('计划步骤无效。');
      if (++count > MAX_STEPS) throw invalid(`play 最多包含 ${MAX_STEPS} 项操作。`);
    }
  }
}

function executePlay(input, adapter, options = {}) {
  const plan = typeof input === 'string' ? parsePlay(input) : input;
  let state = null, effects = null, effectEpoch, stateEpoch;
  let planPhaseId, transportRequestId;
  const output = [];
  let hadFailure = false, actionCount = 0, anyMutation = false;
  let cursor = { group: 0, step: 0 }, activeRecord = null, activeConsumed = false, activeFailure = null;
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 500;
  const random = options.random ?? Math.random;
  const base = extra => ({ kind: 'play', ok: false, status: 'paused', value: null, steps: output, state, stateFresh: true, remaining: '', ...extra });
  async function saveProgress() {
    if (typeof options.onProgress !== 'function') return;
    const steps = activeRecord && !output.includes(activeRecord) ? [...output, activeRecord] : output;
    await options.onProgress({ kind: 'play', status: 'paused', value: null, ok: false,
      steps: JSON.parse(JSON.stringify(steps)), completedSteps: steps.filter(s => s.status === 'completed').length,
      mustObserve: true, stateFresh: false, remaining: remainingFrom(activeConsumed ? nextCursor(cursor) : cursor) });
  }
  try { validatePlan(plan); }
  catch (error) { return Promise.resolve(base({ status: 'failed', value: 0, code: 'invalid_play', message: error.message, remaining: plan?.source || '' })); }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 5000 || typeof random !== 'function') {
    return Promise.resolve(base({ status: 'failed', value: 0, code: 'invalid_options', message: 'timeoutMs 范围 1..60000；intervalMs 范围 0..5000。', remaining: plan.source }));
  }
  if (!adapter || !['observe', 'act', 'effects', 'sleep'].every(name => typeof adapter[name] === 'function')) {
    return Promise.resolve(base({ status: 'failed', value: 0, code: 'invalid_adapter', message: 'play 需要 observe/act/effects/sleep 适配器。', remaining: plan.source }));
  }

  const deadline = Date.now() + timeoutMs;
  const nextCursor = position => {
    const group = plan.groups[position.group];
    if (position.step + 1 < group.length) return { group: position.group, step: position.step + 1 };
    if (position.group + 1 < plan.groups.length) return { group: position.group + 1, step: 0 };
    return null;
  };
  const nextGroupCursor = position => position.group + 1 < plan.groups.length ? { group: position.group + 1, step: 0 } : null;
  const deferCurrentFinal = () => options.deferFinalWait === true && !hadFailure && nextCursor(cursor) === null;
  const remainingFrom = position => {
    if (!position) return '';
    const chunks = [];
    for (let groupIndex = position.group; groupIndex < plan.groups.length; groupIndex++) {
      const start = groupIndex === position.group ? position.step : 0;
      const text = plan.groups[groupIndex].slice(start).map(step => step.raw).join(' > ');
      if (text) chunks.push(text);
    }
    return chunks.join(' | ');
  };
  const error = (code, message, stateFresh = false) => Object.assign(new Error(message), { code, stateFresh });
  async function call(fn, mutation = false) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw error('timeout', 'play 达到总时限。');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => { timer = setTimeout(() => reject(error(mutation ? 'result_unknown' : 'timeout', mutation ? '操作已发送但结果未确认；请观察后决定，勿自动重放。' : 'play 达到总时限。')), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  function checkState(value, { allowPhaseChange = false } = {}) {
    if (!value || typeof value.revision !== 'string') throw error('result_unknown', 'observe 未返回可校验的 revision。');
    if (value.room && (!value.room.connected || !value.room.seatMatches)) { state = value; throw error('room_disconnected', '联机连接或席位已变化，play 已停止；不要重放已提交动作。', true); }
    if (value.room?.auto || value.room?.controller === 'human') { state = value; throw error('room_control_changed', '此席位当前由托管或人类控制，play 已停止。', true); }
    const epoch = value.revision.split(':', 1)[0];
    if (stateEpoch !== undefined && epoch !== stateEpoch) throw error('session_changed', '对局 epoch 已变化，play 已停止。');
    stateEpoch = epoch;
    state = value;
    if (!allowPhaseChange && planPhaseId !== undefined && value.phaseId !== planPhaseId) throw error('phase_changed', '操作串已离开开始时的阶段，play 已停止。', true);
    return value;
  }
  async function sampleEffects() {
    const value = await call(() => adapter.effects());
    if (!value || value.epoch == null || !Array.isArray(value.actions)) throw error('result_unknown', 'effects 未返回可校验的动作列表。');
    if (effectEpoch !== undefined && value.epoch !== effectEpoch) throw error('session_changed', '结算 epoch 已变化，play 已停止。');
    effectEpoch = value.epoch; effects = value;
    return value;
  }
  async function observeAndSample({ allowPhaseChange = false } = {}) {
    checkState(await call(() => adapter.observe()), { allowPhaseChange });
    await sampleEffects();
    return state;
  }
  async function settleAfterAct(allowPhaseChange = false) {
    if (intervalMs) await call(() => adapter.sleep(intervalMs));
    await observeAndSample({ allowPhaseChange });
  }
  async function poll(allowPhaseChange = false) {
    await call(() => adapter.sleep(Math.min(100, Math.max(1, deadline - Date.now()))));
    await observeAndSample({ allowPhaseChange });
  }
  const choiceKey = value => value?.choice ? JSON.stringify([
    value.choice.decisionId || value.choice.id,
    value.choice.context?.skill ?? null,
    value.choice.context?.actor ?? null,
    value.choice.context?.sourceAction ?? null,
    value.choice.context?.certainty ?? 'unknown',
  ]) : null;
  const trustedChoices = new Set();
  function normalPhaseChoice(value = state) {
    const context = value?.choice?.context;
    return value?.state === 'choice' && value.phase === 'phaseUse' && !!value.phaseId && value.actor === value.me?.id && value.choice?.event === 'chooseToUse' &&
      context?.certainty === 'known' && context.actor === value.me?.id && context.skill == null && context.sourceAction == null;
  }
  async function waitForChoice() {
    while (!state?.choice) {
      if (['dead', 'over'].includes(state?.state)) throw error(state.state, '本局已结束或操控角色已死亡。');
      if (state?.state !== 'running') throw error('not_playing', '当前不在可执行的对局流程中。');
      await poll();
    }
  }
  function optionForRaw(step) {
    const visible = state.choice?.options || [];
    return visible.find(option => option.id === step.request.id) ||
      (['confirm', 'cancel'].includes(step.request.id) ? visible.find(option => option.kind === step.request.id) : null);
  }
  function uncertainActFailure(result) {
    return ['stale_choice', 'action_pending', 'not_choosing', 'choice_changed', 'session_changed', 'result_unknown', 'room_disconnected', 'room_auto', 'human_controlled'].includes(result?.code);
  }
  function cardView(card) {
    return { id: card.id, cardId: card.id, name: card.name, label: card.label, suit: card.suit, number: card.number, ...(card.nature ? { nature: card.nature } : {}) };
  }
  function markFailure(record, code, message) {
    record.status = 'failed'; record.value = 0; record.code = code; record.message = message;
    activeFailure = { code, message };
  }
  function clearFailure() { activeFailure = null; }
  function targetMatches(name) {
    const people = [state.me, ...(state.players || [])].filter(Boolean);
    const byId = people.filter(player => player.id === name);
    const names = createNames({ players: people });
    return byId.length ? byId : people.filter(player => player.name === name || player.label === name || names(player) === name);
  }
  function matchingCards(step) {
    const hand = state.me?.hand || [];
    return hand.filter(card => matchesCard(card, step));
  }
  function pick(candidates) {
    const sample = Number(random());
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw error('invalid_random', 'random 必须返回 [0,1) 内的有限数值。');
    return candidates[Math.floor(sample * candidates.length)];
  }
  async function dispatch(request) {
    activeConsumed = true; actionCount++; anyMutation = true;
    if (actionCount > MAX_STEPS) throw error('step_limit', '底层动作超过安全上限。');
    activeRecord.inFlight = { id: request.id, status: 'not_sent' };
    await saveProgress();
    activeRecord.inFlight.status = 'unknown';
    await saveProgress();
    const result = await call(() => adapter.act({ ...request, at: state.revision, ...(state.interaction ? { interaction: state.interaction } : {}) }), true);
    activeRecord.inFlight = { id: request.id, status: result?.ok ? 'accepted' : uncertainActFailure(result) ? 'unknown' : 'rejected' };
    await saveProgress();
    return result;
  }
  function findReceipt(card, beforeIds, expectedTargets) {
    const candidates = (effects?.actions || []).filter(action => !beforeIds.has(action.id) && action.kind === (card.response ? 'respond' : 'card') && action.actor === state.me?.id &&
      action.name === card.name && action.physicalMode === 'direct' && Array.isArray(action.physicalCards) && action.physicalCards.includes(card.id) &&
      (!transportRequestId || action.confirmation === 'host_accepted' && action.requestId === transportRequestId));
    if (candidates.length > 1) throw error('result_unknown', '同一实体牌出现多个新提交动作，无法唯一绑定。');
    const receipt = candidates[0];
    if (!receipt) return null;
    if (receipt.status === 'unknown') throw error('result_unknown', '本次实体牌提交结果未知。');
    return receipt;
  }
  async function cleanup(selectedIds, card, beforeIds, expectedTargets, record, stillBound) {
    for (const id of [...selectedIds].reverse()) {
      if (!stillBound()) throw error('unexpected_choice', '撤销前出现未绑定的新选择，已停止。', true);
      const option = state.choice?.options?.find(item => item.id === id);
      if (!option?.selected) continue;
      const result = await dispatch({ id, unselect: true });
      if (!result?.ok) {
        if (uncertainActFailure(result)) throw error(result?.code || 'result_unknown', result?.message || '撤销本项选择结果待确认。');
        await settleAfterAct();
        throw error(result?.code || 'cleanup_failed', result?.message || '撤销本项选择失败。', true);
      }
      record.actions.push(result.action || { id, unselect: true });
      await settleAfterAct();
      const receipt = findReceipt(card, beforeIds, expectedTargets);
      if (receipt) return receipt;
    }
    if (selectedIds.some(id => state.choice?.options?.some(option => option.id === id && option.selected))) throw error('cleanup_failed', '本项新增选择未能完整撤销。');
    return null;
  }
  async function performRaw(step) {
    activeRecord = { raw: step.raw, status: 'paused', value: null, actions: [] };
    activeConsumed = false;
    await waitForChoice();
    const option = optionForRaw(step);
    if (!option) {
      // A missing ID is an ordinary rejected raw operation while the current
      // interaction is still one this plan has authenticated.  A newly
      // inserted, unbound question is different: it must stop the whole play
      // and cannot be hidden by a following | group.
      if (anyMutation && !trustedChoices.has(choiceKey(state))) return { type: 'pause', consumed: false, code: 'unexpected_choice', message: '当前出现的选择与下一项原始操作不匹配。', record: activeRecord };
      return { type: 'failure', consumed: true, code: 'option_unavailable', message: '当前选择中没有指定的原始操作。', record: activeRecord };
    }
    if (['confirm', 'cancel'].includes(option.kind) && !trustedChoices.has(choiceKey(state))) {
      return { type: 'pause', consumed: false, code: 'unexpected_choice', message: '通用确认或取消无法绑定到本串已确认的交互。', record: activeRecord };
    }
    const beforeChoice = state.choice, beforeKey = choiceKey(state), beforeContext = beforeChoice.context;
    const beforeActionIds = new Set((effects?.actions || []).map(action => action.id));
    const request = { ...step.request, id: state.interaction && ['confirm', 'cancel'].includes(option.kind) ? option.kind : option.id };
    const result = await dispatch(request);
    if (!result?.ok) {
      if (uncertainActFailure(result)) return { type: 'pause', consumed: true, stateFresh: false, code: result?.code || 'result_unknown', message: result?.message || '原始操作结果待确认。', record: activeRecord };
      const code = result?.code || 'action_rejected', message = result?.message || '游戏拒绝原始操作。';
      // Some page actions can mutate selection before discovering a later
      // rejection (for example a move destination is obscured).  A rejected
      // act is still a bottom-level act: honor the animation interval and
      // refresh revision/effects before a following | group sees the state.
      markFailure(activeRecord, code, message);
      await settleAfterAct();
      return { type: 'failure', consumed: true, code, message, record: activeRecord };
    }
    activeRecord.actions.push(result.action || { id: option.id, kind: option.kind, label: option.label });
    activeRecord.status = 'completed'; activeRecord.value = 1;
    await saveProgress();
    await settleAfterAct(deferCurrentFinal() || step.end && nextCursor(cursor) === null);
    const afterKey = choiceKey(state);
    if (afterKey && beforeChoice.decisionId && state.choice.decisionId === beforeChoice.decisionId && afterKey === choiceKey({ choice: beforeChoice })) trustedChoices.add(afterKey);
    const context = state.choice?.context;
    if (afterKey && trustedChoices.has(beforeKey) && beforeContext?.certainty === 'known' && beforeContext.skill != null && beforeContext.sourceAction != null &&
      context?.certainty === 'known' && context.skill === beforeContext.skill && context.actor === beforeContext.actor && context.sourceAction === beforeContext.sourceAction) trustedChoices.add(afterKey);
    if (afterKey && option.kind === 'skill' && context?.certainty === 'known' && context.actor === state.me?.id && context.skill === (option.contextSkillCanonical || option.skill)) trustedChoices.add(afterKey);
    const fresh = (effects?.actions || []).filter(action => !beforeActionIds.has(action.id) && action.actor === state.me?.id);
    if (afterKey && fresh.length === 1 && context?.certainty === 'known' && context.sourceAction === fresh[0].id) trustedChoices.add(afterKey);
    return { type: 'success', consumed: true, record: activeRecord };
  }
  async function performSelection(step, nested = false) {
    if (!nested) { activeRecord = { raw: step.raw, status: 'paused', value: null, actions: [] }; activeConsumed = false; }
    await waitForChoice();
    const current = state.choice, key = choiceKey(state), decision = current.decisionId;
    const result = (type, code, message) => ({ type, consumed: activeConsumed, code, message, record: activeRecord });
    const origin = output.find(s => s.submission?.actionId && s.submission.actionId === current.context?.sourceAction);
    if (origin && current.context?.skill != null) return result('pause', 'unexpected_choice', '当前是插入的技能询问，不是预写的普通牌选牌。');
    const continuations = { wugu: ['chooseButton'], guohe: ['discardPlayerCard'], shunshou: ['gainPlayerCard'], huogong: ['chooseCard', 'chooseToDiscard'] };
    if (origin && current.context?.actor === state.me?.id && current.context?.certainty === 'known' && continuations[origin.card?.name]?.includes(current.event)) trustedChoices.add(key);
    if (!trustedChoices.has(key) || !decision) return result('pause', 'unexpected_choice', '卡牌对象不属于本串已绑定的询问。');
    const allowed = step.verb === '弃置' ? ['chooseToDiscard'] : step.verb === '展示' ? ['chooseCard'] : ['chooseButton', 'chooseCard', 'chooseToDiscard', 'choosePlayerCard', 'discardPlayerCard', 'gainPlayerCard'];
    if (!allowed.includes(current.event) || step.verb === '展示' && current.context?.sourceCard !== 'huogong') return result('pause', 'unexpected_choice', '当前询问不接受这种选牌动作。');
    const candidates = (current.options || []).filter(o => ['card', 'button'].includes(o.kind) && (o.card || o.visibility === 'hidden'));
    const fixed = [], used = new Set();
    for (const spec of step.objects) {
      const matches = candidates.filter(o => !used.has(o.card?.id || o.id) && matchesCard(o.card || { visibility: o.visibility }, spec));
      if (!matches.length) return result('pause', 'card_unavailable', '当前询问没有匹配的卡牌对象；已有操作不会重放。');
      const option = pick(matches), identity = option.card?.id || option.id;
      fixed.push({ identity, optionId: option.id, card: option.card, spec }); used.add(identity);
    }
    if (current.options.some(o => o.selected && !fixed.some(f => f.optionId === o.id))) return result('pause', 'existing_selection', '当前已有未写入本动作的选择。');
    const range = current.constraints?.[fixed.every(f => candidates.find(o => o.id === f.optionId)?.kind === 'button') ? 'buttons' : 'cards'];
    if (Array.isArray(range) && (fixed.length < range[0] || range[1] >= 0 && fixed.length > range[1])) return result('pause', 'selection_count', '指定牌数不满足当前询问的数量约束。');
    const bound = () => choiceKey(state) === key && state.choice?.decisionId === decision;
    const receipt = () => (effects?.choices || []).find(r => r.decisionId === decision);
    const validReceipt = r => r?.accepted === true && r.cards.length === fixed.length && fixed.every(f => r.cards.includes(f.identity));
    activeRecord.selection = fixed.map(f => f.card ? cardView(f.card) : { id: f.identity, visibility: 'hidden' });
    if (!nested) activeRecord.resolved = step.verb + '<' + fixed.map(f => f.card ? formatCard(f.card) : '暗牌').join(',') + '>';
    for (const fixedCard of fixed) {
      if (receipt()) break;
      if (!bound()) return result('pause', 'unexpected_choice', '选牌中出现新询问，已停止。');
      if (state.choice.options.some(o => o.selected && !used.has(o.card?.id || o.id))) return result('pause', 'existing_selection', '选牌中出现未授权的额外选择。');
      const option = state.choice.options.find(o => (o.card?.id || o.id) === fixedCard.identity && ['card', 'button'].includes(o.kind));
      if (!option || !matchesCard(option.card || { visibility: option.visibility }, fixedCard.spec)) return result('pause', 'card_unavailable', '已固定的卡牌对象不再满足条件。');
      if (option.selected) continue;
      const response = await dispatch({ id: option.id });
      if (!response?.ok) return result('pause', response?.code || 'result_unknown', response?.message || '选牌结果未知。');
      activeRecord.actions.push(response.action || { id: option.id });
      await settleAfterAct(deferCurrentFinal());
    }
    if (!receipt() && bound()) {
      const confirm = state.choice.options.find(o => o.kind === 'confirm');
      if (!confirm) return result('pause', 'confirmation_unavailable', '已选指定牌，但当前没有可用的确认控件。');
      const response = await dispatch({ id: state.interaction ? 'confirm' : confirm.id });
      if (!response?.ok) return result('pause', response?.code || 'result_unknown', response?.message || '确认结果未知。');
      activeRecord.actions.push(response.action || { id: confirm.id });
      await settleAfterAct(deferCurrentFinal());
    }
    while (!receipt() && state.state === 'running') await poll(deferCurrentFinal());
    if (!validReceipt(receipt())) return result('pause', 'selection_unconfirmed', '未取得指定卡牌的选择提交凭证；请观察核实。');
    activeRecord.choiceReceipt = receipt().id;
    if (!nested) { activeRecord.status = 'completed'; activeRecord.value = 1; }
    return result('success');
  }
  async function performEnd(step) {
    activeRecord = { raw: step.raw, status: 'paused', value: null, actions: [] }; activeConsumed = false;
    await waitForChoice();
    if (!normalPhaseChoice() || state.choice.options.some(o => o.selected)) return { type: 'pause', consumed: false, code: 'unexpected_choice', message: '结束出牌需要没有未完成选择的正常出牌阶段。', record: activeRecord };
    const control = state.choice.options.find(o => o.kind === 'cancel' || o.kind === 'control' && ['结束回合', '结束出牌', '结束出牌阶段'].includes(o.label));
    if (!control) return { type: 'pause', consumed: false, code: 'option_unavailable', message: '当前没有结束出牌控件。', record: activeRecord };
    return performRaw({ raw: step.raw, end: true, request: { id: control.kind === 'cancel' ? 'cancel' : control.id } });
  }
  async function performCard(step) {
    activeRecord = { raw: step.raw, status: 'paused', value: null, actions: [] };
    activeConsumed = false;
    await waitForChoice();
    transportRequestId = state.choice?.context?.transportRequestId || null;
    const choiceEvent = state.choice?.event;
    const responseChoice = step.respond ? choiceEvent === 'chooseToRespond' : choiceEvent === 'chooseToUse';
    if (!normalPhaseChoice() && !(responseChoice && trustedChoices.has(choiceKey(state)))) return { type: 'pause', consumed: false, code: 'unexpected_choice', message: '当前询问不接受这类实体牌使用或打出。', record: activeRecord };
    if (step.respond && choiceEvent !== 'chooseToRespond') return { type: 'pause', consumed: false, code: 'unexpected_choice', message: '打出仅用于当前要求打出牌的询问。', record: activeRecord };
    if ((state.choice.options || []).some(option => option.selected)) return { type: 'pause', consumed: false, code: 'existing_selection', message: '进入完整用牌前已有未完成选择。', record: activeRecord };
    const matches = matchingCards(step).filter(card => state.choice.options.some(o => o.kind === 'card' && o.card?.id === card.id));
    if (!matches.length) return { type: 'failure', consumed: true, code: 'card_unavailable', message: '当前自己手牌没有匹配的实体牌。', record: activeRecord };
    const card = { ...pick(matches), ...(step.respond ? { response: true } : {}) };
    if (step.objectTarget && !['guohe', 'shunshou'].includes(card.name)) return { type: 'failure', consumed: true, code: 'unsupported_object_action', message: '嵌套卡牌对象目前用于过河拆桥和顺手牵羊。', record: activeRecord };
    activeRecord.card = cardView(card);
    activeRecord.resolved = (step.respond ? '打出' : '') + formatCard(card);
    const option = state.choice.options.find(item => item.kind === 'card' && item.card?.id === card.id);
    if (!option) return { type: 'failure', consumed: true, code: 'card_unselectable', message: '匹配的实体牌当前不可选。', record: activeRecord };
    const phaseId = state.phaseId, decisionId = state.choice.decisionId, boundKey = choiceKey(state);
    if (!decisionId) throw error('result_unknown', '当前选择缺少 decisionId，无法安全绑定完整用牌。');
    const beforeIds = new Set((effects?.actions || []).map(action => action.id));
    const selectedIds = [], expectedTargets = [];
    const boundChoice = () => choiceKey(state) === boundKey && state.choice?.decisionId === decisionId && state.phaseId === phaseId && state.choice.event === choiceEvent;
    const requireBoundChoice = () => {
      if (!boundChoice()) throw error('unexpected_choice', '完整用牌过程中出现未绑定的新选择。', true);
    };
    async function actAndSettle(request, selectedId) {
      const result = await dispatch(request);
      if (!result?.ok) return result;
      recordAction(result.action || { id: request.id });
      if (selectedId) selectedIds.push(selectedId);
      await saveProgress();
      await settleAfterAct(deferCurrentFinal());
      return result;
    }
    const recordAction = action => activeRecord.actions.push(action);
    async function waitForCardBoundary() {
      let found = findReceipt(card, beforeIds, expectedTargets);
      while (!found && state.state === 'running') { await poll(deferCurrentFinal()); found = findReceipt(card, beforeIds, expectedTargets); }
      return found;
    }
    let result = await actAndSettle({ id: option.id }, option.id);
    if (!result?.ok) {
      if (uncertainActFailure(result)) return { type: 'pause', consumed: true, stateFresh: false, code: result?.code || 'result_unknown', message: result?.message || '选牌结果待确认。', record: activeRecord };
      const code = result?.code || 'action_rejected', message = result?.message || '游戏拒绝选牌。';
      markFailure(activeRecord, code, message);
      await settleAfterAct();
      let rejectedReceipt = findReceipt(card, beforeIds, expectedTargets);
      if (rejectedReceipt) throw error('result_unknown', '游戏报告选牌失败，但观察到该实体牌已提交。');
      const stillSelected = state.choice?.options?.some(item => item.id === option.id && item.selected);
      if (stillSelected && !boundChoice()) throw error('unexpected_choice', '选牌失败后出现未绑定选择，无法安全清理。', true);
      if (stillSelected) rejectedReceipt = await cleanup([option.id], card, beforeIds, expectedTargets, activeRecord, boundChoice);
      if (rejectedReceipt) throw error('result_unknown', '游戏报告选牌失败，但清理时观察到该实体牌已提交。');
      return { type: 'failure', consumed: true, code, message, record: activeRecord };
    }
    let receipt = await waitForCardBoundary();
    if (!receipt && state.phaseId !== phaseId) throw error('result_unknown', '出牌阶段在提交凭证出现前已变化。');
    if (!receipt && state.choice) requireBoundChoice();

    let targetNames = step.targets.slice(), followup = null;
    if (!receipt && (step.randomTarget || step.objectTarget)) {
      requireBoundChoice();
      const spec = step.objectTarget;
      if (spec && !['guohe', 'shunshou'].includes(card.name)) throw error('unsupported_object_action', '嵌套卡牌对象目前用于过河拆桥和顺手牵羊。', true);
      let people = spec?.target ? targetMatches(spec.target) : [state.me, ...(state.players || [])];
      if (spec?.target && people.length !== 1) throw error(people.length ? 'ambiguous_target' : 'target_unavailable', '指定角色无法唯一匹配。', true);
      const candidates = [];
      for (const player of people) {
        if (!state.choice.options.some(o => o.kind === 'target' && o.player === player.id && !o.selected)) continue;
        if (!spec) { candidates.push({ player }); continue; }
        if (spec.objects.length !== 1) throw error('invalid_play', '过拆和顺手每个目标只能预选一张牌。', true);
        const object = spec.objects[0];
        if (object.any) { candidates.push({ player, object }); continue; }
        for (const targetCard of [...(player.equipment || []), ...(player.judgments || []), ...(player.hand || [])]) {
          if (targetCard.objectActions?.[card.name === 'guohe' ? 'discard' : 'gain'] !== false && matchesCard(targetCard, object)) candidates.push({ player, object: { ...object, face: { ...object.face, id: targetCard.id } }, card: targetCard });
        }
      }
      if (!candidates.length) {
        const code = 'target_unavailable', message = '没有满足角色与卡牌条件的合法目标。';
        markFailure(activeRecord, code, message);
        const submitted = await cleanup(selectedIds, card, beforeIds, expectedTargets, activeRecord, boundChoice);
        if (submitted) throw error('result_unknown', '清理期间发现用牌已提交。');
        return { type: 'failure', consumed: true, code, message, record: activeRecord };
      }
      const fixed = pick(candidates);
      targetNames = [fixed.player.id];
      if (spec) followup = { owner: fixed.player.id, objects: [fixed.object], card: fixed.card };
    }
    for (const targetName of targetNames) {
      if (receipt) throw error('result_unknown', '实体牌在全部目标选完前已提交。');
      const people = targetMatches(targetName);
      if (people.length !== 1) {
        const code = people.length ? 'ambiguous_target' : 'target_unavailable';
        const message = people.length ? `目标 ${targetName} 匹配多个角色。` : `目标 ${targetName} 不存在。`;
        markFailure(activeRecord, code, message);
        receipt = await cleanup(selectedIds, card, beforeIds, expectedTargets, activeRecord, boundChoice);
        if (receipt) { clearFailure(); break; }
        return { type: 'failure', consumed: true, code, message, record: activeRecord };
      }
      const player = people[0];
      requireBoundChoice();
      const targetOption = state.choice?.options?.find(item => item.kind === 'target' && item.player === player.id);
      if (!targetOption) {
        const code = 'target_unselectable', message = `目标 ${targetName} 当前不可选。`;
        markFailure(activeRecord, code, message);
        receipt = await cleanup(selectedIds, card, beforeIds, expectedTargets, activeRecord, boundChoice);
        if (receipt) { clearFailure(); break; }
        return { type: 'failure', consumed: true, code, message, record: activeRecord };
      }
      expectedTargets.push(player.id);
      activeRecord.targets = expectedTargets.slice();
      const peopleNames = createNames({ players: [state.me, ...(state.players || [])] });
      activeRecord.resolved = (step.respond ? '打出' : '') + formatCard(card) + '[' + expectedTargets.map(id => peopleNames([state.me, ...state.players].find(p => p.id === id))).join(',') + (followup ? `<${followup.card ? formatCard(followup.card) : '任意'}>` : '') + ']';
      result = await actAndSettle({ id: targetOption.id }, targetOption.id);
      if (!result?.ok) {
        if (uncertainActFailure(result)) return { type: 'pause', consumed: true, stateFresh: false, code: result?.code || 'result_unknown', message: result?.message || '选目标结果待确认。', record: activeRecord };
        const code = result?.code || 'action_rejected', message = result?.message || '游戏拒绝目标。';
        markFailure(activeRecord, code, message);
        await settleAfterAct();
        if (boundChoice() && state.choice?.options?.some(item => item.id === targetOption.id && item.selected) && !selectedIds.includes(targetOption.id)) selectedIds.push(targetOption.id);
        receipt = await cleanup(selectedIds, card, beforeIds, expectedTargets.slice(0, -1), activeRecord, boundChoice);
        if (receipt) { clearFailure(); break; }
        return { type: 'failure', consumed: true, code, message, record: activeRecord };
      }
      receipt = await waitForCardBoundary();
      if (!receipt && state.phaseId !== phaseId) throw error('result_unknown', '出牌阶段在提交凭证出现前已变化。');
      if (!receipt && state.choice) requireBoundChoice();
    }

    if (!receipt) {
      requireBoundChoice();
      const confirm = state.choice?.options?.find(item => item.kind === 'confirm');
      if (confirm) {
        result = await actAndSettle({ id: state.interaction ? 'confirm' : confirm.id });
        if (!result?.ok) {
          if (uncertainActFailure(result)) return { type: 'pause', consumed: true, stateFresh: false, code: result?.code || 'result_unknown', message: result?.message || '确认结果待核实。', record: activeRecord };
          const code = result?.code || 'action_rejected', message = result?.message || '游戏拒绝确认用牌。';
          markFailure(activeRecord, code, message);
          await settleAfterAct();
          receipt = await cleanup(selectedIds, card, beforeIds, expectedTargets, activeRecord, boundChoice);
          if (receipt) clearFailure();
          else return { type: 'failure', consumed: true, code, message, record: activeRecord };
        }
        receipt ||= await waitForCardBoundary();
      }
    }
    while (!receipt && state.state === 'running') { await poll(deferCurrentFinal()); receipt = findReceipt(card, beforeIds, expectedTargets); }
    if (!receipt) {
      const needsTarget = (state.choice?.options || []).some(item => item.kind === 'target' && !item.selected);
      return { type: 'pause', consumed: true, code: needsTarget ? 'target_required' : 'selection_required', message: needsTarget ? '此牌仍需要明确目标；play 不会随机选择。' : '此牌仍有未写明的补充选择。', record: activeRecord };
    }
    activeRecord.receipt = receipt.id;
    activeRecord.submission = { actionId: receipt.id, targets: Array.isArray(receipt.targets) ? receipt.targets.slice() : [], ...(receipt.confirmation ? { confirmation: receipt.confirmation } : {}) };
    if (followup) {
      activeRecord.followup = { status: 'pending', owner: followup.owner };
      await saveProgress();
      while (!state.choice && state.state === 'running') await poll();
      // The native engine may resolve a forced singleton without opening a UI.
      // Require the same causal action/owner and actual chosen entity, never a
      // disappearance inferred from the board or a similarly worded log line.
      const automatic = (effects?.objectChoices || []).find(r => r.sourceAction === receipt.id && r.owner === followup.owner && r.skill == null &&
        r.event === (card.name === 'guohe' ? 'discardPlayerCard' : 'gainPlayerCard') && r.accepted === true && r.count === 1 &&
        (followup.objects[0].any || r.cards.includes(followup.objects[0].face?.id)));
      if (automatic) {
        activeRecord.followup = { ...activeRecord.followup, status: 'completed', receipt: automatic.id };
        activeRecord.status = 'completed'; activeRecord.value = 1;
        return { type: 'success', consumed: true, record: activeRecord };
      }
      const context = state.choice?.context;
      const expectedEvent = card.name === 'guohe' ? 'discardPlayerCard' : 'gainPlayerCard';
      if (!state.choice || context?.sourceAction !== receipt.id || context.skill != null || state.choice.objectOwner !== followup.owner || state.choice.event !== expectedEvent) {
        return { type: 'pause', consumed: true, code: 'followup_unavailable', message: '用牌已提交，指定后续选牌尚未完成；请阅读日志和当前询问。', record: activeRecord };
      }
      trustedChoices.add(choiceKey(state));
      const selected = await performSelection({ raw: step.raw, kind: 'select', verb: '选择', objects: followup.objects }, true);
      if (selected.type !== 'success') return selected;
      activeRecord.followup.status = 'completed';
    }
    activeRecord.status = 'completed'; activeRecord.value = 1;
    const key = choiceKey(state), context = state.choice?.context;
    if (key && context?.certainty === 'known' && context.actor === state.me?.id && context.sourceAction === receipt.id) trustedChoices.add(key);
    return { type: 'success', consumed: true, record: activeRecord };
  }

  return (async () => {
    try {
      checkState(await call(() => adapter.observe()));
      if (!options.at || options.at !== state.revision) return base({ status: 'failed', value: 0, code: 'stale_choice', message: '提供 observe 返回的当前 revision。', remaining: plan.source });
      planPhaseId = state.phaseId;
      await sampleEffects();
      if (choiceKey(state)) trustedChoices.add(choiceKey(state));

      for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex++) {
        const group = plan.groups[groupIndex];
        let failed = false;
        for (let stepIndex = 0; stepIndex < group.length; stepIndex++) {
          cursor = { group: groupIndex, step: stepIndex };
          const step = group[stepIndex];
          if (failed) {
            output.push({ raw: step.raw, status: 'skipped', value: null, code: 'dependency_failed', message: '同组前一步失败。' });
            continue;
          }
          activeRecord = null; activeConsumed = false; activeFailure = null;
          const outcome = step.kind === 'act' ? await performRaw(step) : step.kind === 'select' ? await performSelection(step) : step.kind === 'end' ? await performEnd(step) : await performCard(step);
          activeConsumed = outcome.consumed;
          await saveProgress();
          if (outcome.type === 'success') { output.push(outcome.record); continue; }
          if (outcome.type === 'failure') {
            outcome.record.status = 'failed'; outcome.record.value = 0; outcome.record.code = outcome.code; outcome.record.message = outcome.message;
            output.push(outcome.record); hadFailure = true; failed = true; continue;
          }
          outcome.record.status = 'paused'; outcome.record.value = null; outcome.record.code = outcome.code; outcome.record.message = outcome.message;
          output.push(outcome.record);
          return base({ code: outcome.code, message: outcome.message, stateFresh: outcome.stateFresh ?? true, remaining: remainingFrom(outcome.consumed ? nextCursor(cursor) : cursor) });
        }
      }

      if (options.deferFinalWait === true) {
        return { kind: 'play', ok: !hadFailure, status: hadFailure ? 'failed' : 'completed', value: hadFailure ? 0 : 1, steps: output, state, stateFresh: true, remaining: '' };
      }
      const endedPhase = plan.groups.at(-1)?.at(-1)?.kind === 'end';
      while (state?.state === 'running') await poll(endedPhase);
      if (state?.choice) {
        const cleanNormal = normalPhaseChoice() && !(state.choice.options || []).some(option => option.selected);
        if (!cleanNormal && !endedPhase) return base({ code: 'unexpected_choice', message: '操作串结束后仍有未写明的选择。', remaining: '' });
      }
      return { kind: 'play', ok: !hadFailure, status: hadFailure ? 'failed' : 'completed', value: hadFailure ? 0 : 1, steps: output, state, stateFresh: true, remaining: '' };
    } catch (caught) {
      const code = caught?.code || 'result_unknown';
      const message = caught?.code ? caught.message : '连接或适配器异常，操作结果待核实；不会自动重放。';
      if (activeRecord && !output.includes(activeRecord)) {
        // A raw act is complete once the adapter confirms acceptance.  A later
        // animation wait may exhaust the plan deadline, but must not erase that
        // accepted step.  Card wrappers stay paused until an entity receipt is
        // observed.
        if (activeRecord.status !== 'completed' && !activeFailure) { activeRecord.code = code; activeRecord.message = message; }
        output.push(activeRecord);
      }
      if (activeFailure) {
        const group = plan.groups[cursor.group];
        for (let index = cursor.step + 1; index < group.length; index++) output.push({ raw: group[index].raw, status: 'skipped', value: null, code: 'dependency_failed', message: '同组前一步失败。' });
        hadFailure = true;
      }
      return base({ code, message, stateFresh: caught?.stateFresh === true, remaining: remainingFrom(activeFailure ? nextGroupCursor(cursor) : activeConsumed ? nextCursor(cursor) : cursor) });
    }
  })();
}

module.exports = { parsePlay, executePlay };
