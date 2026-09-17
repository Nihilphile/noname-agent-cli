'use strict';

// Render observed facts in their original order. No rule inference or parsing
// of native prose: a skill is an operation even when no choice was involved.
const { ABBREVIATIONS: CARDS } = require('./play-language.cjs');
const PHASES = Object.freeze({
  phaseZhunbei: '准备阶段', phaseJudge: '判定阶段', phaseDraw: '摸牌阶段',
  phaseUse: '出牌阶段', phaseDiscard: '弃牌阶段', phaseJieshu: '结束阶段',
});

function label(value) { return String(value?.label || value?.name || value?.id || '?'); }
function personBase(value) {
  if (value?.system === true) return '系统';
  const id = value?.id === undefined || value?.id === null ? null : String(value.id);
  const publicLabel = value?.label === undefined || value?.label === null ? '' : String(value.label);
  const publicName = value?.name === undefined || value?.name === null ? '' : String(value.name);
  if (publicLabel && publicLabel !== id) return publicLabel;
  if (publicName && publicName !== id) return publicName;
  return '未知角色';
}
function personId(value) {
  return value && value.system !== true && value.id !== undefined && value.id !== null ? String(value.id) : null;
}
function samePerson(left, right) {
  const a = personId(left), b = personId(right);
  return a !== null && b !== null && a === b;
}
function card(value) {
  const name = label(value), suits = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' };
  const face = suits[value?.suit] && Number.isFinite(value?.number) ? `【${suits[value.suit]}${value.number}】` : '';
  return (CARDS[name] || name) + face;
}
function sameMaterial(operation, material) {
  if (!['card', 'respond'].includes(operation?.kind) || !material) return false;
  const operationName = operation.id || operation.name, materialName = material.id || material.name;
  if (operationName && materialName && operationName !== materialName) return false;
  if (label(operation) !== label(material) || (operation.nature || '') !== (material.nature || '')) return false;
  return ['suit', 'number'].every(key => operation[key] == null || operation[key] === material[key]);
}
function delta(change) {
  if (Number.isFinite(change.before) && Number.isFinite(change.after)) {
    const difference = change.after - change.before;
    return `${difference >= 0 ? '+' : ''}${difference}`;
  }
  if (Number.isFinite(change.amount)) return `${change.amount >= 0 ? '+' : ''}${change.amount}`;
  return `${change.before ?? '?'}→${change.after ?? '?'}`;
}
function range(from, to) { return `[${from === to ? from : from + '-' + to}]`; }

function createNames(log) {
  const identities = new Map();
  function add(value) {
    if (!value || typeof value !== 'object' || value.system === true) return;
    const id = personId(value);
    if (id === null) return;
    const base = personBase(value);
    let ids = identities.get(base);
    if (!ids) identities.set(base, ids = new Set());
    ids.add(id);
  }
  function addContext(context) { add(context?.turn?.actor); }
  for (const value of Array.isArray(log?.players) ? log.players : []) add(value);
  addContext(log?.context);
  for (const entry of Array.isArray(log?.entries) ? log.entries : []) {
    addContext(entry?.context); add(entry?.actor); add(entry?.owner); add(entry?.player);
    add(entry?.from); add(entry?.to); add(entry?.winner);
    for (const target of Array.isArray(entry?.targets) ? entry.targets : []) add(target);
    for (const participant of Array.isArray(entry?.participants) ? entry.participants : []) add(participant?.player);
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) add(change?.source);
  }
  const ordinal = new Map();
  for (const [base, ids] of identities) {
    if (ids.size < 2) continue;
    [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })).forEach((id, index) => ordinal.set(`${base}\u0000${id}`, index + 1));
  }
  return value => {
    if (value?.system === true) return '系统';
    const base = personBase(value), id = personId(value), suffix = id === null ? null : ordinal.get(`${base}\u0000${id}`);
    return suffix ? `${base}${suffix}` : base;
  };
}

function contextIdentity(context) {
  if (!context || typeof context !== 'object') return { round: null, turn: null, phase: null, missing: true };
  const turn = context.turn && typeof context.turn === 'object'
    ? context.turn.id !== undefined && context.turn.id !== null ? `id:${context.turn.id}` : personId(context.turn.actor) ? `actor:${personId(context.turn.actor)}` : 'turn:unknown'
    : null;
  const phase = context.phase && typeof context.phase === 'object'
    ? context.phase.id !== undefined && context.phase.id !== null ? `id:${context.phase.id}` : context.phase.name ? `name:${context.phase.name}` : 'phase:unknown'
    : null;
  return { round: Number.isFinite(context.round) ? context.round : null, turn, phase, missing: false };
}
function sameContext(left, right) {
  const a = contextIdentity(left), b = contextIdentity(right);
  return a.round === b.round && a.turn === b.turn && a.phase === b.phase && a.missing === b.missing;
}
function phaseName(value) {
  const name = value?.name;
  return PHASES[name] || (typeof name === 'string' && name ? `阶段：${name}` : '阶段未知');
}

