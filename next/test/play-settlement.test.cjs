'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installFlow } = require('../src/flow.cjs');
const { executePlay } = require('../src/play.cjs');

// Exercise real flow receipts and the real play executor together. The UI
// adapter models only the boundary between a submitted card and its next turn
// choice; the event promise remains alive after finish(), as in native loop().
function fixture(mode = 'passive') {
  class GameEvent {
    constructor(name, props) { Object.assign(this, { name, finished: false }, props); }
    async loop() { await this.run?.(); this.finished = true; }
  }
  const self = {}, other = {}, material = { name: 'jiu' };
  const args = { lib: { element: { GameEvent }, skill: {}, translate: {} },
    game: { me: self, players: [self, other], dead: [] }, ui: {}, get: {},
    _status: { globalHistory: [{ everything: [] }] } };
  const flow = vm.runInNewContext(`(${installFlow.toString()})(args)`, { window: {}, args });
  flow.setCardIdentityResolver(card => card === material ? 'wine' : null);
  const selfId = flow.playerId(self), otherId = flow.playerId(other);
  const card = { id: 'wine', name: 'jiu', label: '酒', suit: 'spade', number: 9, selectable: true };
  let stage = 'start', revision = 1, release, running, event, firstRead = false;
  const requests = [], samples = [];
  const state = () => ({ state: stage === 'waiting' ? 'running' : 'choice', revision: `epoch:${revision}`,
    phase: 'phaseUse', phaseId: 'phase-1', actor: selfId,
    me: { id: selfId, hand: stage === 'start' ? [card] : [] }, players: [{ id: otherId }],
    choice: stage === 'waiting' ? null : { id: stage, decisionId: stage, event: stage === 'prompt' ? 'chooseCard' : 'chooseToUse',
      context: { certainty: 'known', actor: selfId, skill: stage === 'prompt' ? 'give_or_cancel' : null, sourceAction: null },
      options: stage === 'start' ? [{ id: 'wine', kind: 'card', card }] : stage === 'prompt' ? [{ id: 'decline', kind: 'cancel' }] : [{ id: 'end', kind: 'control', label: '结束回合' }],
    },
  });
  const adapter = {
    async observe() { return state(); },
    async effects() {
      const result = JSON.parse(JSON.stringify(flow.effects()));
      if (stage === 'waiting') { firstRead = true; samples.push(result.actions[0]?.status); }
      return result;
    },
    async act(request) {
      requests.push(request.id);
      if (request.id === 'wine') {
        stage = 'waiting'; revision++;
        const gate = new Promise(resolve => { release = resolve; });
        event = new GameEvent('useCard', { player: self, card: material, cards: [material], targets: [self],
          async run() { this.finished = true; await gate; if (mode === 'failure') throw Error('actual engine failure'); },
        });
        args._status.globalHistory[0].everything.push(event);
        running = event.loop();
        // Capture rejections while leaving the original promise visible to flow.
        running.catch(() => {});
        if (mode === 'failure') { release(); await running.catch(() => {}); }
      } else { assert.equal(request.id, 'end'); assert.equal(stage, 'next', 'never act while another player is resolving'); revision++; }
      return { ok: true, action: { id: request.id } };
    },
    async sleep() {
      if (stage !== 'waiting' || !firstRead) return;
      if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'prompt') { stage = 'prompt'; revision++; return; }
      release(); await running; stage = 'next'; revision++;
    },
  };
  return { requests, samples, adapter, async close() { release?.(); await running?.catch(() => {}); } };
}

test('play waits through finished-but-running passive settlement and continues without replay', async () => {
  const f = fixture();
  try {
    const out = await executePlay('酒 > 结束出牌', f.adapter, { at: 'epoch:1', intervalMs: 0 });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(f.requests, ['wine', 'end']);
    assert.deepEqual(out.steps.map(step => step.status), ['completed', 'completed']);
    assert.ok(f.samples.includes('pending'));
  } finally { await f.close(); }
});

test('a new self response during pending settlement stops the suffix without cancelling the response', async () => {
  const f = fixture('prompt');
  try {
    const out = await executePlay('酒 > 结束出牌', f.adapter, { at: 'epoch:1', intervalMs: 0 });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'unexpected_choice');
    assert.deepEqual(f.requests, ['wine']);
    assert.equal(out.steps[0].submission.targets.length, 1);
    assert.equal(out.remaining, '结束出牌');
  } finally { await f.close(); }
});

test('actual card loop failure remains unknown and never executes a suffix', async () => {
  const f = fixture('failure');
  try {
    const out = await executePlay('酒 > 结束出牌', f.adapter, { at: 'epoch:1', intervalMs: 0 });
    assert.equal(out.code, 'result_unknown');
    assert.deepEqual(f.requests, ['wine']);
    assert.equal(out.remaining, '结束出牌');
  } finally { await f.close(); }
});

test('waiting deadline preserves the submitted card and never replays or executes the suffix', async () => {
  const f = fixture('timeout');
  try {
    const out = await executePlay('酒 > 结束出牌', f.adapter, { at: 'epoch:1', intervalMs: 0, timeoutMs: 30 });
    assert.equal(out.code, 'timeout');
    assert.deepEqual(f.requests, ['wine']);
    assert.equal(out.steps[0].status, 'completed');
    assert.ok(out.steps[0].submission.actionId);
    assert.equal(out.remaining, '结束出牌');
  } finally { await f.close(); }
});
