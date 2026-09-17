'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlay, executePlay } = require('../src/play.cjs');

const context = (extra = {}) => ({ certainty: 'known', actor: 'p1', skill: null, sourceAction: null, ...extra });
const card = (id, name, label, extra = {}) => ({ id, name, label, suit: 'spade', number: 7, selected: false, selectable: true, ...extra });
const option = (id, kind = 'button', extra = {}) => ({ id, kind, label: id, selected: false, ...extra });
function choice(revision, options, extra = {}) {
  const hand = extra.hand || [];
  return { state: 'choice', revision, phase: 'phaseUse', phaseId: extra.phaseId || 'page:phaseUse:e1', actor: extra.actor || 'p1',
    me: { id: 'p1', hand }, players: extra.players || [],
    choice: { id: extra.choiceId || 'e1', decisionId: extra.decisionId || 'page:e1:1:1', event: extra.event || 'chooseToUse', context: context(extra.context), options },
  };
}
const receipt = (id, physical, name, targets = [], extra = {}) => ({ id, kind: 'card', actor: 'p1', name, targets, status: 'pending', physicalCards: [physical], physicalMode: 'direct', ...extra });
function harness(states, actionLists = states.map(() => []), config = {}) {
  let index = 0, effectEpoch = config.effectEpoch || 'flow';
  const requests = [];
  return { requests, setEffectEpoch(value) { effectEpoch = value; }, adapter: {
    async observe() { return states[index]; },
    async effects() { return { epoch: effectEpoch, actions: actionLists[Math.min(index, actionLists.length - 1)] || [] }; },
    async act(request) {
      requests.push(request);
      if (config.failAt === requests.length) return { ok: false, code: 'illegal', message: 'rejected', state: states[index] };
      index = Math.min(index + 1, states.length - 1);
      return { ok: true, action: { id: request.id, ...(request.unselect ? { unselect: true } : {}) }, state: states[index] };
    },
    async sleep() { if (config.advanceOnSleep) index = Math.min(index + 1, states.length - 1); },
  } };
}
const run = (text, h, extra = {}) => executePlay(parsePlay(text), h.adapter, { at: 'page:1', timeoutMs: 1000, intervalMs: 0, ...extra });

test('guest pipeline completes two cards using host receipts bound to each remote request', async () => {
  const first = card('c1', 'zhuge', '诸葛连弩'), second = card('c2', 'bagua', '八卦阵');
  const scoped = (revision, options, hand, request, decision) => choice(revision, options, { hand, context: { transportRequestId: request }, decisionId: decision });
  const states = [
    scoped('page:1', [option('c1','card',{card:first})], [first,second], 'request-1', 'decision-1'),
    scoped('page:2', [option('confirm','confirm')], [first,second], 'request-1', 'decision-1'),
    scoped('page:3', [option('c2','card',{card:second})], [second], 'request-2', 'decision-2'),
    scoped('page:4', [option('confirm','confirm')], [second], 'request-2', 'decision-2'),
    scoped('page:5', [], [], 'request-3', 'decision-3'),
  ];
  const a = receipt('host:1', 'c1', 'zhuge', [], { confirmation: 'host_accepted', requestId: 'request-1' });
  const b = receipt('host:2', 'c2', 'bagua', [], { confirmation: 'host_accepted', requestId: 'request-2' });
  const h = harness(states, [[],[],[a],[a],[a,b]]);
  const result = await run('诸葛连弩 > 八卦阵', h);
  assert.equal(result.ok, true); assert.deepEqual(h.requests.map(r => r.id), ['c1','confirm','c2','confirm']);
  assert.deepEqual(result.steps.map(s => s.submission.confirmation), ['host_accepted','host_accepted']);
});

