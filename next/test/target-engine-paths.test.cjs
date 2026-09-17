'use strict';
// GPL-3.0-only. These tests execute pinned original engine method excerpts in a
// minimal scheduler harness, not an installed/live game or full skill runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fixture = require('./fixtures/target-engine-paths/source-excerpts.json');
const { installFlow } = require('../src/flow.cjs');
const { createEventJournal } = require('../src/event-journal.cjs');
const source = id => fixture.excerpts.find(item => item.id === id).source;

function harness() {
  class Player {
    constructor(name) { Object.assign(this, { name, hp: 3, maxHp: 3, hujia: 0 }); }
    countCards() { return 2; }
    getCards() { return []; }
    isDead() { return false; }
  }
  const a = new Player('a'), b = new Player('b'), c = new Player('c');
  const history = [];
  const game = { players: [a, b, c], dead: [], me: a, getGlobalHistory: () => history };
  const lib = {
    config: {}, card: { jiedao: { singleCard: true } },
    skill: { distribute: { forced: true } },
    translate: { a: '甲', b: '乙', c: '丙', distribute: '分配', distribute_info: '公开分配技能', jiedao: '借刀杀人' },
  };
  const _status = { dying: [], globalHistory: [], pauseManager: { waitPause: async () => {} } };
  const stack = [];
  const manager = {
    setStatusEvent(event) { stack.push(event); _status.event = event; },
    popStatusEvent() { stack.pop(); _status.event = stack.at(-1); },
  };
  // The methods interpolated below are verbatim normalized source excerpts.
  // Constructor, trigger/skip stubs, queue insertion and finish are harness code.
  const GameEvent = new Function('game', 'lib', '_status', 'manager', `
    return class GameEvent {
      #start; #waitNext; #inContent = false;
      ${source('step')}
      constructor(name, player) {
        Object.assign(this, { name, player, manager, childEvents: [], next: [], after: [], finished: false, _triggered: null });
      }
      finish() { this.finished = true; }
      async checkSkipped() { return false; }
      async trigger() {}
      enqueue(child) { child.parent = this; this.next.push(child); return child; }
      ${source('start')}
      ${source('loop')}
      ${source('waitNext')}
      ${source('then')}
      ${source('forResult')}
    };
  `)(game, lib, _status, manager);
  // Original ArrayCompiler.compile; lifecycle hooks retain its updateStep
  // semantics but omit unrelated UI handlers and dead-player checks.
  const compiler = new Function(`return ({ ${source('arrayCompile')} });`)();
  compiler.beforeExecute = event => event.updateStep();
  compiler.afterExecute = event => event.updateStep();
  compiler.isPrevented = () => false;
  lib.element = { Player, GameEvent };
  const deps = { game, lib, _status, get: { plainText: x => x }, ui: { sidebar: { children: [] } } };
  const window = {};
  const api = new Function('window', 'deps', 'createJournal', `return (${installFlow.toString()})(deps, createJournal);`)(window, deps, createEventJournal);
  return { a, b, c, game, lib, api, GameEvent, compiler };
}

test('pinned engine excerpts retain their source hashes and GPL provenance', () => {
  assert.equal(fixture.license, 'GPL-3.0-only');
  for (const excerpt of fixture.excerpts) {
    assert.match(excerpt.fileSha256, /^[a-f0-9]{64}$/);
    assert.equal(createHash('sha256').update(excerpt.source).digest('hex'), excerpt.sourceSha256);
    assert.ok(excerpt.from > 0 && excerpt.to >= excerpt.from);
  }
});

test('official borrowed-sword singleCard split preserves ordered submission in the journal', async () => {
  const f = harness();
  assert.match(source('jiedao'), /singleCard: true/);
  assert.match(source('jiedao'), /targetprompt: \["被借刀", "出杀目标"\]/);
  const event = new f.GameEvent('useCard', f.a);
  event.card = { name: 'jiedao' };
  event.targets = [f.c, f.b];
  // Execute the original Player.useCard singleCard block, not its full method.
  new Function('next', 'info', source('singleCard'))(event, f.lib.card.jiedao);
  assert.deepEqual(event.targets, [f.c]);
  assert.deepEqual(event.addedTargets, [f.b]);
  event.content = async e => { e._targets.reverse(); e.targets.length = 0; e.finish(); };
  await event.start();
  const row = f.api.eventLogs().entries.find(item => item.kind === 'operation');
  assert.deepEqual(row.targets.map(person => person.name), ['c', 'b']);
  assert.equal(f.api.eventLogs().samplingErrors, 0);
});

for (const mode of ['compiled-step', 'async-forResult']) {
  test(`${mode}: real scheduler excerpts capture child targets before parent resumes and mutates them`, async () => {
    const f = harness();
    const parent = new f.GameEvent('distribute', f.a);
    let child, snapshotBeforeMutation;
    const enqueue = event => {
      child = new f.GameEvent('chooseTarget', f.a);
      child.content = async e => { e.result = { bool: true, targets: [f.c, f.b] }; e.finish(); };
      return event.enqueue(child);
    };
    const resumed = result => {
      snapshotBeforeMutation = f.api.eventLogs().entries.filter(row => row.kind === 'selection');
      assert.equal(snapshotBeforeMutation.length, 1, 'loop finish hook must precede parent continuation');
      assert.equal(result, child.result);
      result.targets.reverse();
      result.targets.length = 0;
    };
    if (mode === 'compiled-step') {
      // StepCompiler compiles old step bodies into ArrayCompiler arrays. This
      // feeds already-split step bodies; it does not run StepCompiler parsing.
      parent.content = f.compiler.compile([
        async event => { enqueue(event); },
        async (event, trigger, player, result) => { resumed(result); },
      ]);
    } else {
      parent.content = async event => { resumed(await enqueue(event).forResult()); event.finish(); };
    }
    await parent.start();
    const row = f.api.eventLogs().entries.find(item => item.kind === 'selection');
    assert.deepEqual(row.targets.map(person => person.name), ['c', 'b']);
    assert.deepEqual(row, snapshotBeforeMutation[0]);
    assert.equal(row.batch, 1);
    assert.equal(f.api.eventLogs().samplingErrors, 0);
  });
}
