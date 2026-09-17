'use strict';
// Read-only local-engine contract probe: exact Player.chooseToCompare factory
// and complete native comparison step arrays, with a small step/goto runner.
// UI animation, card selection, triggers and zone movement are stubbed. This
// is not a real game, full engine scheduler test, or live-client acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installFlow } = require('../src/flow.cjs');
const { createEventJournal } = require('../src/event-journal.cjs');
const { formatExperimental } = require('../src/experimental-format.cjs');
const { DEFAULT_SOURCE } = require('../src/native-session.cjs');
const engineDir = process.env.NONAME_NATIVE_ELEMENT_DIR || path.join(DEFAULT_SOURCE, 'noname', 'library', 'element');
const available = fs.existsSync(path.join(engineDir, 'content.js')) && fs.existsSync(path.join(engineDir, 'player.js'));
function between(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `native source boundary changed: ${start}`);
  return source.slice(from, to);
}
function fixture() {
  const source = fs.readFileSync(path.join(engineDir, 'content.js'), 'utf8');
  const playerSource = fs.readFileSync(path.join(engineDir, 'player.js'), 'utf8');
  const calls = [], _status = {}, ui = { sidebar: { children: [] }, clear() {}, arena: { classList: { add() {}, remove() {} } } };
  const lib = { element: {}, card: {}, skill: {}, filter: { all: () => true }, sort: { seat: (a, b) => a.seat - b.seat }, config: {}, translate: { a: '甲', b: '乙', c: '丙', sha: '杀', shan: '闪' } };
  const get = { plainText: x => x, itemtype: x => x?.physical ? 'card' : x?.isPlayer ? 'player' : null, number: c => c.number, translation: x => lib.translate[x?.name] || String(x) };
  let pileCard = { physical: true, name: 'shan', suit: 'heart', number: 13 };
  get.cards = get.bottomCards = () => [pileCard];
  const game = { players: [], dead: [], log() {}, addVideo() {}, broadcastAll() {}, async delay() {}, async delayx() {},
    cardsGotoOrdering: cards => ({ cards }), cardsGotoSpecial() {},
    loseAsync: () => ({ setContent() {} }), async doAsyncInOrder(cards, fn) { for (let i = 0; i < cards.length; i++) await fn(cards[i], i); } };
  const context = vm.createContext({ game, lib, get, ui, _status, window: {}, setTimeout() { throw Error('UI timers should be stubbed'); } });
  vm.runInContext(`Array.prototype.add=function(x){if(!this.includes(x))this.push(x);return this};Array.prototype.addArray=function(xs){for(const x of xs)this.add(x);return this};Array.prototype.remove=function(x){const i=this.indexOf(x);if(i>=0)this.splice(i,1);return this};`, context);
  const content = vm.runInContext(`({${between(source, '  chooseToCompareMeanwhile: [', '  async chooseSkill(event, trigger, player) {')}})`, context);
  class GameEvent {
    constructor(name, props = {}) { Object.assign(this, { name, finished: false }, props); }
    setContent(name) { this.contentName = name; return this; }
    finish() { this.finished = true; }
    untrigger() {}
    goto(index) { this.nextStep = index; }
    trigger(name) { calls.push({ trigger: name }); this.onTrigger?.(name, this); return Promise.resolve(); }
    async loop() {
      const steps = content[this.contentName || this.name];
      assert.ok(Array.isArray(steps));
      let iterations = 0;
      for (let index = 0; index < steps.length && !this.finished;) {
        assert.ok(++iterations < 100, 'bounded exact-step runner');
        this.step = index; this.nextStep = null;
        await steps[index](this, null, this.player, this.selectionResult || []);
        index = this.nextStep ?? index + 1;
      }
      this.finished = true;
    }
  }
  const compareReturn = {}, popupReturn = Promise.resolve('original-popup');
  class Player {
    constructor(name, seat) { Object.assign(this, { name, seat, playerid: name, isPlayer: true, hp: 4, maxHp: 4, hujia: 0, ai: { shown: 1 }, handCount: 1 }); }
    countCards() { return this.handCount; }
    getCards() { return []; }
    $compare(...args) { calls.push({ method: '$compare', player: this, args }); if (this.throwCompare) throw this.throwCompare; return compareReturn; }
    $compareMultiple(...args) { calls.push({ method: '$compareMultiple', player: this, args }); return compareReturn; }
    popup(...args) { calls.push({ method: 'popup', player: this, args }); return popupReturn; }
    addTempClass() {}
    line() {}
    showCards() { return { set() { return this; } }; }
    $giveAuto() {}
    when() { return { assign() { return this; }, filter() { return this; }, step() { return this; } }; }
  }
  Player.prototype.chooseToCompare = vm.runInContext(`({${between(playerSource, '  chooseToCompare(targetOrTargets, check) {', '\n  /**')}}).chooseToCompare`, context);
  lib.element = { Player, GameEvent };
  game.createEvent = name => { calls.push({ createEvent: name }); return new GameEvent(name); };
  const a = new Player('a', 1), b = new Player('b', 2), c = new Player('c', 3); game.players = [a, b, c]; game.me = a;
  context.deps = { game, lib, get, ui, _status };
  const api = vm.runInContext(`(${installFlow.toString()})(deps,(${createEventJournal.toString()}))`, context);
  const card = (number, name = 'sha') => ({ physical: true, name, suit: name === 'sha' ? 'spade' : 'heart', number });
  const fixed = (event, cards = [card(3), card(10, 'shan'), card(7)]) => Object.assign(event, { fixedResult: { a: cards[0], b: cards[1], c: cards[2] } });
  const run = async event => { const old = _status.event; _status.event = event; try { await event.loop(); } finally { _status.event = old; } return event; };
  const read = () => JSON.parse(JSON.stringify(api.eventLogs()));
  return { api, a, b, c, game, lib, get, _status, calls, card, fixed, run, read, rows: () => read().entries.filter(r => r.kind === 'compare'), GameEvent, compareReturn, popupReturn, setPile: card => { pileCard = card; } };
}