test('guest sent result without a matching host receipt never completes or continues a pipe', async () => {
  for (const ack of [null, { confirmation: 'host_accepted', requestId: 'another-request' }]) {
    const c = card('c1','zhuge','诸葛连弩');
    const start = choice('page:1', [option('c1','card',{card:c})], { hand:[c], context:{transportRequestId:'request-1'} });
    const running = { ...start, state:'running', revision:'page:2', choice:null };
    const h = harness([start,running], [[],ack ? [receipt('host:1','c1','zhuge',[],ack)] : []]);
    const result = await run('诸葛连弩 | act(cancel)', h, { timeoutMs:25 });
    assert.equal(result.ok, false); assert.equal(result.steps[0].status, 'paused'); assert.equal(h.requests.length, 1);
    assert.equal(result.remaining, 'act(cancel)');
  }
});

test('disconnect after selection stops the whole guest pipeline without trying the next pipe group', async () => {
  const c = card('c1','zhuge','诸葛连弩');
  const start = choice('page:1',[option('c1','card',{card:c})],{hand:[c]});
  const h = harness([start,{...start,revision:'page:2',state:'disconnected',choice:null,room:{connected:false,seatMatches:true}}]);
  const result = await run('诸葛连弩 | act(cancel)',h);
  assert.equal(result.code,'room_disconnected'); assert.equal(h.requests.length,1); assert.equal(result.remaining,'act(cancel)');
});

test('parser gives > precedence, accepts raw flags and normalizes explicit card syntax', () => {
  const plan = parsePlay('act(b1 --value 2) > 杀【红桃K】[甲，p3] | 诸葛连弩【】');
  assert.equal(plan.groups.length, 2); assert.equal(plan.groups[0].length, 2);
  assert.deepEqual(plan.groups[0][0].request, { id: 'b1', value: '2' });
  assert.deepEqual(plan.groups[0][1].face, { suit: 'heart', number: 13 });
  assert.deepEqual(plan.groups[0][1].targets, ['甲', 'p3']);
  assert.equal(plan.groups[1][0].name, 'zhuge');
  for (const bad of ['', '杀 >> 桃', 'act(x --wat)', '杀【红桃14】']) assert.throws(() => parsePlay(bad), { code: 'invalid_play' });
});

test('raw rejection skips the rest of its > group and | continues without hiding failure', async () => {
  const initial = choice('page:1', [option('b1')]);
  const after = choice('page:2', [option('b3')]);
  const final = choice('page:3', []);
  const h = harness([initial, after, final]);
  const result = await run('act(missing) > act(b2) | act(b1) > act(b3)', h);
  assert.equal(result.status, 'failed'); assert.equal(result.value, 0); assert.equal(result.ok, false);
  assert.deepEqual(result.steps.map(step => step.status), ['failed', 'skipped', 'completed', 'completed']);
  assert.deepEqual(h.requests.map(request => request.id), ['b1', 'b3']);
});

test('ordinary raw rejection waits and refreshes mutated state before a pipe continuation', async () => {
  const initial = choice('page:1', [option('move')]);
  const changed = choice('page:2', [option('move', 'button', { selected: true }), option('next')]);
  const final = choice('page:3', []);
  let current = initial, calls = 0;
  const requests = [], sleeps = [];
  const result = await executePlay(parsePlay('act(move --to target) | act(next)'), {
    async observe() { return current; }, async effects() { return { epoch: 'flow', actions: [] }; },
    async sleep(ms) { sleeps.push(ms); },
    async act(request) {
      requests.push(request); calls++;
      if (calls === 1) { current = changed; return { ok: false, code: 'move_target_obscured', message: 'changed before rejection', state: changed }; }
      current = final; return { ok: true, action: { id: request.id }, state: final };
    },
  }, { at: 'page:1', timeoutMs: 1000, intervalMs: 25 });
  assert.equal(result.value, 0); assert.deepEqual(requests.map(request => [request.id, request.at]), [['move', 'page:1'], ['next', 'page:2']]);
  assert.deepEqual(sleeps, [25, 25]); assert.equal(result.state.revision, 'page:3');
});

