'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createEventJournal } = require('../src/event-journal.cjs');
const { formatExperimental } = require('../src/experimental-format.cjs');

function fixture() {
  const player = name => ({ name, hp: 4, maxHp: 4, hujia: 0, getCards: () => [], countCards: () => 2 });
  const a = player('a'), b = player('b'), c = player('c'), players = [a, b, c];
  const args = { game: { me: a, players, dead: [] }, lib: { skill: {}, card: {}, translate: { a: '甲', b: '乙', c: '丙', sha: '杀', shan: '闪' } }, get: { itemtype: x => x?.physical ? 'card' : 'player' }, _status: {}, playerId: p => 'p' + (players.indexOf(p) + 1), canonicalSkill: x => x };
  const api = vm.runInNewContext(`(${createEventJournal.toString()})(args)`, { args });
  const card = (name, number) => ({ physical: true, name, suit: name === 'sha' ? 'spade' : 'heart', number });
  const make = (name = 'chooseToCompare', fields = {}) => { const e = { name, player: a, target: b, card1: card('sha', 3), card2: card('shan', 10), num1: 13, num2: 10, ...fields }; api.begin(e); return e; };
  const reveal = e => api.comparisonReveal({ event: e, player: e.player, card1: e.card1, target: e.compareWithCardPile ? e.player : e.target, card2: e.card2 });
  const result = (e, text = '胜', player = a) => api.comparisonResult({ event: e, player, text });
  const read = () => JSON.parse(JSON.stringify(api.logs()));
  return { a, b, c, api, args, card, make, reveal, result, read, rows: () => read().entries.filter(r => r.kind === 'compare') };
}

test('single compare records public faces separately from modified numbers and uses native winner over arithmetic', () => {
  const f = fixture(), e = f.make(); f.reveal(e);
  assert.equal(f.rows().length, 0, 'reveal is not a settled result');
  e.num1 = 1; e.num2 = 13; e.forceWinner = f.a; e.result = { bool: true, winner: f.a, num1: 1, num2: 13 };
  f.result(e); e.finished = true; f.api.finish(e); f.result(e);
  const rows = f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'win'); assert.equal(rows[0].winner.id, 'p1');
  assert.deepEqual(rows[0].participants.map(p => [p.card.number, p.number]), [[3, 1], [10, 13]]);
  const rendered = formatExperimental(f.read());
  assert.match(rendered, /甲 杀【♠3】（比较点数1）.*乙 闪【♥10】（比较点数13）.*甲胜/);
  assert.doesNotMatch(rendered, /\bp[123]\b/);
});

test('native tie, target victory and card-pile victory are distinct and do not require arithmetic inference', () => {
  const f = fixture();
  const e = f.make(); f.reveal(e); e.num1 = e.num2 = 7; e.result = { bool: false, tie: true }; f.result(e, '平');
  const loss = f.make(); f.reveal(loss); loss.forceWinner = f.b; loss.num1 = 13; loss.num2 = 1; loss.result = { bool: false, winner: f.b }; f.result(loss, '负');
  const pile = f.make('chooseToCompare', { target: 'cardPile', compareWithCardPile: true }); f.reveal(pile); pile.result = { bool: false }; f.result(pile, '负');
  assert.deepEqual(f.rows().map(r => [r.outcome, r.winner?.id ?? null]), [['tie', null], ['loss', 'p2'], ['loss', 'cardPile']]);
  assert.match(formatExperimental(f.read()), /平局/); assert.match(formatExperimental(f.read()), /牌堆.*胜/);
});

test('delayed original event never reveals stored cards; only its public effect can emit once', () => {
  const f = fixture(), original = f.make('chooseToCompare', { isDelay: true, finished: true, result: { bool: true, winner: f.a } });
  f.api.finish(original); assert.equal(f.rows().length, 0);
  const effect = f.make('chooseToCompareEffect', { parentEvent: original, card1: original.card1, card2: original.card2 });
  f.reveal(effect); effect.result = { bool: true, winner: f.a }; f.result(effect); effect.finished = true; f.api.finish(effect);
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].mode, 'delayed');
});

test('multiple rounds bind each public pair and retain force-winner and tie before native fields are cleared', () => {
  const f = fixture(), e = f.make('chooseToCompare', { iwhile: 0, targets: [f.c, f.b], target: f.c, result: { num1: [], num2: [] } });
  f.reveal(e); e.iiwhile = 0; delete e.iwhile; e.num1 = 2; e.num2 = 12; e.result.num1[0] = 2; e.result.num2[0] = 12; e.winner = f.a; e.forceWinner = f.a;
  f.result(e, '胜');
  delete e.winner; delete e.forceWinner; e.iwhile = 1; e.target = f.b; e.card2 = f.card('sha', 9); f.reveal(e);
  e.iiwhile = 1; delete e.iwhile; e.result.num1[1] = e.num1 = 9; e.result.num2[1] = e.num2 = 9;
  e.winner = f.a; // stale custom/native ancestor data must not turn a public tie into a win
  f.result(e, '平'); e.targets.reverse(); delete e.winner; e.finished = true; f.api.finish(e);
  const rows = f.rows(); assert.deepEqual(rows.map(r => [r.round, r.participants[1].player.id, r.outcome]), [[1, 'p3', 'win'], [2, 'p2', 'tie']]);
  assert.equal(rows[0].compareId, rows[1].compareId); assert.equal(rows[1].winner, null);
});

