'use strict';

// A finite instruction list, never JavaScript. The browser remains responsible
// for legality; this layer only resolves visible options and preserves scope.
const MAX_NODES = 256, MAX_DEPTH = 8, MAX_TEXT = 65536;
const EFFECTS = new Set(['damage', 'loseHp', 'recover', 'draw', 'gain', 'discard', 'lose', 'move', 'armor', 'mark', 'dying', 'death']);
const OPS = new Set(['>', '>=', '==', '!=', '<', '<=']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const exact = (value, keys) => Object.keys(value).every(key => keys.includes(key));
function invalid(message, path = 'steps') { const error = new Error(`${path}: ${message}`); error.code = 'invalid_plan'; return error; }

function parsePlan(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_TEXT) throw invalid('需要非空且不超过 64 KiB 的文本。');
  let plan;
  if (/^\s*[\[{]/.test(input)) {
    try { plan = JSON.parse(input); } catch { throw invalid('JSON 格式无效。'); }
  } else {
    plan = { steps: input.split('>').map((part, index) => {
      const token = part.trim();
      if (!token || /[\s;|{}()[\]]/.test(token)) throw invalid('使用 > 分隔单个选项；复杂参数请使用 JSON。', `steps[${index}]`);
      const scoped = /^([^:]+):(confirm|cancel)$/.exec(token);
      return scoped && scoped[1] !== 'skill' ? { select: scoped[2], inSkill: scoped[1] } : { select: token };
    }) };
  }
  validatePlan(plan);
  return plan;
}

function validatePlan(plan) {
  if (!object(plan) || !exact(plan, ['steps'])) throw invalid('顶层必须是 {steps:[...]}。');
  let count = 0;
  function list(steps, path, depth) {
    if (!Array.isArray(steps) || (depth === 0 && !steps.length)) throw invalid('需要步骤数组。', path);
    if (depth > MAX_DEPTH) throw invalid('分支嵌套最多 8 层。', path);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i], here = `${path}[${i}]`;
      if (++count > MAX_NODES) throw invalid('全部分支合计最多 256 步。', here);
      if (!object(step)) throw invalid('步骤必须是对象。', here);
      if (own(step, 'if')) {
        if (!exact(step, ['if', 'then', 'else'])) throw invalid('条件步骤仅支持 if/then/else。', here);
        const condition = step.if;
        if (!object(condition) || !exact(condition, ['action', 'effect', 'target', 'op', 'value']) || condition.action !== 'lastCard' || !EFFECTS.has(condition.effect) || !OPS.has(condition.op) || !Number.isFinite(condition.value) || condition.value < 0 || (own(condition, 'target') && !nonempty(condition.target))) throw invalid('条件需要 lastCard、支持的 effect/op、非负数 value，以及可选 target。', here);
        list(step.then, `${here}.then`, depth + 1);
        if (own(step, 'else')) list(step.else, `${here}.else`, depth + 1);
      } else {
        if (!exact(step, ['select', 'inSkill', 'blind', 'value', 'unselect', 'to'])) throw invalid('不支持的动作字段。', here);
        if (own(step, 'inSkill') && !nonempty(step.inSkill)) throw invalid('inSkill 必须是技能 ID 或明确译名。', here);
        if (own(step, 'blind')) {
          if (!Number.isInteger(step.blind) || step.blind < 1 || !nonempty(step.inSkill) || own(step, 'select')) throw invalid('blind 必须为从 1 开始的位置，并指定 inSkill，不与 select 共用。', here);
        } else if (!nonempty(step.select)) throw invalid('缺少 select。', here);
        if (own(step, 'value') && !(['string', 'number'].includes(typeof step.value)) || typeof step.value === 'number' && !Number.isFinite(step.value)) throw invalid('value 必须是有限数值或字符串。', here);
        if (own(step, 'unselect') && typeof step.unselect !== 'boolean') throw invalid('unselect 必须是布尔值。', here);
        if (own(step, 'to') && !nonempty(step.to)) throw invalid('to 必须是选项 ID。', here);
      }
    }
  }
  list(plan.steps, 'steps', 0);
  return plan;
}