test('deadline after a known raw failure preserves its cause, skips its group tail and resumes only at the next pipe group', async () => {
  const initial = choice('page:1', [option('a')]);
  const result = await executePlay(parsePlay('act(a) > act(b) | act(c)'), {
    async observe() { return initial; }, async effects() { return { epoch: 'flow', actions: [] }; },
    async act() { return { ok: false, code: 'illegal', message: 'known rejection', state: initial }; },
    async sleep() { return new Promise(() => {}); },
  }, { at: 'page:1', timeoutMs: 15, intervalMs: 50 });
  assert.equal(result.status, 'paused'); assert.equal(result.value, null); assert.equal(result.code, 'timeout'); assert.equal(result.stateFresh, false);
  assert.deepEqual(result.steps.map(step => [step.raw, step.status, step.value, step.code]), [
    ['act(a)', 'failed', 0, 'illegal'], ['act(b)', 'skipped', null, 'dependency_failed'],
  ]);
  assert.equal(result.steps[0].message, 'known rejection'); assert.equal(result.remaining, 'act(c)');
});

test('explicit card-selection rejection waits and refreshes before a pipe continuation', async () => {
  const sha = card('c1', 'sha', '杀');
  const initial = choice('page:1', [option('c1', 'card', { card: sha }), option('next')], { hand: [sha] });
  const changed = choice('page:2', [option('next')], { hand: [sha] }), final = choice('page:3', [], { hand: [sha] });
  let current = initial, calls = 0;
  const events = [];
  const result = await executePlay(parsePlay('杀 | act(next)'), {
    async observe() { events.push(`observe:${current.revision}`); return current; }, async effects() { events.push('effects'); return { epoch: 'flow', actions: [] }; },
    async sleep(ms) { events.push(`sleep:${ms}`); },
    async act(request) {
      events.push(`act:${request.id}:${request.at}`); calls++;
      if (calls === 1) { current = changed; return { ok: false, code: 'no_effect', message: 'rejected', state: changed }; }
      current = final; return { ok: true, action: { id: request.id }, state: final };
    },
  }, { at: 'page:1', timeoutMs: 1000, intervalMs: 5, random: () => 0 });
  assert.equal(result.value, 0); assert.deepEqual(events.filter(item => item.startsWith('act:')), ['act:c1:page:1', 'act:next:page:2']);
  const firstAct = events.indexOf('act:c1:page:1'), nextAct = events.indexOf('act:next:page:2');
  assert.ok(events.slice(firstAct + 1, nextAct).some(item => item === 'sleep:5'));
  assert.ok(events.slice(firstAct + 1, nextAct).some(item => item === 'observe:page:2'));
});

test('a card drawn by one wrapper is matched only when the next wrapper begins', async () => {
  const wuzhong = card('c1', 'wuzhong', '无中生有');
  const shun = card('c2', 'shunshou', '顺手牵羊');
  const first = choice('page:1', [option('c1', 'card', { card: wuzhong })], { hand: [wuzhong] });
  const second = choice('page:2', [option('c2', 'card', { card: shun })], { hand: [shun] });
  const final = choice('page:3', [], { hand: [] });
  const h = harness([first, second, final], [[], [receipt('a1', 'c1', 'wuzhong')], [receipt('a1', 'c1', 'wuzhong'), receipt('a2', 'c2', 'shunshou')]]);
  const result = await run('无中 > 顺', h, { random: () => 0 });
  assert.equal(result.ok, true); assert.deepEqual(result.steps.map(step => step.card.id), ['c1', 'c2']);
});

test('random choice is fixed and never switches to another matching selectable card', async () => {
  const a = card('c1', 'shunshou', '顺手牵羊'), b = card('c2', 'shunshou', '顺手牵羊', { selectable: false });
  const state = choice('page:1', [option('c1', 'card', { card: a })], { hand: [a, b] });
  const h = harness([state]);
  const result = await run('顺', h, { random: () => 0.75 });
  assert.equal(result.value, 0); assert.equal(result.steps[0].card.id, 'c2'); assert.equal(result.steps[0].code, 'card_unselectable'); assert.equal(h.requests.length, 0);
});

