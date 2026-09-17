'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlay, executePlay } = require('../src/play.cjs');

const card = { id: 'c1', name: 'sha', label: '杀', suit: 'heart', number: 8 };
function state(options, extra = {}) {
  return {
    state: 'choice', revision: 'epoch:1', phase: 'phaseUse', phaseId: 'phase1', actor: 'p1',
    me: { id: 'p1', hand: [card] }, players: [{ id: 'p2', label: '乙', name: 'other' }],
    choice: { id: 'e1', decisionId: 'epoch:e1:1', event: 'chooseToUse', constraints: {},
      context: { actor: 'p1', skill: null, sourceAction: null, certainty: 'known' }, options },
    ...extra,
  };
}
const button = id => ({ id, kind: 'button', label: id });
function harness(states, throwing = false) {
  let index = 0;
  const calls = [];
  return { calls, adapter: {
    async observe() { return structuredClone(states[index]); },
    async effects() { return { epoch: 'flow', actions: [] }; },
    async sleep() {},
    async act(request) {
      calls.push(request);
      if (throwing) throw Error('connection lost after dispatch');
      index = Math.min(index + 1, states.length - 1);
      return { ok: true, action: { id: request.id }, state: structuredClone(states[index]) };
    },
  } };
}
const execute = (text, h) => executePlay(parsePlay(text), h.adapter, { at: 'epoch:1', intervalMs: 0, timeoutMs: 1000 });

test('a missing raw option in the same interaction is 0 and the next pipe group still runs', async () => {
  const h = harness([state([button('b1')]), state([button('b3')]), state([])]);
  const result = await execute('act(b1) > act(missing) > act(skipped) | act(b3)', h);
  assert.deepEqual(h.calls.map(call => call.id), ['b1', 'b3']);
  assert.deepEqual(result.steps.map(step => step.value), [1, 0, null, 1]);
  assert.equal(result.steps[2].status, 'skipped');
  assert.equal(result.value, 0);
});

test('an event reused with a fresh decision generation does not authorize its generic confirm', async () => {
  const first = state([button('b1')]);
  const next = state([{ id: 'ok2', kind: 'confirm', label: '确认' }]);
  next.revision = 'epoch:2'; next.choice.decisionId = 'epoch:e1:2';
  const h = harness([first, next, state([])]);
  const result = await execute('act(b1) > act(confirm)', h);
  assert.deepEqual(h.calls.map(call => call.id), ['b1']);
  assert.equal(result.code, 'unexpected_choice');
});

test('a card wrapper stops at an intervening skill choice before clicking its confirmation', async () => {
  const first = state([{ id: 'c1', kind: 'card', label: '杀', card }]);
  const popup = state([{ id: 'ok2', kind: 'confirm', label: '发动其他技能' }]);
  popup.revision = 'epoch:2'; popup.choice.id = 'e2'; popup.choice.decisionId = 'epoch:e2:1';
  popup.choice.context.skill = 'intervening_skill'; popup.choice.event = 'chooseBool';
  const h = harness([first, popup, state([])]);
  const result = await execute('杀', h);
  assert.deepEqual(h.calls.map(call => call.id), ['c1']);
  assert.equal(result.code, 'unexpected_choice');
});

test('uncertain transport outcomes mark feedback stale so the CLI cannot acknowledge or commit old state', async () => {
  const h = harness([state([button('b1')])], true);
  const result = await execute('act(b1) | act(b2)', h);
  assert.equal(result.code, 'result_unknown');
  assert.equal(result.stateFresh, false);
  assert.equal(h.calls.length, 1);
});
