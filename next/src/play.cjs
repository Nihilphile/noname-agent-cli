'use strict';

// A deliberately small finite language.  It never evaluates JavaScript and
// leaves all legality decisions to the game's current visible choice.
const MAX_TEXT = 65536;
const MAX_STEPS = 256;
const ALIASES = new Map([
  ['无中', 'wuzhong'],
  ['顺', 'shunshou'],
  ['杀', 'sha'],
  ['诸葛连弩', 'zhuge'],
]);
const SUITS = new Map([
  ['♠', 'spade'], ['黑桃', 'spade'], ['spade', 'spade'],
  ['♥', 'heart'], ['红桃', 'heart'], ['heart', 'heart'],
  ['♣', 'club'], ['梅花', 'club'], ['club', 'club'],
  ['♦', 'diamond'], ['方片', 'diamond'], ['diamond', 'diamond'],
]);
const NUMBERS = new Map([['A', 1], ['J', 11], ['Q', 12], ['K', 13]]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invalid(message) {
  const error = new Error(message);
  error.code = 'invalid_play';
  return error;
}

function splitExpression(text) {
  const tokens = [], operators = [];
  let start = 0, round = 0, square = 0, face = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') round++;
    else if (char === ')') { if (!round) throw invalid('操作串括号不匹配。'); round--; }
    else if (char === '[') square++;
    else if (char === ']') { if (!square) throw invalid('目标方括号不匹配。'); square--; }
    else if (char === '【') face++;
    else if (char === '】') { if (!face) throw invalid('牌面括号不匹配。'); face--; }
    else if (!round && !square && !face && (char === '>' || char === '|')) {
      const token = text.slice(start, index).trim();
      if (!token) throw invalid('连接符两侧都需要操作。');
      tokens.push(token); operators.push(char); start = index + 1;
    }
  }
  if (round || square || face) throw invalid('操作串括号不匹配。');
  const last = text.slice(start).trim();
  if (!last) throw invalid('操作串不能以连接符结束。');
  tokens.push(last);
  return { tokens, operators };
}

function parseRaw(raw) {
  const match = /^act\(([^)]*)\)(?:\s+(.*))?$/.exec(raw);
  if (!match) return null;
  const words = `${match[1]} ${match[2] || ''}`.trim().split(/\s+/).filter(Boolean);
  const id = words.shift();
  if (!id || /[()\[\]【】>|]/.test(id)) throw invalid(`原始操作缺少有效 ID：${raw}`);
  const request = { id };
  while (words.length) {
    const flag = words.shift();
    if (flag === '--unselect') {
      if (own(request, 'unselect')) throw invalid(`重复参数 --unselect：${raw}`);
      request.unselect = true;
    } else if (flag === '--value' || flag === '--to') {
      const key = flag === '--value' ? 'value' : 'to';
      if (own(request, key) || !words.length || words[0].startsWith('--')) throw invalid(`${flag} 需要一个值：${raw}`);
      request[key] = words.shift();
    } else throw invalid(`不支持的原始操作参数 ${flag}。`);
  }
  return { kind: 'act', raw, request };
}

function parseFace(value, raw) {
  const input = value.trim();
  if (!input) return null;
  let suit = null, rest = input;
  for (const key of [...SUITS.keys()].sort((a, b) => b.length - a.length)) {
    if (rest.toLowerCase().startsWith(key.toLowerCase())) {
      suit = SUITS.get(key); rest = rest.slice(key.length).trim(); break;
    }
  }
  let number = null;
  if (rest) {
    const upper = rest.toUpperCase();
    number = NUMBERS.get(upper) ?? (/^(?:[1-9]|1[0-3])$/.test(rest) ? Number(rest) : null);
    if (number === null) throw invalid(`牌面点数无效：${raw}`);
  }
  if (!suit && number === null) throw invalid(`牌面条件无效：${raw}`);
  return { ...(suit ? { suit } : {}), ...(number !== null ? { number } : {}) };
}

function parseCard(raw) {
  const match = /^([^\[【\]]+?)(?:【([^】]*)】)?(?:\[([^\]]*)\])?$/.exec(raw);
  if (!match) throw invalid(`无法解析用牌操作：${raw}`);
  const selector = match[1].trim();
  if (!selector || /[(){};|>]/.test(selector)) throw invalid(`牌名或实体 ID 无效：${raw}`);
  const targets = match[3] == null || !match[3].trim() ? [] : match[3].split(/[,，]/).map(value => value.trim());
  if (targets.some(value => !value || /[\[\]【】(){};|>]/.test(value))) throw invalid(`目标列表无效：${raw}`);
  return { kind: 'card', raw, selector, name: ALIASES.get(selector) || selector, face: match[2] == null ? null : parseFace(match[2], raw), targets };
}

function parsePlay(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw invalid('play 需要非空且不超过 64 KiB 的文本。');
  const { tokens, operators } = splitExpression(text.trim());
  if (tokens.length > MAX_STEPS) throw invalid(`play 最多包含 ${MAX_STEPS} 项操作。`);
  const groups = [[]];
  for (let index = 0; index < tokens.length; index++) {
    const step = parseRaw(tokens[index]) || parseCard(tokens[index]);
    groups.at(-1).push(step);
    if (operators[index] === '|') groups.push([]);
  }
  return { kind: 'play-plan', source: text.trim(), groups };
}