test('ambiguous target rolls back only this wrapper selection before the next pipe group', async () => {
  const sha = card('c1', 'sha', '杀');
  const players = [{ id: 'p2', name: 'same', label: '甲' }, { id: 'p3', name: 'same', label: '甲' }];
  const initial = choice('page:1', [option('c1', 'card', { card: sha })], { hand: [sha], players });
  const selectedCard = { ...sha, selected: true };
  const selected = choice('page:2', [option('c1', 'card', { card: selectedCard, selected: true })], { hand: [selectedCard], players });
  const cleaned = choice('page:3', [option('b1')], { hand: [sha], players });
  const final = choice('page:4', [], { hand: [sha], players });
  const h = harness([initial, selected, cleaned, final]);
  const result = await run('杀[甲] | act(b1)', h);
  assert.equal(result.value, 0); assert.equal(result.steps[0].code, 'ambiguous_target');
  assert.deepEqual(h.requests.map(request => [request.id, !!request.unselect]), [['c1', false], ['c1', true], ['b1', false]]);
});

test('complete card wrapper selects hand card, ordered target and manual confirm before accepting its receipt', async () => {
  const sha = card('c1', 'sha', '杀'), player = { id: 'p2', name: 'target', label: '目标' };
  const initial = choice('page:1', [option('c1', 'card', { card: sha })], { hand: [sha], players: [player] });
  const targeted = choice('page:2', [option('c1', 'card', { card: { ...sha, selected: true }, selected: true }), option('t2', 'target', { player: 'p2' })], { hand: [{ ...sha, selected: true }], players: [player] });
  const confirming = choice('page:3', [option('c1', 'card', { card: { ...sha, selected: true }, selected: true }), option('t2', 'target', { player: 'p2', selected: true }), option('ok', 'confirm')], { hand: [{ ...sha, selected: true }], players: [player] });
  const final = choice('page:4', [], { hand: [] });
  const h = harness([initial, targeted, confirming, final], [[], [], [], [receipt('a1', 'c1', 'sha', ['p2'])]]);
  const result = await run('杀[目标]', h);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.steps[0].receipt, 'a1');
  assert.deepEqual(h.requests.map(request => request.id), ['c1', 't2', 'ok']);
});

test('card wrapper rejects a changed context even when decisionId and target option are reused', async () => {
  const sha = card('c1', 'sha', '杀'), player = { id: 'p2', name: 'target', label: '目标' };
  const initial = choice('page:1', [option('c1', 'card', { card: sha })], { hand: [sha], players: [player] });
  const intruder = choice('page:2', [option('c1', 'card', { card: { ...sha, selected: true }, selected: true }), option('intruder-target', 'target', { player: 'p2' })],
    { hand: [{ ...sha, selected: true }], players: [player], context: { skill: 'intruder', sourceAction: 'intruder-action' } });
  const h = harness([initial, intruder]);
  const result = await run('杀[目标]', h);
  assert.equal(result.code, 'unexpected_choice'); assert.deepEqual(h.requests.map(request => request.id), ['c1']);
});

test('known target preparation failures survive a cleanup timeout and skip only their own dependency tail', async () => {
  const variants = [
    { label: 'missing', target: '不存在', players: [], code: 'target_unavailable' },
    { label: 'ambiguous', target: '同名', players: [{ id: 'p2', label: '同名' }, { id: 'p3', label: '同名' }], code: 'ambiguous_target' },
    { label: 'unselectable', target: 'p2', players: [{ id: 'p2', label: '目标' }], code: 'target_unselectable' },
  ];
  for (const variant of variants) {
    const sha = card('c1', 'sha', '杀'), selectedCard = { ...sha, selected: true };
    const initial = choice('page:1', [option('c1', 'card', { card: sha })], { hand: [sha], players: variant.players });
    const selected = choice('page:2', [option('c1', 'card', { card: selectedCard, selected: true })], { hand: [selectedCard], players: variant.players });
    const clean = choice('page:3', [option('c')], { hand: [sha], players: variant.players });
    let current = initial;
    const requests = [];
    const result = await executePlay(parsePlay(`杀[${variant.target}] > act(b) | act(c)`), {
      async observe() { return current; }, async effects() { return { epoch: 'flow', actions: [] }; },
      async act(request) { requests.push(request); current = request.unselect ? clean : selected; return { ok: true, action: { id: request.id }, state: current }; },
      async sleep() { if (requests.at(-1)?.unselect) return new Promise(() => {}); },
    }, { at: 'page:1', timeoutMs: 20, intervalMs: 1, random: () => 0 });
    assert.equal(result.code, 'timeout', variant.label); assert.equal(result.stateFresh, false, variant.label);
    assert.deepEqual(result.steps.map(step => [step.status, step.value, step.code]), [['failed', 0, variant.code], ['skipped', null, 'dependency_failed']], variant.label);
    assert.equal(result.remaining, 'act(c)', variant.label); assert.equal(requests.filter(request => request.unselect).length, 1, variant.label);
  }
});

