'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlay, executePlay } = require('../src/play.cjs');

const me = { id: 'me', name: 'hero', label: '自己', hand: [], equipment: [], judgments: [] };
function normalChoice(revision = 'game:1', phaseId = 'game:phaseUse:one', options = []) {
  return { state: 'choice', revision, phase: 'phaseUse', phaseId, actor: 'me', me: { ...me }, players: [],
    choice: { id: `choice-${revision}`, decisionId: `decision-${revision}`, event: 'chooseToUse', constraints: {},
      context: { certainty: 'known', actor: 'me', skill: null, sourceAction: null }, options } };
}
function running(revision, phaseId) {
  return { state: 'running', revision, phase: 'phaseJieshu', phaseId, actor: 'me', me: { ...me }, players: [], choice: null };
}
function harness(initial, after, effectValues = [{ epoch: 'effects', actions: [] }]) {
  let current = initial, actions = 0, sleeps = 0, observations = 0, samples = 0;
  return {
    adapter: {
      async observe() { observations++; if (actions) current = after; return current; },
      async act(request) { actions++; return { ok: true, action: { id: request.id, kind: current.choice?.options.find(x => x.id === request.id)?.kind, label: request.id }, state: current }; },
      async effects() { return effectValues[Math.min(samples++, effectValues.length - 1)]; },
      async sleep(ms) { sleeps += ms; },
    },
    counts: () => ({ actions, sleeps, observations, samples }),
  };
}

test('deferFinalWait completes an accepted final raw action across a phase change after the normal animation settle', async () => {
  const first = normalChoice('game:1', 'game:phaseUse:one', [{ id: 'end', kind: 'button', label: '结束' }]);
  const next = running('game:2', 'game:phaseJieshu:two');
  const f = harness(first, next);
  const result = await executePlay(parsePlay('act(end)'), f.adapter, { at: 'game:1', timeoutMs: 2000, intervalMs: 500, deferFinalWait: true });
  assert.equal(result.status, 'completed'); assert.equal(result.value, 1); assert.equal(result.state, next);
  assert.deepEqual(result.steps.map(x => [x.status, x.value]), [['completed', 1]]);
  assert.deepEqual(f.counts(), { actions: 1, sleeps: 500, observations: 2, samples: 2 });
});

test('without deferFinalWait the same final phase change retains the existing paused result', async () => {
  const first = normalChoice('game:1', 'game:phaseUse:one', [{ id: 'end', kind: 'button', label: '结束' }]);
  const f = harness(first, running('game:2', 'game:phaseJieshu:two'));
  const result = await executePlay(parsePlay('act(end)'), f.adapter, { at: 'game:1', timeoutMs: 2000, intervalMs: 0 });
  assert.equal(result.status, 'paused'); assert.equal(result.value, null); assert.equal(result.code, 'phase_changed');
  assert.deepEqual(result.steps.map(x => [x.status, x.value]), [['completed', 1]]);
});

test('deferFinalWait never relaxes the phase guard when another plan step remains', async () => {
  const first = normalChoice('game:1', 'game:phaseUse:one', [{ id: 'end', kind: 'button', label: '结束' }]);
  const f = harness(first, running('game:2', 'game:phaseJieshu:two'));
  const result = await executePlay(parsePlay('act(end) > act(next)'), f.adapter, { at: 'game:1', timeoutMs: 2000, intervalMs: 0, deferFinalWait: true });
  assert.equal(result.status, 'paused'); assert.equal(result.code, 'phase_changed'); assert.equal(result.remaining, 'act(next)');
  assert.equal(f.counts().actions, 1);
});