function validatePlan(plan) {
  if (!plan || plan.kind !== 'play-plan' || !Array.isArray(plan.groups) || !plan.groups.length) throw invalid('需要 parsePlay 返回的计划。');
  let count = 0;
  for (const group of plan.groups) {
    if (!Array.isArray(group) || !group.length) throw invalid('每个 | 分组都必须包含操作。');
    for (const step of group) {
      if (!step || !['act', 'card'].includes(step.kind) || typeof step.raw !== 'string') throw invalid('计划步骤无效。');
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
    return { id: card.id, cardId: card.id, name: card.name, label: card.label, suit: card.suit, number: card.number };
  }
  function markFailure(record, code, message) {
    record.status = 'failed'; record.value = 0; record.code = code; record.message = message;
    activeFailure = { code, message };
  }
  function clearFailure() { activeFailure = null; }
  function targetMatches(name) {
    const people = [state.me, ...(state.players || [])].filter(Boolean);
    const byId = people.filter(player => player.id === name);
    return byId.length ? byId : people.filter(player => player.name === name || player.label === name);
  }
  function matchingCards(step) {
    const hand = state.me?.hand || [];
    let matches = hand.filter(card => card.id === step.selector);
    if (!matches.length) matches = hand.filter(card => card.name === step.name || card.label === step.selector);
    if (step.face) matches = matches.filter(card => (!step.face.suit || card.suit === step.face.suit) && (step.face.number == null || card.number === step.face.number));
    return matches;
  }
  function findReceipt(card, beforeIds, expectedTargets) {
    const candidates = (effects?.actions || []).filter(action => !beforeIds.has(action.id) && action.kind === 'card' && action.actor === state.me?.id &&
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
      activeConsumed = true; actionCount++; anyMutation = true;
      if (actionCount > MAX_STEPS) throw error('step_limit', '底层动作超过安全上限。');
      const result = await call(() => adapter.act({ id, at: state.revision, unselect: true }), true);
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
    const request = { ...step.request, id: option.id, at: state.revision };
    activeConsumed = true; actionCount++; anyMutation = true;
    if (actionCount > MAX_STEPS) throw error('step_limit', '底层动作超过安全上限。');
    const result = await call(() => adapter.act(request), true);
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
    await settleAfterAct(deferCurrentFinal());
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
  async function performCard(step) {
    activeRecord = { raw: step.raw, status: 'paused', value: null, actions: [] };
    activeConsumed = false;
    await waitForChoice();
    transportRequestId = state.choice?.context?.transportRequestId || null;
    if (!normalPhaseChoice()) return { type: 'pause', consumed: false, code: 'unexpected_choice', message: '完整用牌仅能从自己的正常出牌阶段选择开始。', record: activeRecord };
    if ((state.choice.options || []).some(option => option.selected)) return { type: 'pause', consumed: false, code: 'existing_selection', message: '进入完整用牌前已有未完成选择。', record: activeRecord };
    const matches = matchingCards(step);
    if (!matches.length) return { type: 'failure', consumed: true, code: 'card_unavailable', message: '当前自己手牌没有匹配的实体牌。', record: activeRecord };
    const sample = Number(random());
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw error('invalid_random', 'random 必须返回 [0,1) 内的有限数值。');
    const card = matches[Math.floor(sample * matches.length)];
    activeRecord.card = cardView(card);
    const option = state.choice.options.find(item => item.kind === 'card' && item.card?.id === card.id);
    if (!option) return { type: 'failure', consumed: true, code: 'card_unselectable', message: '匹配的实体牌当前不可选。', record: activeRecord };
    const phaseId = state.phaseId, decisionId = state.choice.decisionId, boundKey = choiceKey(state);
    if (!decisionId) throw error('result_unknown', '当前选择缺少 decisionId，无法安全绑定完整用牌。');
    const beforeIds = new Set((effects?.actions || []).map(action => action.id));
    const selectedIds = [], expectedTargets = [];
    const boundChoice = () => choiceKey(state) === boundKey && state.choice?.decisionId === decisionId && state.phaseId === phaseId && state.choice.event === 'chooseToUse';
    const requireBoundChoice = () => {
      if (!boundChoice()) throw error('unexpected_choice', '完整用牌过程中出现未绑定的新选择。', true);
    };
    async function actAndSettle(request, selectedId) {
      activeConsumed = true; actionCount++; anyMutation = true;
      if (actionCount > MAX_STEPS) throw error('step_limit', '底层动作超过安全上限。');
      const result = await call(() => adapter.act({ ...request, at: state.revision }), true);
      if (!result?.ok) return result;
      recordAction(result.action || { id: request.id });
      if (selectedId) selectedIds.push(selectedId);
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

    for (const targetName of step.targets) {
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
        result = await actAndSettle({ id: confirm.id });
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
          const outcome = step.kind === 'act' ? await performRaw(step) : await performCard(step);
          activeConsumed = outcome.consumed;
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
      while (state?.state === 'running') await poll();
      if (state?.choice) {
        const cleanNormal = normalPhaseChoice() && !(state.choice.options || []).some(option => option.selected);
        if (!cleanNormal) return base({ code: 'unexpected_choice', message: '操作串结束后仍有未写明的选择。', remaining: '' });
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