test('known confirm rejection settles before cleanup and retains its cause if cleanup times out', async () => {
  const cardValue = card('c1', 'wuzhong', '无中生有'), selectedCard = { ...cardValue, selected: true };
  const initial = choice('page:1', [option('c1', 'card', { card: cardValue })], { hand: [cardValue] });
  const confirming = choice('page:2', [option('c1', 'card', { card: selectedCard, selected: true }), option('ok', 'confirm')], { hand: [selectedCard] });
  const clean = choice('page:3', [option('c')], { hand: [cardValue] });
  let current = initial;
  const requests = [], sleeps = [];
  const result = await executePlay(parsePlay('无中 > act(b) | act(c)'), {
    async observe() { return current; }, async effects() { return { epoch: 'flow', actions: [] }; },
    async act(request) {
      requests.push(request);
      if (request.id === 'c1' && !request.unselect) { current = confirming; return { ok: true, action: { id: 'c1' }, state: confirming }; }
      if (request.id === 'ok') return { ok: false, code: 'confirm_rejected', message: 'cannot confirm', state: confirming };
      current = clean; return { ok: true, action: { id: request.id }, state: clean };
    },
    async sleep(ms) { sleeps.push(ms); if (requests.at(-1)?.unselect) return new Promise(() => {}); },
  }, { at: 'page:1', timeoutMs: 25, intervalMs: 1, random: () => 0 });
  assert.deepEqual(requests.map(request => [request.id, !!request.unselect]), [['c1', false], ['ok', false], ['c1', true]]);
  assert.equal(sleeps.length, 3); assert.equal(result.code, 'timeout'); assert.equal(result.steps[0].code, 'confirm_rejected'); assert.equal(result.steps[0].value, 0);
  assert.equal(result.steps[1].status, 'skipped'); assert.equal(result.remaining, 'act(c)');
});

test('typed skill raw chain may cross its bound new decisions through a suboption and confirm', async () => {
  const first = choice('page:1', [option('skill-button', 'skill', { skill: 'duanyi', contextSkillCanonical: 'duanyi' })]);
  const second = choice('page:2', [option('suboption')], { choiceId: 'skill-a', decisionId: 'page:skill-a:1', event: 'chooseButton', context: { skill: 'duanyi', sourceAction: 'skill-action-a' } });
  const third = choice('page:3', [option('ok', 'confirm')], { choiceId: 'skill-b', decisionId: 'page:skill-b:2', event: 'chooseBool', context: { skill: 'duanyi', sourceAction: 'skill-action-a' } });
  const final = choice('page:4', []);
  const h = harness([first, second, third, final]);
  const result = await run('act(skill-button) > act(suboption) > act(confirm)', h);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(h.requests.map(request => request.id), ['skill-button', 'suboption', 'ok']);
});