test('joint compare preserves target order and result number arrays, including a forced winner and no-unique-winner', () => {
  const f = fixture();
  for (const winner of [f.c, null]) {
    const e = f.make('chooseToCompareMeanwhile', { targets: [f.c, f.b], cardlist: [f.card('shan', 5), f.card('sha', 6)] });
    f.api.comparisonReveal({ event: e, player: f.a, card1: e.card1, targets: e.targets, cards: e.cardlist });
    e.result = { winner, num1: [13, 13], num2: [5, 6] }; e.tempplayer = f.a;
    f.result(e, '负'); assert.equal(f.rows().length, winner ? 0 : 1, 'not resolved while tempplayer exists');
    delete e.tempplayer; f.result(e, winner ? '胜' : '负', winner || f.a);
    e.finished = true; f.api.finish(e);
  }
  const rows = f.rows(); assert.deepEqual(rows[0].participants.map(p => p.player.id), ['p1', 'p3', 'p2']);
  assert.deepEqual(rows[0].participants[0].numbers, [13, 13]); assert.equal(rows[0].winner.id, 'p3'); assert.equal(rows[1].outcome, 'no_winner');
  assert.match(formatExperimental(f.read()), /共同拼点.*比较点数\[13,13\]/); assert.match(formatExperimental(f.read()), /无人拼点成功/);
});

test('hidden, cancelled, unobserved, wrong-owner and mismatched-face calls cannot emit private comparisons', () => {
  const f = fixture();
  for (const fields of [{ hidden: true }, { hideCards: true }, { cancelled: true }, { result: { cancelled: true } }, { parent: { hiddenSkill: true } }]) {
    const e = f.make('chooseToCompare', fields); f.reveal(e); e.result = { bool: true, winner: f.a }; f.result(e);
  }
  const hiddenCard = { physical: true, classList: { contains: x => x === 'infohidden' }, get name() { throw Error('private face'); } };
  const e = f.make('chooseToCompare', { card2: hiddenCard }); assert.doesNotThrow(() => f.reveal(e)); e.result = { bool: true, winner: f.a }; f.result(e);
  const wrong = f.make(); f.api.comparisonReveal({ event: wrong, player: f.b, card1: wrong.card1, target: wrong.target, card2: wrong.card2 }); wrong.result = { bool: true, winner: f.a }; f.result(wrong);
  const changed = f.make(); f.reveal(changed); changed.card2 = f.card('sha', 13); changed.result = { bool: true, winner: f.a }; f.result(changed);
  const fake = { ...f.make(), name: 'arbitrarySkill', result: { bool: true, winner: f.a } }; f.reveal(fake); f.result(fake);
  assert.deepEqual(f.rows(), []);
});

test('comparison rows remain immutable across cursor reads and results never backfill without public receipt', () => {
  const f = fixture(), e = f.make(); e.result = { bool: true, winner: f.a }; e.finished = true; f.api.finish(e);
  assert.equal(f.rows().length, 0);
  const shown = f.make(); f.reveal(shown); shown.result = { bool: true, winner: f.a }; f.result(shown);
  const first = f.read(); f.api.commit(first.to); shown.num1 = 99; shown.card1.number = 99; f.result(shown);
  assert.equal(f.read().entries.length, 0);
  const all = JSON.parse(JSON.stringify(f.api.logs({ since: 0 })));
  assert.deepEqual(all.entries, first.entries);
});

test('a popup from a nonparticipant cannot confirm a comparison even if result fields are populated', () => {
  const f = fixture(), e = f.make(); f.reveal(e); e.result = { bool: true, winner: f.a };
  f.result(e, '胜', f.c); assert.equal(f.rows().length, 0);
  f.result(e, '胜', f.a); assert.equal(f.rows().length, 1);
});

test('unrelated, empty or missing participant popup cannot freeze pending single or delayed results', () => {
  for (const mode of ['chooseToCompare', 'chooseToCompareEffect']) {
    const f = fixture(), e = f.make(mode); f.reveal(e);
    e.result = { bool: true, winner: f.a };
    for (const text of ['unrelated-skill-popup', '', undefined]) f.api.comparisonResult({ event: e, player: f.a, text });
    assert.equal(f.rows().length, 0);
    e.num1 = 1; e.num2 = 13; e.result = { bool: false, winner: f.b };
    f.result(e, '负'); assert.equal(f.rows().length, 1);
    assert.equal(f.rows()[0].outcome, 'loss'); assert.equal(f.rows()[0].winner.id, 'p2');
    assert.deepEqual(f.rows()[0].participants.map(p => p.number), [1, 13]);
  }
});

test('joint compare also ignores unrelated participant UI before the real result marker', () => {
  const f = fixture(), e = f.make('chooseToCompareMeanwhile', { targets: [f.b], cardlist: [f.card('shan', 10)] });
  f.api.comparisonReveal({ event: e, player: f.a, card1: e.card1, targets: e.targets, cards: e.cardlist });
  e.result = { winner: f.a, num1: [13], num2: [10] };
  for (const text of ['unrelated-skill-popup', '', undefined]) f.api.comparisonResult({ event: e, player: f.a, text });
  assert.equal(f.rows().length, 0);
  e.result.winner = f.b; f.result(e, '胜', f.b);
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].winner.id, 'p2');
});

test('normal event closure still confirms a public final result without an outcome popup', () => {
  const f = fixture(), e = f.make(); f.reveal(e);
  e.result = { bool: true, winner: f.a }; f.result(e, 'irrelevant');
  assert.equal(f.rows().length, 0);
  e.finished = true; f.api.finish(e);
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].outcome, 'win');
});
