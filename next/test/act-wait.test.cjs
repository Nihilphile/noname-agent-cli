'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitAfterAction, waitText } = require('../src/act-wait.cjs');

const snapshot = (state = 'running', n = 1) => ({ state, revision: `game:${n}`, log: { epoch: 'log', to: n, entries: [] }, experimentalLog: { epoch: 'journal', to: n, entries: [] } });
const action = state => ({ ok: true, action: { id: 'confirm' }, state });
function harness(initial, read) {
  let clock = 0, reads = 0;
  const sleeps = [];
  const adapter = { now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, observe: async () => read ? read(++reads, clock) : (reads++, snapshot()) };
  return { run: (options = {}) => waitAfterAction(initial, adapter, { seconds: 1, ...options }), sleeps, get reads() { return reads; }, get clock() { return clock; } };
}

test('an existing choice, death or game over returns immediately without any observation', async () => {
  for (const state of ['choice', 'dead', 'over']) {
    const original = action(snapshot(state));
    const h = harness(original, () => { throw Error('must not read'); });
    const result = await h.run();
    assert.equal(result.ok, true); assert.equal(result.action, original.action);
    assert.equal(result.wait.status, 'ready'); assert.equal(result.wait.reason, state);
    assert.equal(result.state, original.state); assert.equal(h.reads, 0); assert.deepEqual(h.sleeps, []);
  }
});

test('partial failures keep their original code and completed steps and never wait', async () => {
  const original = { ok: false, code: 'unexpected_choice', message: 'partial', completed: [{ step: 'steps[0]' }], branches: ['then'], stoppedAt: 'steps[1]', state: snapshot() };
  const h = harness(original);
  const result = await h.run();
  for (const key of ['ok', 'code', 'message', 'completed', 'branches', 'stoppedAt', 'state']) assert.equal(result[key], original[key]);
  assert.equal(result.wait.status, 'skipped'); assert.equal(h.reads, 0); assert.deepEqual(h.sleeps, []);
});

test('running waits read-only until choice, death or game over and keeps the complete last snapshot', async () => {
  for (const state of ['choice', 'dead', 'over']) {
    const final = { ...snapshot(state, 3), result: { outcome: state }, log: { epoch: 'log', from: 1, to: 3, truncated: true, entries: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] } };
    const h = harness(action(snapshot()), n => n === 1 ? snapshot('running', 2) : final);
    const result = await h.run();
    assert.equal(result.state, final); assert.equal(result.wait.status, 'ready'); assert.equal(result.stateFresh, true);
    assert.equal(result.actionOutcome, 'completed'); assert.equal(h.reads, 2); assert.deepEqual(h.sleeps, [250]);
    assert.equal(result.state.log.truncated, true);
  }
});

test('timeout confirms once after the final sleep and returns a decision arriving on that boundary', async () => {
  const h = harness(action(snapshot()), (_n, clock) => snapshot(clock >= 1000 ? 'choice' : 'running', clock + 1));
  const result = await h.run();
  assert.equal(result.wait.status, 'ready'); assert.equal(result.state.state, 'choice');
  assert.equal(h.clock, 1000); assert.equal(h.reads, 5); assert.deepEqual(h.sleeps, [250, 250, 250, 250]);
});

test('normal timeout is successful action feedback with freshly confirmed running state', async () => {
  const original = action(snapshot());
  const h = harness(original, n => snapshot('running', n + 1));
  const result = await h.run({ pollMs: 350 });
  assert.equal(result.ok, true); assert.equal(result.action, original.action); assert.equal(result.wait.status, 'timeout');
  assert.equal(result.stateFresh, true); assert.equal(result.state.revision, 'game:5');
  assert.deepEqual(h.sleeps, [350, 350, 300]); assert.equal(h.clock, 1000);
  assert.match(waitText(result.wait), /动作已完成.*等待超时.*running/);
});

test('failed observation retains the last confirmed state and successful action without claiming freshness', async () => {
  const confirmed = snapshot('running', 2), original = action(snapshot());
  const h = harness(original, n => { if (n === 1) return confirmed; throw Error('connection closed'); });
  const result = await h.run();
  assert.equal(result.ok, false); assert.equal(result.code, 'wait_observation_failed'); assert.match(result.message, /connection closed/);
  assert.equal(result.action, original.action); assert.equal(result.actionOutcome, 'completed');
  assert.equal(result.state, confirmed); assert.equal(result.stateFresh, false); assert.equal(result.wait.status, 'error');
});

test('agent, native log and journal epoch changes all stop without returning another game as current', async () => {
  for (const changed of [{ revision: 'other:1' }, { log: { epoch: 'other' } }, { experimentalLog: { epoch: 'other' } }]) {
    const original = action(snapshot());
    const h = harness(original, () => ({ ...snapshot('choice', 2), ...changed }));
    const result = await h.run();
    assert.equal(result.code, 'session_changed'); assert.equal(result.state, original.state);
    assert.equal(result.actionOutcome, 'completed'); assert.equal(result.stateFresh, false); assert.equal(h.reads, 1);
  }
});

test('invalid setup state and hung reads are errors, never normal running timeouts', async () => {
  const setup = harness(action(snapshot()), () => snapshot('setup'));
  assert.equal((await setup.run()).code, 'wait_observation_failed');
  const hung = harness(action(snapshot()), () => new Promise(() => {}));
  const result = await hung.run({ readTimeoutMs: 10 });
  assert.equal(result.code, 'wait_observation_failed'); assert.equal(result.stateFresh, false);
  assert.equal(hung.reads, 1); assert.deepEqual(hung.sleeps, []);
});

test('final confirmation failure preserves the action and does not claim timeout success', async () => {
  const h = harness(action(snapshot()), (_n, clock) => { if (clock >= 1000) throw Error('final read failed'); return snapshot(); });
  const result = await h.run();
  assert.equal(result.wait.status, 'error'); assert.equal(result.actionOutcome, 'completed'); assert.equal(result.stateFresh, false);
});