test('typed skill chain never carries generic confirm across a different actor or source action', async () => {
  for (const changedContext of [{ actor: 'p9' }, { sourceAction: 'skill-action-b' }]) {
    const first = choice('page:1', [option('skill-button', 'skill', { skill: 'duanyi', contextSkillCanonical: 'duanyi' })]);
    const second = choice('page:2', [option('suboption')], { choiceId: 'skill-a', decisionId: 'page:skill-a:1', event: 'chooseButton', context: { skill: 'duanyi', sourceAction: 'skill-action-a' } });
    const third = choice('page:3', [option('ok', 'confirm')], { choiceId: 'skill-b', decisionId: 'page:skill-b:2', event: 'chooseBool', context: { skill: 'duanyi', sourceAction: 'skill-action-a', ...changedContext } });
    const h = harness([first, second, third]);
    const result = await run('act(skill-button) > act(suboption) > act(confirm)', h);
    assert.equal(result.code, 'unexpected_choice'); assert.deepEqual(h.requests.map(request => request.id), ['skill-button', 'suboption']);
  }
});

test('target entity ID has priority over another player whose name happens to equal that ID', async () => {
  const sha = card('c1', 'sha', '杀');
  const players = [{ id: 'p2', name: 'target', label: '目标' }, { id: 'p3', name: 'p2', label: '别名' }];
  const initial = choice('page:1', [option('c1', 'card', { card: sha })], { hand: [sha], players });
  const targeted = choice('page:2', [option('c1', 'card', { card: { ...sha, selected: true }, selected: true }), option('t2', 'target', { player: 'p2' })], { hand: [{ ...sha, selected: true }], players });
  const final = choice('page:3', [], { hand: [] });
  const h = harness([initial, targeted, final], [[], [], [receipt('a1', 'c1', 'sha', ['p2'])]]);
  const result = await run('杀[p2]', h);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(h.requests.map(request => request.id), ['c1', 't2']);
});

test('receipt keeps observed target order as evidence without rejecting a physically proven submission', async () => {
  const sha = card('c1', 'sha', '杀'), players = [{ id: 'p2', label: '甲' }, { id: 'p3', label: '乙' }];
  const initial = choice('page:1', [option('c1', 'card', { card: sha })], { hand: [sha], players });
  const targetA = choice('page:2', [option('c1', 'card', { card: { ...sha, selected: true }, selected: true }), option('t2', 'target', { player: 'p2' })], { hand: [{ ...sha, selected: true }], players });
  const targetB = choice('page:3', [option('c1', 'card', { card: { ...sha, selected: true }, selected: true }), option('t3', 'target', { player: 'p3' })], { hand: [{ ...sha, selected: true }], players });
  const final = choice('page:4', [], { hand: [] });
  const h = harness([initial, targetA, targetB, final], [[], [], [], [receipt('a1', 'c1', 'sha', ['p3', 'p2'])]]);
  const result = await run('杀[p2,p3]', h);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(result.steps[0].submission.targets, ['p3', 'p2']);
});

test('auto-confirmed entity receipt succeeds and an unplanned follow-up question pauses without replay', async () => {
  const shun = card('c1', 'shunshou', '顺手牵羊');
  const initial = choice('page:1', [option('c1', 'card', { card: shun })], { hand: [shun] });
  const extra = choice('page:2', [option('loot', 'button')], { hand: [], choiceId: 'loot', decisionId: 'page:loot:1:2', event: 'chooseButton', context: { sourceAction: 'a1' } });
  const h = harness([initial, extra], [[], [receipt('a1', 'c1', 'shunshou')]]);
  const result = await run('顺 > 杀', h);
  assert.equal(result.code, 'unexpected_choice'); assert.equal(result.steps[0].status, 'completed'); assert.equal(result.steps[0].receipt, 'a1');
  assert.equal(result.remaining, '杀'); assert.equal(h.requests.length, 1);
});

test('card wrapper keeps observing a running animation until its delayed entity receipt appears', async () => {
  const sha = card('c1', 'sha', '杀');
  const initial = choice('page:1', [option('c1', 'card', { card: sha })], { hand: [sha] });
  const running = { state: 'running', revision: 'page:2', phase: 'phaseUse', phaseId: 'page:phaseUse:e1', actor: 'p1', me: { id: 'p1', hand: [] }, players: [], choice: null };
  const final = choice('page:3', [], { hand: [] });
  const h = harness([initial, running, final], [[], [], [receipt('a1', 'c1', 'sha')]], { advanceOnSleep: true });
  const result = await run('杀', h);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.steps[0].receipt, 'a1'); assert.equal(h.requests.length, 1);
});

