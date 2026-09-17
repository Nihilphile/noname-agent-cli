'use strict';

// Serialized into the renderer: all helpers must remain inside this function.
function createEventJournal({ game, lib, get, _status, playerId, canonicalSkill }) {
  const epoch = `journal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const LIMIT = 2000, rows = [], seen = new WeakSet(), ended = new WeakSet(), operations = new WeakMap(), targetStates = new WeakMap(), baseline = new WeakMap();
  const appliedHp = new WeakSet(), hpResults = new WeakMap(), revealed = new WeakSet();
  const materialOwners = new WeakMap(), shownMaterials = new WeakMap();
  const triggerConfirmations = new WeakMap();
  const explicitSkills = new WeakMap();
  const comparisons = new WeakMap();
  const turnIds = new WeakMap(), phaseIds = new WeakMap(), eventContexts = new WeakMap(), movements = new WeakSet();
  const wuguPools = new WeakMap(), wuguPoolCards = new WeakMap();
  let seq = 0, committed = 0, operationSerial = 0, damageSerial = 0, turnSerial = 0, phaseSerial = 0;
  const object = x => x !== null && typeof x === 'object';
  const clean = x => String(get?.plainText ? get.plainText(String(x || '')) : x || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const label = name => clean(lib.translate?.[name]) || name;
  const hidden = p => !!(p?.classList?.contains('unseen') || p?.classList?.contains('unseen2'));
  const players = () => [...new Set([...(game.players || []), ...(game.dead || [])])].filter(object);
  function person(p) {
    if (!object(p) || !players().includes(p)) return null;
    const id = playerId(p), name = hidden(p) ? null : typeof p.name === 'string' ? p.name : null;
    return { id, name, label: name ? label(name) : id };
  }
  function eventContext(e = _status.event) {
    const ancestry = chain(e);
    const turnEvent = ancestry.find(item => item.name === 'phase' && person(item.player));
    const phaseNames = new Set(['phaseZhunbei', 'phaseJudge', 'phaseDraw', 'phaseUse', 'phaseDiscard', 'phaseJieshu', ...(Array.isArray(lib.phaseName) ? lib.phaseName : [])]);
    const phaseEvent = ancestry.find(item => item !== turnEvent && phaseNames.has(item.name) && person(item.player));
    let turn = null, phase = null;
    if (turnEvent) {
      if (!turnIds.has(turnEvent)) turnIds.set(turnEvent, `jt${++turnSerial}`);
      turn = { id: turnIds.get(turnEvent), actor: person(turnEvent.player) };
    }
    if (phaseEvent) {
      if (!phaseIds.has(phaseEvent)) phaseIds.set(phaseEvent, `jp${++phaseSerial}`);
      phase = { id: phaseIds.get(phaseEvent), name: phaseEvent.name };
    }
    return { round: Number.isFinite(game.roundNumber) ? game.roundNumber : null, turn, phase };
  }
  function push(row, event) {
    rows.push({ seq: ++seq, ...row, context: object(event) && eventContexts.has(event) ? eventContexts.get(event) : eventContext(event) });
    if (rows.length > LIMIT) rows.splice(0, rows.length - LIMIT);
  }
  function cardInfo(card, zone) {
    const viewAs = zone === 'j' ? card.viewAs : null;
    const name = typeof viewAs === 'string' ? viewAs : typeof viewAs?.name === 'string' ? viewAs.name : card.name;
    const rawNature = object(viewAs) ? viewAs.nature : card.nature;
    const nature = Array.isArray(rawNature) ? rawNature.filter(n => typeof n === 'string').join(lib.natureSeparator || '|') : typeof rawNature === 'string' ? rawNature : '';
    const natureLabel = nature.split(lib.natureSeparator || '|').filter(Boolean).map(n => clean(lib.translate?.[n]) || ({ thunder: '雷', fire: '火', ice: '冰' }[n]) || n).join('');
    const info = { name, label: `${name === 'sha' ? natureLabel : ''}${label(name)}`, ...(nature ? { nature } : {}) };
    // Only the one publicly used physical card, never conversion material arrays.
    let physical = false;
    try { physical = get?.itemtype?.(card) === 'card'; } catch {}
    if (physical) {
      if (typeof card.suit === 'string') info.suit = card.suit;
      if (typeof card.number === 'number' && Number.isFinite(card.number)) info.number = card.number;
    }
    return info;
  }
  function publicCards(p, zone) {
    try {
      if (typeof p.getCards !== 'function') return null;
      const cards = p.getCards(zone);
      if (!Array.isArray(cards)) return null;
      return cards.filter(c => object(c) && !c.classList?.contains('infohidden') && !lib.card?.[c.name]?.blankCard && typeof c.name === 'string').map(c => ({ object: c, ...cardInfo(c, zone) }));
    } catch { return null; }
  }
  function snapshot(p) {
    const finite = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
    let dead = null;
    try { dead = typeof p.isDead === 'function' ? !!p.isDead() : (game.dead || []).includes(p); } catch {}
    return {
      hp: finite(p.hp), maxHp: finite(p.maxHp), armor: finite(p.hujia), dead,
      dying: Array.isArray(_status.dying) ? _status.dying.includes(p) : null,
      equip: publicCards(p, 'e'), judge: publicCards(p, 'j'),
    };
  }
  function sample(event = _status.event) {
    let capturedHpPlayer = null;
    // changeHp registers itself before mutating HP. An observed update plus
    // this receipt proves application; a requested/cancelled damage does not.
    if (event?.name === 'changeHp' && seen.has(event) && !appliedHp.has(event)) {
      let receipt = false;
      try { receipt = Array.isArray(_status.globalHistory) && _status.globalHistory.some(block => Array.isArray(block.changeHp) && block.changeHp.includes(event)); } catch {}
      const p = event.player, before = baseline.get(p), cause = parent(event);
      if (receipt && before && Number.isFinite(before.hp) && Number.isFinite(p.hp)) {
        appliedHp.add(event);
        if (cause?.player === p && cause.name === 'damage' && !cause.unreal && !cause.cancelled && Number.isFinite(cause.num) && cause.num > 0) {
          hpResults.set(event, { player: person(p), change: { kind: 'damage', damageId: `jd${++damageSerial}`, amount: cause.num, hpLoss: Math.max(0, before.hp - p.hp), armorAbsorbed: event.hujia > 0 ? null : 0, source: person(cause.source), nature: typeof cause.nature === 'string' ? cause.nature : Array.isArray(cause.nature) ? cause.nature.filter(n => typeof n === 'string').join(lib.natureSeparator || '|') : '' } });
        } else if (cause?.player === p && ['loseHp', 'recover'].includes(cause.name) && p.hp !== before.hp) {
          hpResults.set(event, { player: person(p), change: { kind: cause.name, before: before.hp, after: p.hp, amount: p.hp - before.hp } });
        }
        if (hpResults.has(event)) {
          capturedHpPlayer = p;
          // Replacing the generic HP delta must retain its activation signal.
          // Emit at application, before any nested changeHp-trigger operation.
          confirmObserved(event);
          const result = hpResults.get(event);
          push({ kind: 'state', player: result.player, changes: [result.change] }, event);
        }
      }
    }
    for (const p of players()) {
      const before = baseline.get(p), after = snapshot(p); baseline.set(p, after);
      if (!before) continue;
      const changes = [];
      for (const kind of ['hp', 'maxHp', 'armor', 'dead', 'dying']) {
        const a = before[kind], b = after[kind];
        if (a === null || b === null || a === b) continue;
        if (kind === 'hp' && capturedHpPlayer === p) continue;
        // Armor is a separate native child. Append its actual loss by ID;
        // never mutate already published HP evidence or report a request as loss.
        const damage = kind === 'armor' && event?.name === 'changeHujia' && event.player === p && event.type === 'damage' ? hpResults.get(parent(event)) : null;
        if (damage?.change.kind === 'damage' && b < a) {
          changes.push({ kind: 'damageArmor', damageId: damage.change.damageId, amount: a - b });
          continue;
        }
        changes.push({ kind, before: a, after: b, ...(typeof a === 'number' && typeof b === 'number' ? { amount: b - a } : {}) });
      }
      for (const zone of ['equip', 'judge']) {
        if (before[zone] === null || after[zone] === null) continue;
        const publicInfo = card => { const { object: ignored, ...info } = card; return info; };
        for (const card of before[zone]) if (!after[zone].some(c => c.object === card.object)) changes.push({ kind: `${zone}Remove`, before: true, after: false, card: publicInfo(card) });
        for (const card of after[zone]) if (!before[zone].some(c => c.object === card.object)) changes.push({ kind: `${zone}Add`, before: false, after: true, card: publicInfo(card) });
      }
      if (changes.length) {
        // Confirm a deferred direct skill only when public state really changes,
        // not when a requested damage/recover event is later cancelled.
        confirmObserved(event);
        push({ kind: 'state', player: person(p), changes }, event);
      }
    }
  }
  function parent(e) {
    try { const p = e.parent || e.getParent?.(); return object(p) && p !== e ? p : null; } catch { return null; }
  }
  function chain(e) {
    const result = [], visited = new Set();
    while (object(e) && !visited.has(e) && result.length < 80) {
      visited.add(e); result.push(e); e = parent(e);
    }
    return result;
  }
  function visibleTargets(e) {
    return publicEvent(e) && !chain(e).some(x => x.hideTargets || x.hidden);
  }
  function publicEvent(e) {
    return !chain(e).some(x => x.skillHidden || x.hiddenSkill || x.hsskill);
  }
  function orderedTargets(e) {
    if (!visibleTargets(e)) return [];
    // singleCard splits [borrower, victim] before the useCard loop starts.
    // Snapshot before the engine sorts/mutates its live arrays; never use a Set.
    if (e.name === 'useCard' && lib.card?.[e.card?.name]?.singleCard && Array.isArray(e._targets)) return e._targets.map(person).filter(Boolean);
    const list = Array.isArray(e.targets) ? e.targets.slice() : [];
    if (e.target && !list.includes(e.target)) list.push(e.target);
    return list.map(person).filter(Boolean);
  }
  function emit(record, confirmation = 'event', rawSkill = record?.rawSkill) {
    if (!record || record.emitted) return;
    record.emitted = true;
    push({ kind: 'operation', operationId: record.id, actor: record.actor, operation: record.operation, targets: record.targets,
      ...(record.operation.kind === 'skill' ? { rawSkill, confirmation } : {}) }, record.event);
  }
  function targetUpdate(record, targets, source) {
    const key = JSON.stringify(targets);
    if (!targets.length || record.lastDeclared === key) return;
    record.lastDeclared = key;
    push({ kind: 'targets', operationId: record.id, actor: record.actor, operation: record.operation, source, targets }, record.event);
  }
  function checkpoint(e) {
    // Late plural `targets` can be a candidate pool (e.g. repeated distribution).
    // Only an explicitly assigned singular target is tracked here.
    for (const x of chain(e).reverse()) {
      const record = operations.get(x);
      if (!record || !record.emitted || record.operation.kind !== 'skill' || !visibleTargets(x)) continue;
      const target = person(x.target);
      const state = targetStates.get(x) || { lastTarget: null, hasLateTarget: false };
      if (!target || state.lastTarget === x.target) continue;
      state.lastTarget = x.target; targetStates.set(x, state);
      if (!state.hasLateTarget && record.targets.some(t => t.id === target.id)) continue;
      state.hasLateTarget = true;
      targetUpdate(record, [target], 'event.target');
    }
  }
  function nearest(e) {
    for (const x of chain(e)) if (operations.has(x)) return operations.get(x);
    return null;
  }
  function confirmObserved(e) {
    const record = nearest(e);
    if (record && !record.emitted && publicEvent(e)) { emit(record, 'public_state'); checkpoint(e); }
  }
  function finish(e) {
    if (!object(e) || ended.has(e)) return;
    ended.add(e);
    const record = nearest(parent(e));
    if (record?.operation.kind === 'skill' && visibleTargets(e)) {
      if (['chooseTarget', 'chooseCardTarget'].includes(e.name) && e.result?.bool === true && Array.isArray(e.result.targets) && (e.player === game.me || e.animate !== false)) {
        const targets = e.result.targets.map(person).filter(Boolean), actor = person(e.player);
        if (targets.length && actor) push({ kind: 'selection', operationId: record.id, actor, owner: record.actor, operation: record.operation, batch: ++record.batch, source: e.name, targets }, e);
      }
    }
    checkpoint(e); movement(e); sample(e);
    if (e.finished === true) comparisonResult({ event: e, final: true });
    // Native judge creates result.card after replacements, then judgeFixing
    // and callback may still modify it. Observe only after its loop completes.
    if (seen.has(e) && e.name === 'judge' && e.finished === true && publicEvent(e) && !e.hidden && !e.cancelled) {
      const card = publicFace(e.result?.card);
      const player = person(e.player);
      if (card && player) push({ kind: 'operation', operationId: `jo${++operationSerial}`, actor: { id: 'system', label: '系统', system: true }, operation: { kind: 'judgment', card }, targets: [player] }, e);
    }
  }
  function publicFace(c) {
    if (!object(c) || c.classList?.contains('infohidden') || typeof c.name !== 'string' || lib.card?.[c.name]?.blankCard) return null;
    try { if (get?.itemtype?.(c) !== 'card') return null; } catch { return null; }
    return cardInfo(c);
  }
  function publicComparison(e) {
    return seen.has(e) && ['chooseToCompare', 'chooseToCompareEffect', 'chooseToCompareMultiple', 'chooseToCompareMeanwhile'].includes(e.name) && visibleTargets(e) && !chain(e).some(x => x.hideCards) && !e.cancelled && !e._cancelled && !e.result?.cancelled && !(e.parentEvent && (e.parentEvent.hidden || e.parentEvent.hideCards || !publicEvent(e.parentEvent)));
  }
  function comparisonReveal({ event: e, player, card1, target, card2, targets, cards }) {
    // Exact native public animation call, on the observed compare event. Never
    // inspect selected hand cards, fixedResult or a delayed event's stored cards.
    if (!publicComparison(e) || e.player !== player || e.card1 !== card1) return;
    const actor = person(player), face1 = publicFace(card1);
    if (!actor || !face1) return;
    // Player.chooseToCompare(array) keeps name='chooseToCompare' and selects
    // Multiple content. Its result arrays/iteration receipt distinguish it.
    const mode = e.compareMeanwhile === true || e.name === 'chooseToCompareMeanwhile' ? 'meanwhile' : e.name === 'chooseToCompareMultiple' || Array.isArray(e.result?.num1) && Array.isArray(e.result?.num2) && Array.isArray(e.targets) ? 'multiple' : e.name === 'chooseToCompareEffect' ? 'delayed' : 'single';
    let receipt = comparisons.get(e);
    if (!receipt) { receipt = { id: `jc${++operationSerial}`, mode, actor: player, rounds: new Map(), emitted: false }; comparisons.set(e, receipt); }
    if (mode === 'meanwhile') {
      if (!Array.isArray(targets) || !Array.isArray(cards) || targets.length !== cards.length || !targets.length || targets.some((p, i) => e.targets?.[i] !== p || e.cardlist?.[i] !== cards[i])) return;
      const visible = targets.map((p, i) => ({ player: person(p), card: publicFace(cards[i]) }));
      if (visible.some(p => !p.player || !p.card)) return;
      receipt.group = { actor, card: face1, card1, targets: targets.slice(), cards: cards.slice(), visible };
      return;
    }
    const pile = e.name === 'chooseToCompare' && e.compareWithCardPile === true && e.target === 'cardPile';
    if (target !== (pile ? player : e.target) || card2 !== e.card2) return;
    const other = pile ? { id: 'cardPile', label: '牌堆', zone: 'cardPile' } : person(target), face2 = publicFace(card2);
    if (!other || !face2) return;
    const index = mode === 'multiple' ? e.iwhile : 0;
    if (!Number.isInteger(index) || index < 0) return;
    const previous = receipt.rounds.get(index);
    if (previous?.emitted) return;
    receipt.rounds.set(index, { actor, target: other, targetObject: pile ? 'cardPile' : target, card1, card2, face1, face2, emitted: false });
  }
  function comparisonResult({ event: e, player, text, final = false }) {
    if (!publicComparison(e)) return;
    // A participant may display unrelated skill UI while result fields are
    // still being adjusted. Only native outcome markers confirm publication;
    // the actual outcome below still comes from the settled engine fields.
    if (!final && !['胜', '负', '平'].includes(text)) return;
    const receipt = comparisons.get(e);
    if (!receipt) return;
    const r = e.result;
    if (receipt.mode === 'meanwhile') {
      const group = receipt.group;
      // Native final resolution restores player and deletes tempplayer only
      // after all compare/compareFixing passes. Null winner means no unique
      // success, not that every participant had equal points.
      if (!group || receipt.emitted || e.tempplayer || e.player !== receipt.actor || !r || !Object.hasOwn(r, 'winner') || !Array.isArray(r.num1) || !Array.isArray(r.num2) || r.num1.length !== group.targets.length || r.num2.length !== group.targets.length || !r.num1.every(Number.isFinite) || !r.num2.every(Number.isFinite)) return;
      if (!final && ![receipt.actor, ...group.targets].includes(player)) return;
      if (group.targets.some((p, i) => e.targets?.[i] !== p || e.cardlist?.[i] !== group.cards[i]) || e.card1 !== group.card1) return;
      const winner = r.winner === null ? null : [receipt.actor, ...group.targets].includes(r.winner) ? person(r.winner) : undefined;
      if (winner === undefined) return;
      receipt.emitted = true;
      push({ kind: 'compare', compareId: receipt.id, mode: 'meanwhile',
        participants: [{ player: group.actor, card: group.card, numbers: r.num1.slice() }, ...group.visible.map((v, i) => ({ ...v, number: r.num2[i] }))],
        outcome: !winner ? 'no_winner' : r.winner === receipt.actor ? 'win' : 'loss', winner }, e);
      return;
    }
    const multiple = receipt.mode === 'multiple';
    // The native multiple loop clears winner and forceWinner between rounds.
    // Capture at its public outcome popup, not at final loop closure or an
    // optional compareMultiple callback that many skills never install.
    if (multiple && (final || player !== receipt.actor)) return;
    const index = multiple ? e.iiwhile : 0, round = receipt.rounds.get(index);
    if (!round || round.emitted || e.player !== receipt.actor || e.target !== round.targetObject || e.card1 !== round.card1 || e.card2 !== round.card2 || !Number.isFinite(e.num1) || !Number.isFinite(e.num2)) return;
    if (!final && player !== receipt.actor && player !== round.targetObject) return;
    let outcome, winner;
    if (multiple) {
      if (!Number.isFinite(r?.num1?.[index]) || !Number.isFinite(r?.num2?.[index])) return;
      if (text === '平') { outcome = 'tie'; winner = null; }
      else if (text === '胜' && e.winner === receipt.actor) { outcome = 'win'; winner = round.actor; }
      else if (text === '负' && e.winner === round.targetObject) { outcome = 'loss'; winner = round.target; }
      else return;
    } else {
      if (typeof r?.bool !== 'boolean') return;
      if (r.tie === true) { outcome = 'tie'; winner = null; }
      else if (r.bool === true && r.winner === receipt.actor) { outcome = 'win'; winner = round.actor; }
      else if (r.bool === false && (r.winner === round.targetObject || round.targetObject === 'cardPile')) { outcome = 'loss'; winner = round.target; }
      else return;
    }
    round.emitted = true;
    push({ kind: 'compare', compareId: receipt.id, mode: receipt.mode, ...(multiple ? { round: index + 1 } : {}),
      participants: [{ player: round.actor, card: round.face1, number: e.num1 }, { player: round.target, card: round.face2, number: e.num2 }], outcome, winner }, e);
  }
  function reveal({ event, cards }) {
    // Called at the native public showCards boundary, not from arbitrary
    // event.cards, dialogs, choices, conversion materials or private hands.
    if (!seen.has(event) || revealed.has(event) || event.name !== 'showCards' || event.triggeronly || event.hidden || !publicEvent(event) || typeof event.customButton === 'function' || event.createDialog || !Array.isArray(cards)) return;
    revealed.add(event);
    const hiddenCards = [...(Array.isArray(event.hiddencards) ? event.hiddencards : []), ...(Array.isArray(event.hiddenCards) ? event.hiddenCards : [])];
    const visible = cards.filter(c => !hiddenCards.includes(c)).map(publicFace).filter(Boolean), actor = person(event.player);
    if (actor && visible.length) push({ kind: 'operation', operationId: `jo${++operationSerial}`, actor, operation: { kind: 'showCards', cards: visible, count: visible.length }, targets: [] }, event);
  }
  function materials({ event, cards, player = event?.player }) {
    if (!seen.has(event) || !publicEvent(event) || event.hidden || event.hideCards || event.player !== player || !Array.isArray(cards)) return;
    let owner = event;
    if (event.name === 'lose') {
      // Native useSkill -> discard -> lose throws before hiding cloned faces.
      // Only an explicitly visible loss can establish this public boundary.
      if (event.visible !== true) return;
      owner = parent(event);
      if (!owner || !['discard', 'loseToDiscardpile'].includes(owner.name)) return;
      const visited = new Set();
      while (owner && ['discard', 'loseToDiscardpile'].includes(owner.name)) {
        if (visited.has(owner) || visited.size >= 80 || owner.player !== player || owner.hidden || owner.hideCards) return;
        visited.add(owner);
        owner = parent(owner);
      }
      if (owner?.name !== 'useSkill') return;
    }
    if (!owner || !seen.has(owner) || !['useCard', 'respond', 'useSkill'].includes(owner.name) || owner.player !== player || owner.hidden || owner.hideCards || !Array.isArray(owner.cards)) return;
    const record = materialOwners.get(owner) || operations.get(owner);
    if (!record || !record.emitted) return;
    const shown = shownMaterials.get(owner) || new Set();
    const physical = cards.filter(c => owner.cards.includes(c) && !shown.has(c) && publicFace(c));
    if (!physical.length) return;
    physical.forEach(c => shown.add(c)); shownMaterials.set(owner, shown);
    push({ kind: 'materials', operationId: record.id, actor: record.actor, operation: record.operation, cards: physical.map(publicFace) }, event);
  }
  function hasReceipt(e, kind) {
    try { return Array.isArray(e.player?.actionHistory) && e.player.actionHistory.some(history => Array.isArray(history?.[kind]) && history[kind].includes(e)); }
    catch { return false; }
  }
  function wuguUse(e) {
    const candidates = [...chain(e), ...(object(e?.relatedEvent) ? chain(e.relatedEvent) : [])];
    return candidates.find(item => item.name === 'useCard' && item.card?.name === 'wugu') || null;
  }
  function recordWuguPool(e) {
    if (e.name !== 'cardsGotoOrdering' || !Array.isArray(e.cards) || !e.cards.length) return false;
    let receipted = false;
    try { receipted = Array.isArray(game.getGlobalHistory?.()?.cardMove) && game.getGlobalHistory().cardMove.includes(e); } catch {}
    const use = receipted ? wuguUse(e) : null, actor = person(use?.player);
    if (!use || !actor || wuguPools.has(use)) return false;
    const cards = e.cards.filter(object), visible = cards.map(publicFace).filter(Boolean);
    if (!visible.length || visible.length !== cards.length) return false;
    const pool = { use, cards: new Set(cards) };
    wuguPools.set(use, pool);
    cards.forEach(card => wuguPoolCards.set(card, pool));
    push({ kind: 'operation', operationId: `jo${++operationSerial}`, actor, operation: { kind: 'showCards', cards: visible, count: visible.length }, targets: [] }, e);
    return true;
  }
  function publicWuguGain(e) {
    if (e.animate !== 'visible' || !Array.isArray(e.cards) || !e.cards.length) return false;
    const use = wuguUse(e), pool = use && wuguPools.get(use);
    return !!pool && e.cards.every(card => pool.cards.has(card) && wuguPoolCards.get(card) === pool);
  }
  function visibleMovementCards(e, cards, observerKnows = false) {
    // A card object is not visibility evidence. Opponent hand gains and draws
    // stay count-only unless the native event explicitly made them public.
    if (!observerKnows && e.visible !== true && e.player !== game.me) return [];
    return cards.map(publicFace).filter(Boolean);
  }
  function movementOwner(e) {
    const record = nearest(parent(e));
    return record?.emitted ? record.id : null;
  }
  function emitMovement(e, action, actor, from, to, cards, observerKnows = false) {
    if (!actor || !Array.isArray(cards) || !cards.length) return;
    confirmObserved(e);
    push({ kind: 'movement', action, actor, from, to, count: cards.length, cards: visibleMovementCards(e, cards, observerKnows), operationId: movementOwner(e) }, e);
  }
  function movement(e) {
    if (!object(e) || movements.has(e) || e.finished !== true || e.cancelled || e._cancelled || !publicEvent(e)) return;
    if (e.name === 'cardsGotoOrdering') {
      if (recordWuguPool(e)) movements.add(e);
      return;
    }
    if (e.name === 'gain') {
      if (!hasReceipt(e, 'gain') || !Array.isArray(e.cards)) return;
      movements.add(e);
      const receiver = person(e.player);
      if (!receiver || !e.cards.length) return;
      if (parent(e)?.name === 'draw') {
        emitMovement(e, 'draw', receiver, null, receiver, e.cards);
        return;
      }
      const remaining = new Set(e.cards), transfers = [];
      if (object(e.losing_map)) {
        for (const [key, value] of Object.entries(e.losing_map)) {
          const source = players().find(p => String(p.playerid) === key);
          if (!source) continue;
          const candidates = Array.isArray(value?.[0]) ? value[0] : [];
          const moved = candidates.filter(card => remaining.has(card));
          moved.forEach(card => remaining.delete(card));
          if (moved.length) transfers.push({ source, cards: moved });
        }
      }
      // losing_map proves this exact source/card partition. The observer knows
      // cards leaving their own zones even when the opponent's gain stays private.
      for (const item of transfers) emitMovement(e, 'transfer', person(item.source), person(item.source), receiver, item.cards, item.source === game.me);
      if (remaining.size) emitMovement(e, 'gain', receiver, null, receiver, [...remaining], publicWuguGain(e));
      return;
    }
    if (e.name !== 'lose' || !hasReceipt(e, 'lose') || !Array.isArray(e.cards)) return;
    movements.add(e);
    const loser = person(e.player), immediate = parent(e), ancestors = chain(immediate);
    if (!loser || !e.cards.length) return;
    // A gain owns both sides of a transfer. Card use and response already have
    // an operation row and must not acquire a duplicate generic loss row.
    if (e.type === 'gain' || ancestors.some(item => item.name === 'gain')) return;
    if ((immediate && ['discard', 'loseToDiscardpile'].includes(immediate.name)) || ['discard', 'loseToDiscardpile'].includes(e.type)) {
      emitMovement(e, 'discard', loser, loser, null, e.cards);
      return;
    }
    if (ancestors.some(item => item.name === 'useCard' || item.name === 'respond')) return;
    emitMovement(e, 'lose', loser, loser, null, e.cards);
  }
  function confirmSkill({ player, skill, targets, event }) {
    const raw = Array.isArray(skill) ? skill[0] : skill;
    if (typeof raw !== 'string' || hidden(player) || lib.skill?.[raw]?.hiddenSkill || !publicEvent(event) || event?.hidden || event?.cancelled || event?.result === 'cancelled' || event?.result?.bool === false) return;
    const name = canonicalSkill(raw);
    if (!name || lib.skill?.[name]?.hiddenSkill) return;
    // Native game.createTrigger names its scheduler event `trigger`; the
    // createTrigger identifier is only its content handler. Requiring the
    // production event shape avoids authorizing an extension's ordinary event.
    const triggerScheduler = event?.name === 'trigger' && event.player === player && event.skill === raw;
    // Native createTrigger publicly logs before constructing its content child.
    // Bind the receipt to this exact scheduler instance, actor and raw skill;
    // canonical ownership and temporal proximity cannot match another child.
    if (triggerScheduler) {
      if (event._cancelled || event.finished === true) return;
      if (seen.has(event) && !ended.has(event) && !triggerConfirmations.has(event)) triggerConfirmations.set(event, { player, raw, consumed: false });
      return;
    }
    let record = chain(event).map(x => operations.get(x)).find(x => x?.player === player && x.operation.kind === 'skill' && x.operation.id === name);
    if (!record) {
      // Some public secondary activations are intentionally performed inside
      // another skill's content without a new GameEvent. The structured native
      // logSkill call is the activation receipt; keep it distinct from the
      // enclosing skill instead of attributing its draw/effect to that owner.
      const enclosing = nearest(event), actor = person(player);
      if (!seen.has(event) || ended.has(event) || !enclosing?.emitted || !actor || enclosing.operation.kind !== 'skill' || enclosing.operation.id === name) return;
      let byActor = explicitSkills.get(event);
      if (!byActor) { byActor = new Map(); explicitSkills.set(event, byActor); }
      let byName = byActor.get(player);
      if (!byName) { byName = new Map(); byActor.set(player, byName); }
      record = byName.get(name);
      if (!record) {
        const list = visibleTargets(event) ? (Array.isArray(targets) ? targets : object(targets) ? [targets] : []).map(person).filter(Boolean) : [];
        record = { id: `jo${++operationSerial}`, event, player, actor, operation: { kind: 'skill', id: name, name, label: label(name) }, rawSkill: raw, targets: list, lastDeclared: JSON.stringify(list), batch: 0, emitted: false };
        byName.set(name, record);
      }
    }
    // The structured public logSkill invocation is an additional signal, never
    // parsed prose and never required for the other event capture paths.
    emit(record, 'logSkill', raw);
    if (visibleTargets(event)) {
      const list = (Array.isArray(targets) ? targets : object(targets) ? [targets] : []).map(person).filter(Boolean);
      targetUpdate(record, list, 'logSkill');
    }
    checkpoint(event);
  }
  function consumeTriggerConfirmation(e, raw) {
    const scheduler = parent(e), receipt = triggerConfirmations.get(scheduler);
    const nativeScheduler = scheduler?.name === 'trigger';
    if (!receipt || receipt.consumed || ended.has(scheduler) || !nativeScheduler || scheduler.skill !== raw || scheduler.player !== e.player || receipt.player !== e.player || receipt.raw !== raw || e.name !== raw) return false;
    if (scheduler.hidden || scheduler.cancelled || scheduler._cancelled || scheduler.finished === true || scheduler.result === 'cancelled' || scheduler.result?.bool === false || e.hidden || e.cancelled || e._cancelled || e.finished === true || !publicEvent(e)) return false;
    receipt.consumed = true;
    return true;
  }
  function begin(e) {
    checkpoint(parent(e)); sample();
    if (!object(e) || seen.has(e)) return;
    seen.add(e);
    eventContexts.set(e, eventContext(e));
    const actor = person(e.player);
    if (!actor) return;
    const targets = orderedTargets(e);
    function skillOperation(raw) {
      if (hidden(e.player) || e.hidden || !publicEvent(e) || typeof raw !== 'string' || !lib.skill?.[raw] || lib.skill[raw].hiddenSkill) return null;
      // `_recasting` is an engine-owned public phase-use action. It is the one
      // built-in underscore skill whose native useSkill event is player-facing;
      // `_chongzhu` is its deprecated alias.
      const builtinRecast = raw === '_recasting' || raw === '_chongzhu';
      const name = builtinRecast ? '_recasting' : canonicalSkill(raw);
      if (!name || lib.skill?.[name]?.hiddenSkill || !clean(lib.translate?.[name])) return null;
      return { kind: 'skill', id: name, name, label: label(name) };
    }
    function duplicateAncestor(operation) {
      // Only collapse an uninterrupted ancestor chain of this same public skill.
      const visited = new Set(); let ancestor = parent(e);
      while (ancestor && !visited.has(ancestor) && visited.size < 80) {
        visited.add(ancestor);
        const explicit = explicitSkills.get(ancestor)?.get(e.player)?.get(operation.id);
        if (explicit) return explicit.actor.id === actor.id ? explicit : null;
        const previous = operations.get(ancestor);
        if (previous) return previous.actor.id === actor.id && previous.operation.kind === 'skill' && previous.operation.id === operation.id ? previous : null;
        ancestor = parent(ancestor);
      }
      return null;
    }
    let operation, preconfirmed = false;
    if ((e.name === 'useCard' || e.name === 'respond') && typeof e.card?.name === 'string') {
      // Native useResult passes conversion skills straight into useCard/respond,
      // without creating a separate useSkill event. Record that explicit action.
      const conversion = skillOperation(e.skill);
      if (conversion) {
        const duplicate = duplicateAncestor(conversion);
        if (duplicate) { emit(duplicate, 'conversion', e.skill); materialOwners.set(e, duplicate); }
        else {
          const owner = { id: `jo${++operationSerial}`, event: e, player: e.player, actor, operation: conversion, targets, rawSkill: e.skill, emitted: false };
          emit(owner, 'conversion'); materialOwners.set(e, owner);
        }
      }
      operation = { kind: e.name === 'respond' ? 'respond' : 'card', id: e.card.name, ...cardInfo(e.card) };
    } else {
      // Scheduler/choice wrappers must not be promoted through their skill field.
      if (typeof e.name !== 'string' || /^(choose|trigger|arrangeTrigger|createTrigger)/.test(e.name) || hidden(e.player)) return;
      const raw = e.name === 'useSkill' ? e.skill : e.name;
      operation = skillOperation(raw);
      if (!operation) return;
      preconfirmed = consumeTriggerConfirmation(e, raw);
      const duplicate = duplicateAncestor(operation);
      if (duplicate) {
        // useSkill creates a same-skill content child. Collapse its activation,
        // but retain the event alias so late targets still reach that operation.
        operations.set(e, duplicate);
        if (preconfirmed) emit(duplicate, 'logSkill', raw);
        else if (e.name === 'useSkill') emit(duplicate, 'useSkill', raw);
        checkpoint(e);
        return;
      }
    }
    const raw = e.name === 'useSkill' ? e.skill : e.name;
    const record = { id: `jo${++operationSerial}`, event: e, player: e.player, actor, operation, rawSkill: operation.kind === 'skill' ? raw : undefined, targets, lastDeclared: JSON.stringify(targets), batch: 0, emitted: false };
    operations.set(e, record);
    targetStates.set(e, { lastTarget: e.target, hasLateTarget: false });
    const info = lib.skill?.[raw];
    // A public owner/group name establishes attribution, not activation.
    // Silent/internal aliases need observed public evidence just like direct skills.
    const deferred = info?.direct || info?.silent || info?.charlotte || info?.popup === false || info?.nopop || (operation.kind === 'skill' && operation.id !== raw);
    if (preconfirmed) emit(record, 'logSkill');
    else if (e.name === 'useSkill') emit(record, 'useSkill');
    else if (operation.kind !== 'skill' || !deferred) emit(record);
  }
  function logs({ since = committed } = {}) {
    sample();
    if (!Number.isSafeInteger(since) || since < 0 || since > seq) throw new RangeError('invalid journal cursor');
    const entries = rows.filter(row => row.seq > since);
    return JSON.parse(JSON.stringify({ epoch, source: 'eventflow', from: entries[0]?.seq ?? seq + 1, to: seq, entries, context: eventContext(), players: players().map(person), truncated: since < (rows[0]?.seq ?? 1) - 1, coverage: 'experimental_partial' }));
  }
  function validateCommit(to) {
    if (!Number.isSafeInteger(to) || to < committed || to > seq) throw new RangeError('invalid journal commit');
  }
  function commit(to) {
    validateCommit(to);
    committed = to;
  }
  sample();
  return { begin, finish, checkpoint, confirmSkill, reveal, materials, comparisonReveal, comparisonResult, sample, logs, commit, validateCommit };
}

module.exports = { createEventJournal };