test('native factory and exact single steps record post-fixing values and forceWinner, without native log parsing', { skip: !available }, async () => {
  const f = fixture(), e = f.fixed(f.a.chooseToCompare(f.b));
  e.onTrigger = (name, event) => { if (name === 'compare') event.num1 = 12; if (name === 'compareFixing') { event.num1 = 1; event.forceWinner = f.a; } };
  await f.run(e);
  assert.equal(e.result.num1, 12, 'native result copied before compareFixing');
  const rows = f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'win');
  assert.deepEqual(rows[0].participants.map(p => [p.card.number, p.number]), [[3, 1], [10, 10]]);
  assert.equal(rows[0].winner.name, 'a'); assert.equal(f.read().samplingErrors, 0);
  const rendered = formatExperimental(f.read());
  assert.match(rendered, /甲 杀【♠3】（比较点数1）.*乙 闪【♥10】（比较点数10）.*甲胜/);
  assert.doesNotMatch(rendered, /fp\d+/);
});

test('native single tied points with forced target victory are a loss, ordinary tie is a tie, pile is not self', { skip: !available }, async () => {
  const f = fixture();
  for (const force of [f.b, null]) {
    const e = f.fixed(f.a.chooseToCompare(f.b), [f.card(8), f.card(8)]);
    e.onTrigger = (name, event) => { if (name === 'compareFixing' && force) event.forceWinner = force; };
    await f.run(e);
  }
  const pile = f.fixed(f.a.chooseToCompare('cardPile')); await f.run(pile);
  assert.deepEqual(f.rows().map(r => r.outcome), ['loss', 'tie', 'loss']);
  assert.equal(f.rows()[2].participants[1].player.id, 'cardPile'); assert.equal(f.rows()[2].winner.id, 'cardPile');
  assert.equal(f.read().samplingErrors, 0);
});