test('the next exact raw action may answer a submitted card follow-up question', async () => {
  const shun = card('c1', 'shunshou', '顺手牵羊');
  const initial = choice('page:1', [option('c1', 'card', { card: shun })], { hand: [shun] });
  const extra = choice('page:2', [option('loot', 'button')], { hand: [], choiceId: 'loot', decisionId: 'page:loot:1:2', event: 'chooseButton', context: { sourceAction: 'a1' } });
  const final = choice('page:3', [], { hand: [] });
  const h = harness([initial, extra, final], [[], [receipt('a1', 'c1', 'shunshou')], [receipt('a1', 'c1', 'shunshou')]]);
  const result = await run('顺 > act(loot)', h);
  assert.equal(result.ok, true); assert.deepEqual(h.requests.map(request => request.id), ['c1', 'loot']);
});

test('unknown entity receipt and changed effects epoch pause with no automatic replay', async () => {
  const sha = card('c1', 'sha', '杀');
  const initial = choice('page:1', [option('c1', 'card', { card: sha })], { hand: [sha] });
  const next = choice('page:2', [], { hand: [] });
  const unknown = harness([initial, next], [[], [receipt('a1', 'c1', 'sha', [], { status: 'unknown' })]]);
  const first = await run('杀', unknown);
  assert.equal(first.code, 'result_unknown'); assert.equal(first.value, null); assert.equal(unknown.requests.length, 1); assert.equal(first.stateFresh, false);

  let calls = 0;
  const changed = harness([initial, next], [[], [receipt('a1', 'c1', 'sha')]]);
  changed.adapter.effects = async () => ({ epoch: calls++ ? 'other' : 'flow', actions: calls > 1 ? [receipt('a1', 'c1', 'sha')] : [] });
  const second = await run('杀', changed);
  assert.equal(second.code, 'session_changed'); assert.equal(changed.requests.length, 1); assert.equal(second.stateFresh, false);
});

test('existing selections and opponent phase-use responses stop before any wrapper action', async () => {
  const sha = card('c1', 'sha', '杀', { selected: true });
  const selected = choice('page:1', [option('c1', 'card', { card: sha, selected: true })], { hand: [sha] });
  const h1 = harness([selected]); const r1 = await run('杀', h1);
  assert.equal(r1.code, 'existing_selection'); assert.equal(r1.remaining, '杀'); assert.equal(h1.requests.length, 0);

  const response = choice('page:1', [option('c1', 'card', { card: { ...sha, selected: false } })], { hand: [{ ...sha, selected: false }], actor: 'p9', context: { actor: 'p1' } });
  const h2 = harness([response]); const r2 = await run('杀', h2);
  assert.equal(r2.code, 'unexpected_choice'); assert.equal(h2.requests.length, 0);
});

test('stale initial revision rejects without mutation and a phase switch stops before the next instruction', async () => {
  const first = choice('page:1', [option('b1')]);
  const stale = harness([first]);
  const staleResult = await executePlay(parsePlay('act(b1)'), stale.adapter, { at: 'page:old', timeoutMs: 1000, intervalMs: 0 });
  assert.equal(staleResult.code, 'stale_choice'); assert.equal(stale.requests.length, 0);

  const nextPhase = choice('page:2', [option('b2')], { phaseId: 'page:phaseUse:e2' });
  const changed = harness([first, nextPhase]);
  const changedResult = await run('act(b1) > act(b2)', changed);
  assert.equal(changedResult.code, 'phase_changed'); assert.equal(changedResult.steps[0].value, 1); assert.equal(changedResult.remaining, 'act(b2)');
  assert.deepEqual(changed.requests.map(request => request.id), ['b1']);
});