test('deferFinalWait hands an inserted final choice to the caller only after the raw action succeeds', async () => {
  const first = normalChoice('game:1', 'game:phaseUse:one', [{ id: 'skill', kind: 'skill', skill: 'bound', contextSkillCanonical: 'bound', label: '技能' }]);
  const inserted = { ...normalChoice('game:2', 'game:phaseUse:one', [{ id: 'confirm', kind: 'confirm', label: '确定' }]),
    choice: { id: 'inserted', decisionId: 'inserted', event: 'chooseBool', constraints: {},
      context: { certainty: 'known', actor: 'me', skill: 'bound', sourceAction: 'action-1' }, options: [{ id: 'confirm', kind: 'confirm', label: '确定' }] } };
  const f = harness(first, inserted, [{ epoch: 'effects', actions: [] }, { epoch: 'effects', actions: [{ id: 'action-1', kind: 'skill', actor: 'me', name: 'bound', status: 'pending' }] }]);
  const result = await executePlay(parsePlay('act(skill)'), f.adapter, { at: 'game:1', timeoutMs: 2000, intervalMs: 0, deferFinalWait: true });
  assert.equal(result.status, 'completed'); assert.equal(result.state.choice.id, 'inserted');

  const failed = await executePlay(parsePlay('act(missing)'), harness(first, first).adapter,
    { at: 'game:1', timeoutMs: 2000, intervalMs: 0, deferFinalWait: true });
  assert.equal(failed.status, 'failed'); assert.equal(failed.value, 0); assert.equal(failed.code, undefined);
  assert.equal(failed.steps[0].code, 'option_unavailable');
});

test('deferFinalWait returns an overall failure immediately when a later pipe group succeeds into running', async () => {
  const first = normalChoice('game:1', 'game:phaseUse:one', [{ id: 'b1', kind: 'button', label: '执行' }]);
  const next = { ...running('game:2', 'game:phaseUse:one'), phase: 'phaseUse' };
  const f = harness(first, next);
  const result = await executePlay(parsePlay('act(missing) | act(b1)'), f.adapter,
    { at: 'game:1', timeoutMs: 30, intervalMs: 0, deferFinalWait: true });
  assert.equal(result.status, 'failed'); assert.equal(result.value, 0); assert.equal(result.ok, false);
  assert.equal(result.state, next); assert.equal(result.stateFresh, true); assert.equal(result.remaining, '');
  assert.deepEqual(result.steps.map(x => [x.status, x.value]), [['failed', 0], ['completed', 1]]);
  assert.deepEqual(f.counts(), { actions: 1, sleeps: 0, observations: 2, samples: 2 });
});

test('a final card wrapper may cross phase only when its exact entity receipt is confirmed', async () => {
  const card = { id: 'c1', name: 'sha', label: '杀', suit: 'spade', number: 7 };
  const first = normalChoice('game:1', 'game:phaseUse:one', [{ id: 'c1', kind: 'card', label: '杀', card }]);
  first.me.hand = [card];
  const next = running('game:2', 'game:phaseJieshu:two');
  const receipt = { id: 'fa1', kind: 'card', actor: 'me', name: 'sha', physicalMode: 'direct', physicalCards: ['c1'], targets: [], status: 'completed' };
  const f = harness(first, next, [{ epoch: 'effects', actions: [] }, { epoch: 'effects', actions: [receipt] }]);
  const result = await executePlay(parsePlay('c1'), f.adapter, { at: 'game:1', timeoutMs: 2000, intervalMs: 0, deferFinalWait: true });
  assert.equal(result.status, 'completed'); assert.equal(result.steps[0].receipt, 'fa1'); assert.equal(result.state, next);

  const missing = harness(first, next);
  const unknown = await executePlay(parsePlay('c1'), missing.adapter, { at: 'game:1', timeoutMs: 30, intervalMs: 0, deferFinalWait: true });
  assert.equal(unknown.status, 'paused'); assert.equal(unknown.value, null); assert.equal(unknown.code, 'timeout');
  assert.equal(unknown.stateFresh, false); assert.equal(unknown.steps[0].value, null);
});

test('final handoff still rejects an effects epoch change', async () => {
  const first = normalChoice('game:1', 'game:phaseUse:one', [{ id: 'end', kind: 'button', label: '结束' }]);
  const f = harness(first, running('game:2', 'game:phaseJieshu:two'), [{ epoch: 'effects-a', actions: [] }, { epoch: 'effects-b', actions: [] }]);
  const result = await executePlay(parsePlay('act(end)'), f.adapter, { at: 'game:1', timeoutMs: 2000, intervalMs: 0, deferFinalWait: true });
  assert.equal(result.status, 'paused'); assert.equal(result.code, 'session_changed'); assert.equal(result.stateFresh, false);
  assert.deepEqual(result.steps.map(x => [x.status, x.value]), [['completed', 1]]);
});
