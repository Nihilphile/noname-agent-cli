'use strict';

// This function is serialized into the renderer. Keep dependencies inside it.
function installFlow({ lib, game, ui, get, _status }, createJournal) {
  if (window.__nonameFlow) return window.__nonameFlow;
  const epoch = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const LIMIT_LOGS = 2000, LIMIT_ACTIONS = 200, LIMIT_EVENTS = 4000;
  const nodeSeen = new WeakSet(), ids = new WeakMap(), offsets = new WeakMap();
  const seenEvents = new WeakSet(), completed = new WeakSet(), failed = new WeakSet();
  const witnessedStart = new WeakSet(), incomplete = new WeakSet();
  const errorsMayBeSuppressed = () => !!(lib.config?.ignore_error || _status.connectMode && !lib.config?.debug);
  const armorValues = new WeakMap(), armorApplied = new WeakMap(), dyingApplied = new WeakSet(), deathApplied = new WeakSet(), zoneBefore = new WeakMap(), zoneMoves = new WeakMap();
  const lifeBefore = new WeakMap();
  const marksBefore = new WeakMap(), markChanges = new WeakMap();
  const damageApplied = new WeakSet(), hpApplied = new WeakSet(), gainApplied = new WeakSet(), loseApplied = new WeakSet();
  let serial = 0, seq = 0, committed = 0, sidebar = null, observer = null;
  const lines = [], actions = [], events = [];
  let journal = null, journalErrors = 0;
  // Installed by the player-view page projection.  The flow recorder owns the
  // raw action/event association; the page owns stable public card IDs.  Keep
  // the bridge deliberately one-way and limited to the local player's already
  // known materials so opponent card objects cannot become an ID side channel.
  let cardIdentity = null;
  const journalCall = (method, event) => {
    try { return journal?.[method](event); }
    catch { journalErrors++; return null; }
  };
  const object = x => x !== null && (typeof x === 'object' || typeof x === 'function');
  const id = (x, prefix) => {
    if (!object(x)) return null;
    if (!ids.has(x)) ids.set(x, `${prefix}${++serial}`);
    return ids.get(x);
  };
  const playerId = p => id(p, 'fp');
  const clean = x => String(get.plainText ? get.plainText(String(x || '')) : x || '').replace(/\s+/g, ' ').trim();
  function ingestNode(node) {
    if (!object(node) || nodeSeen.has(node)) return;
    const value = clean(node.innerText ?? node.textContent);
    if (!value) return;
    nodeSeen.add(node);
    lines.push({ seq: ++seq, text: value });
    if (lines.length > LIMIT_LOGS) lines.splice(0, lines.length - LIMIT_LOGS);
  }
  function ingestRecords(records) {
    for (const record of records) {
      if (record.target === sidebar) for (const node of record.addedNodes || []) ingestNode(node);
    }
  }
  function harvestLogs() {
    if (ui.sidebar !== sidebar) {
      if (observer?.takeRecords) ingestRecords(observer.takeRecords());
      observer?.disconnect(); sidebar = ui.sidebar; observer = null;
      if (sidebar && typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(records => {
          // Process insertion records chronologically, including removed nodes.
          ingestRecords(records);
          for (const node of Array.from(sidebar.children || []).reverse()) ingestNode(node);
        });
        observer.observe(sidebar, { childList: true, subtree: true, characterData: true });
      }
    }
    if (observer?.takeRecords) ingestRecords(observer.takeRecords());
    for (const node of Array.from(sidebar?.children || []).reverse()) ingestNode(node);
  }
  function logs({ since = committed } = {}) {
    harvestLogs();
    if (!Number.isSafeInteger(since) || since < 0 || since > seq) throw new RangeError('invalid log cursor');
    const entries = lines.filter(row => row.seq > since).map(row => ({ ...row }));
    return { epoch, from: entries[0]?.seq ?? seq + 1, to: seq, entries, truncated: since < (lines[0]?.seq ?? 1) - 1 };
  }
  function commitLogs(to) {
    if (!Number.isSafeInteger(to) || to < committed || to > seq) throw new RangeError('invalid log commit');
    committed = to;
  }
  function parent(e) {
    try { const p = e?.parent || e?.getParent?.(); return p !== e && object(p) ? p : null; } catch { return null; }
  }
  function publicZone(p, zone) {
    try { return p?.getCards ? p.getCards(zone).filter(c => !c.classList?.contains('infohidden') && !lib.card?.[c.name]?.blankCard) : []; } catch { return []; }
  }
  function publicMarks() {
    const result = new Map();
    for (const p of new Set([...(game.players || []), ...(game.dead || [])])) {
      const marks = new Map();
      for (const [name, node] of Object.entries(p.marks || {})) {
        // Read rendered public text only. Never evaluate intro/countMark or
        // player.storage; mixed hidden-card mark content is excluded entirely.
        if (!node?.isConnected || !node.getClientRects?.().length || node.closest?.('.hidden,.removing,.infohidden') || node.querySelector?.('.infohidden')) continue;
        if (typeof getComputedStyle === 'function' && getComputedStyle(node).visibility === 'hidden') continue;
        const value = clean(node.innerText);
        const countNode = node.querySelector?.('.markcount');
        const countText = countNode?.isConnected && countNode.getClientRects?.().length && !countNode.closest?.('.hidden,.infohidden') && (typeof getComputedStyle !== 'function' || getComputedStyle(countNode).visibility !== 'hidden') ? clean(countNode.innerText) : '';
        marks.set(name, { text: value, count: /^\d+$/.test(countText) && Number.isSafeInteger(Number(countText)) ? Number(countText) : null });
      }
      result.set(p, marks);
    }
    return result;
  }
  function changedMarks(before, after) {
    const changes = [];
    for (const p of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(p) || new Map(), b = after.get(p) || new Map();
      for (const name of new Set([...a.keys(), ...b.keys()])) {
        const old = a.get(name), next = b.get(name);
        if (old?.text === next?.text && old?.count === next?.count) continue;
        const from = old ? old.count : 0, to = next ? next.count : 0;
        changes.push({ kind: 'mark', target: playerId(p), name, before: old?.text ?? null, after: next?.text ?? null, visibility: 'public', ...(from !== null && to !== null ? { amount: to - from } : {}) });
      }
    }
    return changes;
  }
  function sampleTransitions(e) {
    for (const x of ancestry(e)) {
      if (x.name === 'dying' && lifeBefore.get(x) === false && _status.dying?.includes(x.player)) dyingApplied.add(x);
      if (x.name === 'die' && lifeBefore.get(x) === false && (game.dead?.includes(x.player) || x.player?.isDead?.())) deathApplied.add(x);
    }
  }
  for (const p of [...(game.players || []), ...(game.dead || [])]) if (Number.isFinite(p.hujia)) armorValues.set(p, p.hujia);
  const playerPrototype = lib.element?.Player?.prototype;
  let installedUpdate = null;
  if (playerPrototype && typeof playerPrototype.update === 'function') {
    const original = playerPrototype.update;
    installedUpdate = playerPrototype.update = function (...args) {
      const now = this.hujia, before = armorValues.get(this);
      const ev = _status.event;
      if (ev?.name === 'changeHujia' && ev.player === this && Number.isFinite(now) && Number.isFinite(before)) {
        armorApplied.set(ev, (armorApplied.get(ev) || 0) + now - before);
      }
      if (Number.isFinite(now)) armorValues.set(this, now);
      sampleTransitions(ev);
      try { return original.apply(this, args); }
      finally { journalCall('sample'); }
    };
  }
  if (playerPrototype && typeof playerPrototype.logSkill === 'function') {
    const original = playerPrototype.logSkill;
    playerPrototype.logSkill = function (...args) {
      const event = _status.event;
      const value = original.apply(this, args);
      journalCall('confirmSkill', { player: this, skill: args[0], targets: args[1], event });
      return value;
    };
  }
  if (typeof game.addCardKnower === 'function') {
    const original = game.addCardKnower;
    game.addCardKnower = function (cards, knower, ...args) {
      const event = _status.event;
      const value = original.call(this, cards, knower, ...args);
      if (knower === 'everyone' && event?.name === 'showCards') journalCall('reveal', { event, cards });
      return value;
    };
  }
  if (playerPrototype && typeof playerPrototype.$throw === 'function') {
    const original = playerPrototype.$throw;
    playerPrototype.$throw = function (cards, ...args) {
      const event = _status.event;
      const value = original.call(this, cards, ...args);
      if (Array.isArray(cards)) journalCall('materials', { event, cards, player: this });
      return value;
    };
  }
  for (const method of ['$compare', '$compareMultiple', 'popup']) {
    if (!playerPrototype || typeof playerPrototype[method] !== 'function') continue;
    const original = playerPrototype[method];
    playerPrototype[method] = function (...args) {
      const event = _status.event;
      const value = original.apply(this, args);
      if (method === 'popup') journalCall('comparisonResult', { event, player: this, text: args[0] });
      else journalCall('comparisonReveal', { event, player: this, card1: args[0], ...(method === '$compare' ? { target: args[1], card2: args[2] } : { targets: args[1], cards: args[2] }) });
      return value;
    };
  }
  // Parent first; links supplement asynchronous trigger ancestry. Bounded and
  // cycle-safe, but references survive act calls (never serialized raw).
  function ancestry(e) {
    const result = [], queue = [e], visited = new Set();
    while (queue.length && result.length < 80) {
      const item = queue.shift();
      if (!object(item) || visited.has(item)) continue;
      visited.add(item); result.push(item);
      const p = parent(item);
      if (p) queue.unshift(p);
      for (const link of [item.relatedEvent, item._trigger]) if (object(link)) queue.push(link);
    }
    return result;
  }
  let groupParents = null;
  function refreshSkillGroups() {
    groupParents = new Map();
    for (const [name, info] of Object.entries(lib.skill || {})) {
      const group = typeof info?.group === 'string' ? [info.group] : Array.isArray(info?.group) ? info.group : [];
      for (const child of group) {
        if (typeof child !== 'string') continue;
        if (!groupParents.has(child)) groupParents.set(child, []);
        groupParents.get(child).push(name);
      }
    }
  }
  function publicSkillName(name, seen = new Set()) {
    if (typeof name !== 'string' || name.startsWith('_') || seen.has(name) || seen.size >= 12) return null;
    const info = lib.skill?.[name];
    if (!info || info.hiddenSkill) return null;
    const nextSeen = new Set(seen); nextSeen.add(name);
    // An explicit sourceSkill is authoritative. Otherwise a declared group
    // edge can establish the unique public owner without parsing prompt text.
    if (typeof info.sourceSkill === 'string' && info.sourceSkill !== name) return publicSkillName(info.sourceSkill, nextSeen);
    if (clean(lib.translate?.[name]) && clean(lib.translate?.[name + '_info'])) return name;
    if (!groupParents) refreshSkillGroups();
    const roots = new Set((groupParents.get(name) || []).map(parentName => publicSkillName(parentName, nextSeen)).filter(Boolean));
    return roots.size === 1 ? roots.values().next().value : null;
  }
  function publicSkill(name) { return publicSkillName(name) !== null; }
  function visibleSkillOwner(e) { return !e.player || e.player === game.me || !e.player.classList?.contains('unseen'); }
  function skillActionName(e) {
    const name = e.name === 'useSkill' ? e.skill : e.name, info = lib.skill?.[name];
    if (!visibleSkillOwner(e) || info?.silent || info?.nopop || info?.charlotte) return null;
    return publicSkillName(name);
  }
  function actionKind(e) {
    if (e.name === 'useCard' && typeof e.card?.name === 'string') return 'card';
    if (skillActionName(e)) return 'skill';
    return null;
  }
  function addEvent(e) {
    if (!object(e) || seenEvents.has(e)) return;
    seenEvents.add(e); events.push(e);
    if (events.length > LIMIT_EVENTS) {
      const dropped = events.shift();
      for (const ancestor of ancestry(dropped)) incomplete.add(ancestor);
    }
    if (actionKind(e)) {
      id(e, 'fa'); actions.push(e);
      if (actions.length > LIMIT_ACTIONS) actions.shift();
    }
  }
  function readArray(array, visit) {
    if (!Array.isArray(array)) return;
    let offset = offsets.get(array) || 0;
    if (offset > array.length) offset = 0;
    for (; offset < array.length; offset++) visit(array[offset]);
    offsets.set(array, offset);
  }
  function scan() {
    for (const block of _status.globalHistory || []) {
      readArray(block.everything, addEvent);
      readArray(block.changeHp, e => { hpApplied.add(e); addEvent(e); });
    }
    for (const p of new Set([...(game.players || []), ...(game.dead || [])])) {
      for (const h of p.actionHistory || []) {
        readArray(h.useCard, addEvent);
        readArray(h.damage, e => { damageApplied.add(e); addEvent(e); });
        readArray(h.gain, e => { gainApplied.add(e); addEvent(e); });
        readArray(h.lose, e => { loseApplied.add(e); addEvent(e); });
      }
    }
    // A live choice may point to an action from before instrumentation began.
    for (const e of ancestry(_status.event)) addEvent(e);
  }
  const prototype = lib.element?.GameEvent?.prototype;
  let installedLoop = null;
  let installedTrigger = null;
  if (prototype && typeof prototype.trigger === 'function') {
    const original = prototype.trigger;
    installedTrigger = prototype.trigger = function (...args) {
      sampleTransitions(this);
      try { return original.apply(this, args); }
      finally { journalCall('sample'); }
    };
  }
  if (prototype && typeof prototype.loop === 'function') {
    const original = prototype.loop;
    installedLoop = prototype.loop = function (...args) {
      journalCall('begin', this);
      witnessedStart.add(this);
      addEvent(this);
      if (actionKind(this)) marksBefore.set(this, publicMarks());
      // The native loop can swallow content errors under these settings.
      // Its fulfilled promise then proves closure, not exhaustive effects.
      if (errorsMayBeSuppressed()) for (const ancestor of ancestry(this)) incomplete.add(ancestor);
      if (this.name === 'dying') lifeBefore.set(this, !!_status.dying?.includes(this.player));
      if (this.name === 'die') lifeBefore.set(this, !!(game.dead?.includes(this.player) || this.player?.isDead?.()));
      sampleTransitions(this);
      if (this.player && !armorValues.has(this.player) && Number.isFinite(this.player.hujia)) armorValues.set(this.player, this.player.hujia);
      const zone = this.name === 'equip' ? 'e' : this.name === 'addJudge' ? 'j' : null;
      if (zone) zoneBefore.set(this, new Set(publicZone(this.player, zone)));
      const onDone = () => {
        journalCall('finish', this);
        sampleTransitions(this);
        if (this.finished === true) completed.add(this);
        if (this.finished === true && marksBefore.has(this)) markChanges.set(this, changedMarks(marksBefore.get(this), publicMarks()));
        if (zone && zoneBefore.has(this)) {
          const before = zoneBefore.get(this), after = new Set(publicZone(this.player, zone));
          zoneMoves.set(this, [
            ...Array.from(after).filter(c => !before.has(c)).map(c => ({ kind: zone === 'e' ? 'equip' : 'judge', name: typeof c.viewAs === 'string' ? c.viewAs : c.name, amount: 1 })),
            ...Array.from(before).filter(c => !after.has(c)).map(c => ({ kind: zone === 'e' ? 'equipRemove' : 'judgeRemove', name: typeof c.viewAs === 'string' ? c.viewAs : c.name, amount: 1 })),
          ]);
        }
      };
      let value;
      try { value = original.apply(this, args); } catch (error) { failed.add(this); throw error; }
      if (value && typeof value.then === 'function') {
        // Return the original promise; attach observation without changing
        // result, error propagation, timing, or event execution ownership.
        value.then(onDone, () => failed.add(this));
      } else onDone();
      return value;
    };
  }
  function done(e) { return completed.has(e); }
  function context(e, labels = true) {
    if (labels) refreshSkillGroups();
    const chain = ancestry(e);
    const skillEvent = chain.find(x => visibleSkillOwner(x) && (publicSkill(x.skill) || publicSkill(x.name)));
    const skill = skillEvent ? publicSkillName(skillEvent.skill) || publicSkillName(skillEvent.name) : null;
    // A public grouped child can own a prompt without becoming an action row.
    // Bind its actual event instance so two triggers never share a scope ID.
    const source = chain.find(x => actionKind(x) === 'card') || chain.find(x => actionKind(x) === 'skill') || skillEvent;
    const skillLabel = skill ? clean(lib.translate?.[skill] || skill) : null;
    const skillLabelUnique = labels && !!skill && new Set(Object.keys(lib.skill || {}).map(name => publicSkillName(name)).filter(name => name && clean(lib.translate?.[name] || name) === skillLabel)).size === 1;
    const phase = parent(e);
    const normalPhase = e?.name === 'chooseToUse' && e.type === 'phase' && e.player === game.me && phase?.name === 'phaseUse' && phase.player === game.me && !e.skill && !e._trigger && !e.relatedEvent;
    return { skill: skill || null, skillLabel, skillLabelUnique, actor: playerId(e?.player || skillEvent?.player || source?.player), sourceAction: source ? id(source, 'fa') : null, certainty: skill || source || normalPhase ? 'known' : 'unknown' };
  }
  function owner(e) {
    const chain = ancestry(e).slice(1);
    // Keep effects of triggered skills under the causal card, with sourceSkill.
    return chain.find(x => actionKind(x) === 'card') || chain.find(x => actionKind(x) === 'skill') || null;
  }
  function effect(e) {
    if (failed.has(e)) return null;
    const common = { kind: e.name, target: playerId(e.player), visibility: 'public' };
    const sourceSkill = context(e, false).skill;
    if (sourceSkill) common.sourceSkill = sourceSkill;
    // Entering dying/death is already a public fact even while rescue or
    // death-triggered choices keep the enclosing event pending.
    if (e.name === 'dying' && dyingApplied.has(e)) return { ...common, kind: 'dying' };
    if (e.name === 'die' && deathApplied.has(e)) return { ...common, kind: 'death' };
    if (!done(e)) return null;
    if (e.name === 'changeHujia' && armorApplied.has(e)) return { ...common, kind: 'armor', amount: armorApplied.get(e) };
    if (zoneMoves.has(e)) return zoneMoves.get(e).map(move => ({ ...common, ...move }));
    if (e.name === 'damage') {
      if (e.unreal || !damageApplied.has(e) || !Number.isFinite(e.num) || e.num < 0) return null;
      return { ...common, amount: e.num };
    }
    if (['loseHp', 'recover'].includes(e.name)) {
      // Verify actual committed HP changes, not the requested amount.
      const changes = events.filter(x => x.name === 'changeHp' && parent(x) === e && hpApplied.has(x) && done(x));
      if (!changes.length || changes.some(x => !Number.isFinite(x.num))) return null;
      const amount = changes.reduce((sum, x) => sum + x.num, 0) * (e.name === 'loseHp' ? -1 : 1);
      if (amount < 0) return null;
      return { ...common, amount };
    }
    if (e.name === 'gain' && gainApplied.has(e) || e.name === 'lose' && loseApplied.has(e)) {
      // Counts only: never expose card names, suits, identities, or storage.
      const list = e.name === 'gain' ? e.cards : e.cards2;
      if (!Array.isArray(list)) return null;
      const isDraw = e.name === 'gain' && parent(e)?.name === 'draw';
      return { ...common, kind: isDraw ? 'draw' : e.name, amount: list.length };
    }
    return null;
  }
  function effects() {
    refreshSkillGroups();
    scan();
    return { epoch, actions: actions.map(e => {
      const descendants = events.filter(x => owner(x) === e);
      const complete = done(e) && witnessedStart.has(e) && !errorsMayBeSuppressed() && !incomplete.has(e) && !failed.has(e) && prototype?.loop === installedLoop &&
        descendants.every(x => witnessedStart.has(x) && !failed.has(x) && !incomplete.has(x) && done(x));
      const effectCompleteness = Object.fromEntries(['damage', 'loseHp', 'recover', 'draw', 'gain', 'lose'].map(kind => [kind, !!complete]));
      effectCompleteness.armor = !!complete && !!installedUpdate && playerPrototype?.update === installedUpdate;
      effectCompleteness.dying = effectCompleteness.death = !!complete && !!installedTrigger && prototype?.trigger === installedTrigger;
      // Zone movement is a confirmed net observation, not exhaustive transit.
      effectCompleteness.equip = effectCompleteness.judge = false;
      effectCompleteness.mark = false;
      // A malformed committed standard event is a gap, never an implicit zero.
      for (const x of descendants) {
        if (x.name === 'changeHujia' && !armorApplied.has(x)) effectCompleteness.armor = false;
        if (x.name === 'damage' && damageApplied.has(x) && !x.unreal && (!Number.isFinite(x.num) || x.num < 0)) effectCompleteness.damage = false;
        if (x.name === 'gain' && gainApplied.has(x) && !Array.isArray(x.cards)) effectCompleteness.gain = effectCompleteness.draw = false;
        if (x.name === 'lose' && loseApplied.has(x) && !Array.isArray(x.cards2)) effectCompleteness.lose = false;
        if (x.name === 'changeHp' && hpApplied.has(x) && !Number.isFinite(x.num)) {
          if (parent(x)?.name === 'loseHp') effectCompleteness.loseHp = false;
          if (parent(x)?.name === 'recover') effectCompleteness.recover = false;
        }
        if (x.name === 'changeHp' && hpApplied.has(x)) {
          if (parent(x)?.name === 'loseHp' && x.num > 0) effectCompleteness.loseHp = false;
          if (parent(x)?.name === 'recover' && x.num < 0) effectCompleteness.recover = false;
        }
      }
      const kind = actionKind(e);
      const localMaterials = kind === 'card' && e.player === game.me && Array.isArray(e.cards) && typeof cardIdentity === 'function'
        ? e.cards.map(cardIdentity).filter(cardId => typeof cardId === 'string') : [];
      // Native useCard wraps even an ordinary physical card in a VCard, so
      // object identity between e.card and e.cards[0] is not a direct-use
      // signal.  One same-faced local material and no conversion skill is the
      // conservative receipt for the wrapper supported by play.
      const material = localMaterials.length === 1 ? e.cards[0] : null;
      const nature = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').join('|') : typeof value === 'string' ? value.split('|').filter(Boolean).join('|') : '';
      const actionNature = nature(e.card?.nature), sameNature = nature(material?.nature) === actionNature;
      const physicalMode = material && !e.skill && material.name === e.card?.name && sameNature ? 'direct' : 'materials';
      return {
      id: id(e, 'fa'), kind, name: kind === 'card' ? e.card.name : skillActionName(e),
      ...(kind === 'card' && actionNature ? { nature: actionNature } : {}),
      ...(localMaterials.length ? { physicalCards: localMaterials, physicalMode } : {}),
      actor: playerId(e.player), targets: Array.isArray(e.targets) ? e.targets.map(playerId) : [],
      status: failed.has(e) ? 'unknown' : done(e) ? 'completed' : e.finished === true ? 'unknown' : 'pending',
      // Arbitrary custom skills can mutate state outside tracked primitives.
      // Partial is deliberate: an empty effects list never proves no effect.
      coverage: 'partial',
      effectCompleteness,
      effects: [...descendants.map(effect).flat().filter(Boolean), ...(markChanges.get(e) || [])],
    }; }) };
  }
  if (typeof createJournal === 'function') {
    try { journal = createJournal({ lib, game, get, _status, playerId, canonicalSkill: publicSkillName }); }
    catch { journalErrors++; }
  }
  function eventLogs(request) {
    const value = journal ? journal.logs(request) : null;
    return value ? { ...value, samplingErrors: journalErrors } : { source: 'eventflow', coverage: 'unavailable', entries: [], samplingErrors: journalErrors };
  }
  function commitFeedback(request) {
    if (request.epoch !== epoch) return { ok: false, code: 'log_epoch_changed' };
    if (!Number.isSafeInteger(request.to) || request.to < committed || request.to > seq) throw new RangeError('invalid log commit');
    if (request.eventEpoch != null) {
      if (!journal || journal.logs().epoch !== request.eventEpoch) return { ok: false, code: 'event_epoch_changed' };
      journal.validateCommit(request.eventTo);
    }
    commitLogs(request.to);
    if (request.eventEpoch != null) journal.commit(request.eventTo);
    return { ok: true };
  }
  harvestLogs(); scan();
  return window.__nonameFlow = { logs, commitLogs, commitFeedback, effects, eventLogs,
    setCardIdentityResolver(resolve) { cardIdentity = typeof resolve === 'function' ? resolve : null; },
    choiceContext: context, canonicalSkill(name) { refreshSkillGroups(); return publicSkillName(name); }, playerId };
}

module.exports = { installFlow };