const compare = (a, op, b) => ({ '>': a > b, '>=': a >= b, '==': a === b, '!=': a !== b, '<': a < b, '<=': a <= b })[op];
function conditionValue(action, condition) {
  if (action.status !== 'completed') return null;
  const matches = (action.effects || []).filter(effect => effect.kind === condition.effect && (!condition.target || effect.target === condition.target));
  const occurrence = ['dying', 'death'].includes(condition.effect);
  const certain = matches.filter(effect => effect.visibility !== 'hidden' && effect.visibility !== 'unknown' && effect.certainty !== 'unknown' && (Number.isFinite(effect.amount) || occurrence && effect.amount == null));
  const amount = certain.reduce((sum, effect) => sum + (effect.amount ?? 1), 0);
  if ((action.coverage === 'complete' || action.effectCompleteness?.[condition.effect] === true) && matches.length === certain.length) return { value: compare(amount, condition.op, condition.value), amount };
  // With incomplete coverage, a nonnegative lower bound can prove > or >=,
  // but cannot prove absence, equality, or a negative branch.
  const nonnegative = certain.every(effect => (effect.amount ?? 1) >= 0);
  if (nonnegative && ['damage', 'loseHp', 'recover', 'draw', 'gain', 'discard', 'lose', 'dying', 'death'].includes(condition.effect) && ['>', '>='].includes(condition.op) && compare(amount, condition.op, condition.value)) return { value: true, amount, lowerBound: true };
  return null;
}