function formatExperimental(log) {
  if (!log || log.available === false || log.coverage === 'unavailable') return '实验战报不可用（experimental_log_unavailable）';
  const rawEntries = Array.isArray(log.entries) ? log.entries : [];
  const from = log.from ?? rawEntries[0]?.seq ?? 0, to = log.to ?? rawEntries.at(-1)?.seq ?? 0;
  const lines = ['实验战报（部分事件）'];
  const actor = createNames(log);

  function changeText(change) {
    if (!change || typeof change !== 'object') return '未支持状态';
    if (change.kind === 'damage') {
      const nature = typeof change.nature === 'string' ? change.nature.split('|').filter(Boolean).map(n => ({ fire: '火', thunder: '雷', ice: '冰' }[n] || n)).join('/') : '';
      const components = change.armorAbsorbed !== 0 || change.hpLoss !== change.amount
        ? `｜${change.hpLoss === 0 ? 'hp不变' : `hp-${change.hpLoss}`}｜${change.armorAbsorbed === null ? '盾待结算' : `盾吸收${change.armorAbsorbed}`}` : '';
      return `受${nature}伤-${change.amount}｜来源${change.source ? actor(change.source) : '未知'}${components}`;
    }
    if (change.kind === 'damageArmor') return `伤害补充：盾吸收${change.amount}`;
    if (change.kind === 'loseHp') return `流失体力${delta(change)}`;
    if (change.kind === 'recover') return `回复体力${delta(change)}`;
    const names = { hp: 'hp', maxHp: '体力上限', armor: '盾' };
    if (Object.hasOwn(names, change.kind)) return names[change.kind] + delta(change);
    if (change.kind === 'dead') return change.after === true ? '死亡' : change.after === false ? '存活' : `死亡状态${delta(change)}`;
    if (change.kind === 'dying') return change.after === true ? '濒死' : change.after === false ? '濒死流程结束' : `濒死状态${delta(change)}`;
    const zones = { equipAdd: '装备加入', equipRemove: '装备移出', judgeAdd: '判定区加入', judgeRemove: '判定区移出' };
    if (Object.hasOwn(zones, change.kind)) return `${zones[change.kind]}${card(change.card)}`;
    return `未支持状态(${String(change.kind || '?')})`;
  }

  function visibleCards(entry) {
    const cards = Array.isArray(entry.cards) ? entry.cards : [];
    const count = Number.isFinite(entry.count) && entry.count >= 0 ? entry.count : cards.length || null;
    if (!cards.length) return count === null ? '?张' : `${count}张`;
    const faces = cards.map(card).join('、');
    if (count === cards.length) return `${count}张‹${faces}›`;
    return `${count ?? cards.length}张（公开：${faces}）`;
  }
  function movementText(entry) {
    const payload = visibleCards(entry);
    if (entry.action === 'draw') return `摸${payload}`;
    if (entry.action === 'discard') return `弃置${payload}`;
    if (entry.action === 'gain') return `${entry.from ? `从${actor(entry.from)}` : ''}获得${payload}`;
    if (entry.action === 'lose') return `失去${payload}${entry.to ? `→${actor(entry.to)}` : ''}`;
    return `未支持牌变动(${String(entry.action || '?')})`;
  }

  // Filter legacy hand-count deltas before deriving any displayed range. They
  // are not evidence of draw/discard/gain and must not create empty blocks.
  const entries = [];
  for (let index = 0; index < rawEntries.length; index++) {
    let entry = rawEntries[index], displayTo = entry?.seq ?? '?';
    if (entry?.kind === 'state' && Array.isArray(entry.changes)) {
      const changes = entry.changes.filter(change => change?.kind !== 'handCount');
      if (!changes.length) continue;
      if (changes.length !== entry.changes.length) entry = { ...entry, changes };
    }
    if (entry?.kind === 'state' && entry.changes?.length === 1 && entry.changes[0].kind === 'damage') {
      const change = entry.changes[0];
      let absorbed = change.armorAbsorbed, next = index + 1;
      while (rawEntries[next]?.kind === 'state' && sameContext(rawEntries[next]?.context, entry.context) && rawEntries[next].player?.id === entry.player?.id && rawEntries[next].changes?.length === 1 && rawEntries[next].changes[0].kind === 'damageArmor' && rawEntries[next].changes[0].damageId === change.damageId) {
        absorbed = (absorbed ?? 0) + rawEntries[next].changes[0].amount;
        displayTo = rawEntries[next].seq; next++;
      }
      if (next > index + 1) {
        index = next - 1;
        entry = { ...entry, changes: [{ ...change, armorAbsorbed: absorbed }] };
      }
    }
    entries.push({ entry, displayTo });
  }

  lines.push(entries.length ? `${range(from, to)}${log.truncated ? '（记录已截断）' : ''}` : rawEntries.length ? `${range(from, to)}（无可显示事件）${log.truncated ? '（记录已截断）' : ''}` : `[无新增事件]${log.truncated ? '（记录已截断）' : ''}`);
  let pending = null, currentContext;
  const flush = () => {
    if (pending?.kind === 'states') lines.push(`${range(pending.from, pending.to)} ${pending.prefix}（${pending.parts.join('，')}）`);
    else if (pending) lines.push(`${range(pending.from, pending.to)} ${pending.prefix}{ ${pending.parts.join('，')} }`);
    pending = null;
  };
  function writeContext(context, first = false) {
    const previous = currentContext, next = contextIdentity(context);
    const changed = first || !previous || previous.round !== next.round || previous.turn !== next.turn || previous.phase !== next.phase || previous.missing !== next.missing;
    if (!changed) return;
    flush();
    if (next.missing) {
      lines.push('【进程上下文未知】');
      currentContext = next;
      return;
    }
    const roundChanged = first || !previous || previous.round !== next.round || previous.missing;
    const turnChanged = roundChanged || previous.turn !== next.turn;
    const phaseChanged = turnChanged || previous.phase !== next.phase;
    if (roundChanged) lines.push(`【${next.round === null ? '轮次未知' : `第${next.round}轮`}】`);
    if (turnChanged) lines.push(`【${context?.turn?.actor ? `${actor(context.turn.actor)}的回合` : '回合未知'}】`);
    if (phaseChanged) lines.push(`【${context?.phase ? phaseName(context.phase) : '阶段未知'}】`);
    currentContext = next;
  }
  function startPending(entry, who, seq) {
    const turnActor = entry?.context?.turn?.actor;
    pending = { kind: 'actions', key: personId(who) ?? actor(who), prefix: samePerson(who, turnActor) ? '' : `${actor(who)} `, from: seq, to: seq, parts: [] };
  }
  function appendFor(entry, who, seq, part) {
    const key = personId(who) ?? actor(who);
    if (pending && (pending.kind !== 'actions' || pending.key !== key)) flush();
    if (!pending) startPending(entry, who, seq);
    pending.parts.push(part); pending.to = seq; pending.lastOperation = null; pending.lastState = null;
  }
  function stateIdentity(entry) {
    return personId(entry?.player) ?? actor(entry?.player);
  }
  function statePrefix(entry) {
    return samePerson(entry?.player, entry?.context?.turn?.actor) ? '' : actor(entry?.player);
  }
  function stateParts(entry) {
    return entry.changes.map(changeText);
  }
  function appendStateToAction(entry, displayTo) {
    const key = stateIdentity(entry), additions = stateParts(entry);
    if (pending.lastState?.key === key) {
      const part = pending.lastState;
      part.changes.push(...additions);
      pending.parts[part.index] = `${part.prefix}（${part.changes.join('，')}）`;
    } else {
      const part = { key, prefix: statePrefix(entry), changes: additions, index: pending.parts.length };
      pending.parts.push(`${part.prefix}（${part.changes.join('，')}）`);
      pending.lastState = part;
    }
    pending.to = displayTo;
    pending.lastOperation = null;
  }
  function appendStandaloneState(entry, seq, displayTo) {
    const key = stateIdentity(entry), additions = stateParts(entry);
    if (pending?.kind === 'states' && pending.key === key) {
      pending.parts.push(...additions);
      pending.to = displayTo;
      return;
    }
    flush();
    pending = { kind: 'states', key, prefix: statePrefix(entry), from: seq, to: displayTo, parts: additions };
  }

  if (!entries.length) writeContext(log.context, true);
  for (let index = 0; index < entries.length; index++) {
    const { entry, displayTo } = entries[index], seq = entry?.seq ?? '?';
    writeContext(entry?.context, index === 0);
    if (entry?.kind === 'compare') {
      flush();
      const participants = (entry.participants || []).map(p => `${actor(p.player)} ${card(p.card)}（比较点数${Array.isArray(p.numbers) ? '[' + p.numbers.join(',') + ']' : Number.isFinite(p.number) ? p.number : '?'}）`).join(' ↔ ');
      const result = entry.outcome === 'tie' ? '平局' : entry.outcome === 'no_winner' ? '无人拼点成功' : entry.winner ? `${actor(entry.winner)}胜` : '结果未确认';
      const kind = entry.mode === 'meanwhile' ? '共同拼点' : entry.mode === 'delayed' ? '延时拼点' : '拼点';
      lines.push(`${range(seq, seq)} ${kind}${entry.round ? '第' + entry.round + '组' : ''}：${participants} → ${result}`);
    } else if (entry?.kind === 'materials') {
      const who = entry.actor, key = personId(who) ?? actor(who);
      if (pending && (pending.kind !== 'actions' || pending.key !== key)) flush();
      if (!pending) startPending(entry, who, seq);
      const text = `‹${(entry.cards || []).map(card).join('、')}›`, part = pending.operationParts?.get(entry.operationId);
      if (part) {
        const previous = pending.parts[part.index];
        part.materials.push(...(entry.cards || []));
        const material = part.materials[0];
        const head = part.materials.length === 1 && sameMaterial(part.operation, material)
          ? part.prefix + card({ ...part.operation, suit: material.suit, number: material.number })
          : part.head + `‹${part.materials.map(card).join('、')}›`;
        pending.parts[part.index] = head + previous.slice(part.renderedHeadLength);
        part.renderedHeadLength = head.length;
      } else pending.parts.push(`${entry.operation?.kind === 'skill' ? label(entry.operation) : card(entry.operation)}·所用牌${text}`);
      pending.to = seq; pending.lastOperation = null; pending.lastState = null;
    } else if (['operation', 'selection', 'targets'].includes(entry?.kind) && ['card', 'respond', 'skill', 'showCards', 'judgment'].includes(entry.operation?.kind)) {
      const who = entry.actor, key = personId(who) ?? actor(who);
      const targets = Array.isArray(entry.targets) ? entry.targets : [];
      const baseName = entry.operation.kind === 'judgment' ? '判定' : entry.operation.kind === 'showCards' ? `展示：${(entry.operation.cards || []).map(card).join('、')}（${entry.operation.count}张）` : entry.operation.kind === 'skill' ? label(entry.operation) : card(entry.operation);
      const name = entry.kind === 'selection' && entry.owner?.id && entry.owner.id !== entry.actor?.id ? `${actor(entry.owner)}的${baseName}` : baseName;
      const detail = entry.kind === 'selection' ? `·选目标${entry.batch ?? ''}` : entry.kind === 'targets' ? '·目标' : '';
      const operation = (entry.operation.kind === 'respond' ? '打出' : '') + name + detail + (targets.length ? `[${targets.map(actor).join(',')}]` : '') + (entry.operation.kind === 'judgment' ? `：${card(entry.operation.card)}` : '');
      if (pending && (pending.kind !== 'actions' || pending.key !== key)) flush();
      if (!pending) startPending(entry, who, seq);
      if (entry.kind === 'targets' && entry.operationId && pending.lastOperation?.id === entry.operationId && pending.lastOperation.emptyTargets && targets.length) {
        pending.parts[pending.parts.length - 1] += `[${targets.map(actor).join(',')}]`;
      } else pending.parts.push(operation);
      if (entry.kind === 'operation' && entry.operationId) {
        pending.operationParts ??= new Map();
        const prefix = entry.operation.kind === 'respond' ? '打出' : '', head = prefix + name + detail;
        pending.operationParts.set(entry.operationId, { index: pending.parts.length - 1, operation: entry.operation, prefix, head, renderedHeadLength: head.length, materials: [] });
      }
      pending.lastOperation = entry.kind === 'operation' ? { id: entry.operationId, emptyTargets: !targets.length } : null;
      pending.lastState = null;
      pending.to = seq;
      if (entry.operation.kind === 'judgment') flush();
    } else if (entry?.kind === 'movement') {
      if (entry.action === 'transfer') {
        flush();
        const source = entry.from || entry.actor;
        lines.push(`${range(seq, seq)} 牌转移：${source ? actor(source) : '未知角色'}→${entry.to ? actor(entry.to) : '未知角色'}，${visibleCards(entry)}`);
      } else appendFor(entry, entry.actor, seq, movementText(entry));
    } else if (entry?.kind === 'state' && Array.isArray(entry.changes)) {
      // A bare state refers to the turn owner, so it must not be nested in
      // another player's action block where that identity would be ambiguous.
      if (pending?.kind === 'actions' && samePerson(entry.player, entry.context?.turn?.actor) && pending.key !== stateIdentity(entry)) flush();
      if (pending?.kind === 'actions') appendStateToAction(entry, displayTo);
      else appendStandaloneState(entry, seq, displayTo);
    } else {
      flush();
      lines.push(`${range(seq, seq)} 未支持事件(${String(entry?.kind || '?')})`);
    }
  }
  flush();
  return lines.join('\n');
}

module.exports = { formatExperimental, createNames };