test('native Multiple keeps chooseToCompare name and emits ordered forced/tied rounds even without callback', { skip: !available }, async () => {
  const f = fixture(), e = f.fixed(f.a.chooseToCompare([f.c, f.b])); e.multitarget = true;
  assert.equal(e.name, 'chooseToCompare'); assert.equal(e.contentName, 'chooseToCompareMultiple');
  e.onTrigger = (name, event) => { if (name === 'compareFixing') { event.num1 = 1; event.num2 = 1; if (event.iiwhile === 0) event.forceWinner = f.c; } };
  await f.run(e);
  const rows = f.rows(); assert.deepEqual(rows.map(r => [r.round, r.participants[1].player.name, r.outcome]), [[1, 'c', 'loss'], [2, 'b', 'tie']]);
  assert.equal(e.winner, undefined); assert.equal(e.forceWinner, undefined);
  assert.equal(f.calls.some(c => c.createEvent === 'compareMultiple'), false); assert.equal(f.read().samplingErrors, 0);
});

test('native seat-sorted multiple preserves actual revealed pairing instead of requested target order', { skip: !available }, async () => {
  const f = fixture(), e = f.fixed(f.a.chooseToCompare([f.c, f.b]));
  await f.run(e);
  assert.deepEqual(f.rows().map(r => [r.participants[1].player.name, r.participants[1].card.number]), [['b', 10], ['c', 7]]);
});

test('native Meanwhile exposes one global result, preserving all number arrays and a forced non-max winner', { skip: !available }, async () => {
  const f = fixture(), e = f.fixed(f.a.chooseToCompare([f.c, f.b]), [f.card(13), f.card(12), f.card(1)]);
  e.setContent('chooseToCompareMeanwhile'); e.multitarget = true;
  e.onTrigger = (name, event) => { if (name === 'compareFixing') event.forceWinner = f.c; };
  await f.run(e);
  const rows = f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].mode, 'meanwhile');
  assert.deepEqual(rows[0].participants.map(p => p.player.name), ['a', 'c', 'b']);
  assert.deepEqual(rows[0].participants[0].numbers, [13, 13]); assert.equal(rows[0].winner.name, 'c');
  assert.equal(f.read().samplingErrors, 0);
});

test('native Meanwhile with a shared maximum reports no winner rather than per-pair victories', { skip: !available }, async () => {
  const f = fixture(), e = f.fixed(f.a.chooseToCompare([f.b, f.c]), [f.card(13), f.card(13), f.card(2)]);
  e.setContent('chooseToCompareMeanwhile'); await f.run(e);
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].outcome, 'no_winner'); assert.equal(f.rows()[0].winner, null);
});

test('native delayed first closure stays private, effect reveals once, destroyed effect and cancellation emit nothing', { skip: !available }, async () => {
  const f = fixture(), e = f.fixed(f.a.chooseToCompare(f.b)); e.isDelay = true;
  await f.run(e); assert.equal(f.rows().length, 0);
  assert.equal(f.calls.some(c => c.method === '$compare'), false);
  const effect = new f.GameEvent('chooseToCompareEffect', { player: f.a, parentEvent: e });
  await f.run(effect); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].mode, 'delayed');
  e.isDestoryed = true;
  await f.run(new f.GameEvent('chooseToCompareEffect', { player: f.a, parentEvent: e })); assert.equal(f.rows().length, 1);
  f.a.handCount = 0; await f.run(f.a.chooseToCompare(f.b)); assert.equal(f.rows().length, 1);
  assert.equal(f.read().samplingErrors, 0);
});

test('flow public hooks preserve receiver, arguments, exact returns and exceptions and reject unrelated events', { skip: !available }, () => {
  const f = fixture(), card1 = f.card(3), card2 = f.card(7);
  f._status.event = { name: 'arbitrarySkill', player: f.a, target: f.b, card1, card2, num1: 3, num2: 7, result: { bool: true, winner: f.a } };
  assert.equal(f.a.$compare(card1, f.b, card2), f.compareReturn);
  assert.equal(f.a.popup('胜', 'water'), f.popupReturn);
  assert.equal(f.calls[0].player, f.a); assert.deepEqual(f.calls[0].args, [card1, f.b, card2]);
  const thrown = Error('original animation failed'); f.a.throwCompare = thrown;
  assert.throws(() => f.a.$compare(card1, f.b, card2), error => error === thrown);
  assert.equal(f.rows().length, 0); assert.equal(f.read().samplingErrors, 0);
});