async function executePlan(plan, adapter, options = {}) {
  const completed = [], branches = [];
  let state = null, current = null, attempted = 0, initialChoice = null, trustedChoice = null;
  let selectedSkill = null, selectedRawSkill = null, selectedSource = null, sourceBound = false;
  let epoch, lastCard = null, effectsSnapshot, sent = 0;
  const seen = new Set();
  const timeoutMs = options.timeoutMs ?? 10000, maxSteps = options.maxSteps ?? 128;
  const fail = (code, message, extra = {}) => ({ ok: false, code, message, completed, branches, stoppedAt: current, state, ...extra });
  try { validatePlan(plan); } catch (error) { return fail('invalid_plan', error.message); }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_NODES) return fail('invalid_plan', 'timeoutMs 范围 1..60000，maxSteps 范围 1..256。');
  const deadline = Date.now() + timeoutMs;
  // Even a malfunctioning transport cannot keep a finite plan alive forever.
  // A timed-out mutation is *uncertain*, and is never automatically replayed.
  async function call(fn, mutation = false) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('计划达到总时限。'), { code: 'timeout' });
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(mutation ? '操作提交后未能确认结果；请观察，勿直接重放。' : '计划达到总时限。'), { code: mutation ? 'result_unknown' : 'timeout' })), remaining); })]);
    } finally { clearTimeout(timer); }
  }
  async function pause() { await call(() => adapter.sleep(Math.min(100, Math.max(1, deadline - Date.now())))); }
  async function sampleEffects(baseline = false) {
    const value = await call(() => adapter.effects());
    if (!value || !Array.isArray(value.actions) || value.epoch == null) throw Object.assign(new Error('结算结果接口不可用。'), { code: 'result_unknown' });
    if (epoch !== undefined && value.epoch !== epoch) throw Object.assign(new Error('对局已更换，不能沿用本次计划的动作归属。'), { code: 'session_changed' });
    epoch = value.epoch; effectsSnapshot = value;
    const fresh = value.actions.filter(action => !seen.has(action.id));
    for (const action of value.actions) seen.add(action.id);
    if (!baseline && sent) {
      const mine = fresh.filter(action => action.kind === 'card' && state?.me?.id && action.actor === state.me.id);
      if (mine.length > 1) throw Object.assign(new Error('同一观察间隔出现多次自身用牌，无法唯一绑定 lastCard。'), { code: 'result_unknown' });
      if (mine.length === 1) {
        lastCard = mine[0].id;
        selectedSource = lastCard; sourceBound = true;
      }
    }
    return value;
  }
  const dead = () => ['dead', 'over'].includes(state?.state);
  const knownContext = () => state?.choice?.context?.certainty === 'known';
  const choiceKey = () => {
    const ch = state?.choice, context = ch?.context;
    return ch?.id ? JSON.stringify([ch.decisionId || ch.id, context?.skill ?? null, context?.actor ?? null, context?.sourceAction ?? null, context?.certainty ?? 'unknown']) : null;
  };
  function scopeMatches(name) {
    const context = state.choice?.context;
    if (!context || context.certainty !== 'known') return false;
    if (context.skill === name) return true;
    // A raw subskill alias is usable only after this plan selected that exact
    // visible button. Do not globally infer aliases for unrelated prompts.
    if (selectedRawSkill === name && selectedSkill === context.skill && context.actor === state.me?.id) return true;
    // A translated name is accepted only when the producer supplies a unique
    // translation. Ambiguous labels must not be treated as stable identifiers.
    return context.skillLabel === name && context.skillLabelUnique === true;
  }
  function trusted() {
    const choice = state.choice;
    if (!choice.id) return false;
    const key = choiceKey();
    if (key === trustedChoice || key === initialChoice) return true;
    if (selectedSkill && knownContext() && choice.context.skill === selectedSkill && choice.context.actor === state.me?.id) {
      if (!bindSource()) return false;
      trustedChoice = key;
      return true;
    }
    return false;
  }
  function bindSource() {
    const source = state.choice.context.sourceAction ?? null;
    if (sourceBound) return source === selectedSource;
    selectedSource = source; sourceBound = true;
    return true;
  }
  async function ready() {
    while (!state?.choice) {
      if (dead()) return fail(state.state, '本局已结束或操控角色已死亡。');
      if (state?.state !== 'running') return fail('not_playing', '当前不在可执行的对局流程中。');
      await pause(); state = await call(() => adapter.observe()); await sampleEffects();
    }
    return dead() ? fail(state.state, '本局已结束或操控角色已死亡。') : null;
  }
  async function run(steps, prefix) {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]; current = `${prefix}[${index}]`;
      if (++attempted > maxSteps) return fail('step_limit', '计划达到最大执行步数。');
      if (Date.now() >= deadline) return fail('timeout', '计划达到总时限。');
      if (dead()) return fail(state.state, '本局已结束或操控角色已死亡。');
      if (own(step, 'if')) {
        if (!sent) return fail('result_unknown', '本计划尚未提交动作，不能引用此前用牌作为 lastCard。');
        await sampleEffects();
        let bound = lastCard;
        let action;
        for (;;) {
          if (bound) action = effectsSnapshot.actions.find(item => item.id === bound);
          if (action?.status === 'completed') break;
          if (action?.status === 'unknown') return fail('result_unknown', '本次用牌结算结果未知。', { actionId: bound });
          // Never consume an intervening choice while waiting for a result.
          if (state.choice) return fail('unexpected_choice', '等待用牌结果时出现待处理选择。', { actionId: bound });
          if (!sent) return fail('result_unknown', '本计划尚未提交动作，不能引用此前用牌作为 lastCard。');
          if (dead()) return fail(state.state, '结算期间本局结束或角色死亡。');
          await pause(); state = await call(() => adapter.observe()); await sampleEffects();
          if (!bound) bound = lastCard;
        }
        const evaluation = conditionValue(action, step.if);
        if (!evaluation) return fail('result_unknown', '当前覆盖范围不足以确定条件，不执行任何分支。', { actionId: bound });
        const branch = evaluation.value ? 'then' : 'else';
        branches.push({ step: current, actionId: bound, branch, ...evaluation });
        completed.push({ step: current, kind: 'condition', actionId: bound, branch });
        // The branch does not itself trust a new choice. The next concrete
        // card/skill selection below must qualify for phase-use continuation.
        const stopped = await run(step[branch] || [], `${current}.${branch}`);
        if (stopped) return stopped;
        continue;
      }
      const notReady = await ready(); if (notReady) return notReady;
      let recognized;
      if (step.inSkill) {
        if (!scopeMatches(step.inSkill)) return fail('unexpected_choice', `预期技能 ${step.inSkill}，当前选择归属不匹配或未确认。`);
        if (!bindSource()) return fail('unexpected_choice', '技能名称相同，但结算来源已变化或无法确认。');
        trustedChoice = choiceKey();
        recognized = true;
      } else recognized = trusted();
      let matches;
      const visible = state.choice.options || [];
      if (own(step, 'blind')) {
        const blind = visible.filter(option => option.kind === 'button' && option.visibility === 'hidden');
        matches = blind[step.blind - 1] ? [blind[step.blind - 1]] : [];
      } else if (step.select.startsWith('skill:')) {
        const name = step.select.slice(6);
        const ids = visible.filter(option => option.kind === 'skill' && option.skill === name);
        matches = ids.length ? ids : visible.filter(option => option.kind === 'skill' && option.label === name);
      } else {
        matches = visible.filter(option => option.id === step.select || (['confirm', 'cancel'].includes(step.select) && option.kind === step.select) || (option.kind === 'target' && option.player === step.select));
      }
      if (!recognized && matches.length === 1) {
        const option = matches[0], context = state.choice.context;
        const concrete = option.kind === 'card' && step.select === option.id || option.kind === 'skill' && step.select === `skill:${option.skill}`;
        const normalPhase = knownContext() && !context.skill && context.sourceAction == null && context.actor === state.me?.id && state.phase === 'phaseUse' && state.choice.event === 'chooseToUse';
        if (concrete && normalPhase && completed.some(item => item.kind === 'action')) {
          // The current verified phase and concrete selectable option establish
          // active-play intent. This also permits an earlier act's pending card
          // to finish here; none of its history becomes lastCard for conditions.
          // Targets, controls and bare confirm/cancel cannot open this gate.
          trustedChoice = choiceKey(); recognized = true;
          selectedSkill = null; selectedRawSkill = null;
        }
      }
      if (!recognized) return fail('unexpected_choice', '出现未经本计划确认的新选择；请指定 inSkill 或单步处理。');
      if (!matches.length) return fail('option_unavailable', '当前选择中没有指定的可执行选项。');
      if (matches.length !== 1) return fail('ambiguous_option', '指定内容匹配多个选项；请使用唯一 ID。');
      const option = matches[0];
      const request = { id: option.id, at: state.revision };
      for (const key of ['value', 'unselect', 'to']) if (own(step, key)) request[key] = step[key];
      sent++;
      const result = await call(() => adapter.act(request), true);
      if (result?.state) state = result.state;
      if (!result?.ok) return fail(result?.code || 'result_unknown', result?.message || '未能确认动作执行结果。', { failedAction: result?.action });
      completed.push({ step: current, kind: 'action', action: result.action || { id: option.id, kind: option.kind, label: option.label } });
      if (option.kind === 'skill') { selectedRawSkill = option.skill; selectedSkill = option.contextSkillCanonical || option.skill; selectedSource = null; sourceBound = false; }
      await sampleEffects();
      if (!result.state) state = await call(() => adapter.observe());
    }
    return null;
  }
  try {
    state = await call(() => adapter.observe());
    if (!options.at || options.at !== state.revision) return fail('stale_choice', '提供 observe 得到的当前 revision。');
    initialChoice = trustedChoice = choiceKey();
    await sampleEffects(true);
    const stopped = await run(plan.steps, 'steps');
    return stopped || { ok: true, completed, branches, state };
  } catch (error) {
    return fail(error.code || 'result_unknown', error.code ? error.message : '连接或适配器异常，操作结果待核实；不会自动重放。');
  }
}

module.exports = { parsePlan, validatePlan, executePlan };
