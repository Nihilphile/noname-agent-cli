'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlay, executePlay } = require('../src/play.cjs');

// Independent boundary test: the next option appears only after the animation
// sleep. The immediate action response deliberately still contains the old UI.
function animatedAdapter() {
  let index = 0, settled = 0;
  const events = [], times = [];
  function observeState() {
    return {
      state: 'choice', revision: `page:${settled + 1}`, phase: 'phaseUse', phaseId: 'phase1', actor: 'p1',
      me: { id: 'p1', hand: [] }, players: [],
      choice: { id: 'e1', decisionId: 'decision1', event: 'chooseToUse',
        context: { certainty: 'known', actor: 'p1', skill: null, sourceAction: null },
        constraints: {}, options: [{ id: `b${settled + 1}`, kind: 'button', label: `Option ${settled + 1}` }] },
    };
  }
  return { events, times, adapter: {
    async observe() { events.push('observe'); return observeState(); },
    async effects() { return { epoch: 'flow1', actions: [] }; },
    async act(request) {
      assert.equal(request.id, `b${settled + 1}`, 'must use the option observed after the previous animation');
      assert.equal(request.at, `page:${settled + 1}`, 'must refresh revision after waiting');
      events.push(`act:${request.id}`); times.push(performance.now()); index++;
      return { ok: true, action: { id: request.id, kind: 'button', label: request.id }, state: observeState() };
    },
    async sleep(ms) {
      events.push(`sleep:${ms}`);
      await new Promise(resolve => setTimeout(resolve, ms));
      settled = index;
    },
  } };
}

test('play refreshes the UI after animation waits before executing each next raw instruction', async () => {
  const h = animatedAdapter();
  const result = await executePlay(parsePlay('act(b1) > act(b2) > act(b3)'), h.adapter,
    { at: 'page:1', timeoutMs: 2000, intervalMs: 30 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.times.length, 3);
  for (let i = 1; i < h.times.length; i++) assert.ok(h.times[i] - h.times[i - 1] >= 25, 'configured interval must separate mutations');
  for (const next of ['act:b2', 'act:b3']) {
    const end = h.events.indexOf(next), start = h.events.lastIndexOf('act:' + (next === 'act:b2' ? 'b1' : 'b2'), end - 1);
    const between = h.events.slice(start + 1, end);
    assert.ok(between.some(event => event.startsWith('sleep:')));
    assert.ok(between.lastIndexOf('observe') > between.findIndex(event => event.startsWith('sleep:')));
  }
});

test('play counts animation time toward its deadline and never sends a following instruction after timeout', async () => {
  const h = animatedAdapter();
  const result = await executePlay(parsePlay('act(b1) > act(b2) | act(b3)'), h.adapter,
    { at: 'page:1', timeoutMs: 30, intervalMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(h.times.length, 1);
  assert.ok(result.steps.some(step => step.value === 1), 'the completed first click must remain recorded');
});
