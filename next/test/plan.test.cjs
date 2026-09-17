'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlan, validatePlan, executePlan } = require('../src/plan.cjs');

const option = (id, kind = 'button', extra = {}) => ({ id, kind, label: id, ...extra });
const choice = (id, options, context = {}, extra = {}) => ({ state: 'choice', revision: id + ':1', me: { id: 'p1' }, choice: { id, event: 'chooseToUse', context: { skill: null, actor: 'p1', sourceAction: null, certainty: 'known', ...context }, options }, ...extra });
const running = revision => ({ state: 'running', revision, me: { id: 'p1' }, choice: null });
const cardAction = (extra = {}) => ({ id: 'a1', kind: 'card', name: 'sha', actor: 'p1', targets: ['p9'], status: 'completed', coverage: 'complete', effects: [{ kind: 'damage', target: 'p9', amount: 1 }], ...extra });
function harness(states, effects = [[], []], config = {}) {
  let index = 0, effectIndex = 0;
  const requests = [];
  return {
    requests,
    adapter: {
      async observe() { return states[index]; },
      async act(request) { requests.push(request); if (config.throwAct) throw new Error('network'); if (config.failAt === requests.length) return { ok: false, code: 'illegal', message: 'not legal', state: states[index] }; index = Math.min(index + 1, states.length - 1); return { ok: true, state: states[index] }; },
      async effects() { const actions = effects[Math.min(effectIndex++, effects.length - 1)]; return { epoch: 'epoch', actions }; },
      async sleep(ms) { if (config.onSleep) index = Math.min(index + 1, states.length - 1); else await new Promise(resolve => setTimeout(resolve, ms)); },
    },
  };
}
const execute = (input, setup, options = {}) => executePlan(typeof input === 'string' ? parsePlan(input) : input, setup.adapter, { at: 'e1:1', timeoutMs: 1000, ...options });
const condition = (extra = {}) => ({ action: 'lastCard', effect: 'damage', target: 'p9', op: '>', value: 0, ...extra });

test('simple text parser scopes future confirm/cancel and accepts skill IDs', () => {
  assert.deepEqual(parsePlan('skill:nihil_wusheng > c12 > p9 > confirm > nihil_duanyi:cancel'), { steps: [{ select: 'skill:nihil_wusheng' }, { select: 'c12' }, { select: 'p9' }, { select: 'confirm' }, { select: 'cancel', inSkill: 'nihil_duanyi' }] });
});
test('validates every branch before performing any mutation', async () => {
  const h = harness([choice('e1', [option('c1', 'card')])]);
  const result = await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [], else: [{ eval: 'process.exit()' }] }] }, h);
  assert.equal(result.code, 'invalid_plan'); assert.equal(h.requests.length, 0);
});
test('strict grammar rejects scripts, empty steps, unknown fields and unscoped blind selection', () => {
  for (const text of ['c1 >> confirm', 'c1; process.exit()', '["c1"]', '{"steps":[{"blind":1}]}', '{"steps":[{"select":"x","surprise":1}]}']) assert.throws(() => parsePlan(text), { code: 'invalid_plan' });
  assert.throws(() => validatePlan({ steps: Array.from({ length: 257 }, () => ({ select: 'c1' })) }));
});
test('current choice permits bare confirm and current player IDs resolve to target options', async () => {
  const h = harness([choice('e1', [option('t4', 'target', { player: 'p9' })]), choice('e1', [option('ok1', 'confirm')]), running('r2')]);
  const result = await execute('p9 > confirm', h);
  assert.equal(result.ok, true); assert.deepEqual(h.requests.map(x => x.id), ['t4', 'ok1']);
});
test('new unrelated cancel cannot be mistaken for planned cancel', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e2', [option('cancel2', 'cancel')], { skill: 'other' })]);
  const result = await execute('c1 > nihil_duanyi:cancel', h);
  assert.equal(result.code, 'unexpected_choice'); assert.equal(result.completed.length, 1); assert.equal(h.requests.length, 1);
});
test('bare cancel stops even when a new choice contains the same control', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e2', [option('cancel2', 'cancel')], { skill: 'other' })]);
  const result = await execute('c1 > cancel', h);
  assert.equal(result.code, 'unexpected_choice'); assert.equal(h.requests.length, 1);
});
test('same event ID with changed skill context is not the same trusted choice', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e1', [option('cancel2', 'cancel')], { skill: 'other' })]);
  const result = await execute('c1 > cancel', h);
  assert.equal(result.code, 'unexpected_choice'); assert.equal(h.requests.length, 1);
});
test('reused event and identical context cannot carry bare cancel into a new decision generation', async () => {
  const first = choice('e1', [option('c1', 'card')]), next = choice('e1', [option('cancel2', 'cancel')]);
  first.choice.decisionId = 'epoch:e1:1'; next.choice.decisionId = 'epoch:e1:2';
  const h = harness([first, next]); const result = await execute('c1 > cancel', h);
  assert.equal(result.code, 'unexpected_choice'); assert.equal(h.requests.length, 1);
});
test('selected skill authorizes its own known next choice', async () => {
  const h = harness([choice('e1', [option('s1', 'skill', { skill: 'wusheng' })]), choice('e2', [option('cancel2', 'cancel')], { skill: 'wusheng' }), running('r3')]);
  const result = await execute('skill:wusheng > cancel', h);
  assert.equal(result.ok, true); assert.equal(h.requests.length, 2);
});
test('selected attached subskill trusts its explicit canonical public skill context', async () => {
  const h = harness([choice('e1', [option('s1', 'skill', { skill: 'nihil_chixian_global', contextSkillCanonical: 'nihil_chixian' })]), choice('e2', [option('cancel2', 'cancel')], { skill: 'nihil_chixian' }), running('r3')]);
  const result = await execute('skill:nihil_chixian_global > cancel', h);
  assert.equal(result.ok, true); assert.equal(h.requests.length, 2);
});
test('raw subskill scope aliases only the exact button selected earlier in this plan', async () => {
  const h = harness([choice('e1', [option('s1', 'skill', { skill: 'nihil_chixian_global', contextSkillCanonical: 'nihil_chixian' })]), choice('e2', [option('cancel2', 'cancel')], { skill: 'nihil_chixian' }), running('r3')]);
  assert.equal((await execute('skill:nihil_chixian_global > nihil_chixian_global:cancel', h)).ok, true);
  const unselected = harness([choice('e1', [option('cancel2', 'cancel')], { skill: 'nihil_chixian' })]);
  assert.equal((await execute('nihil_chixian_global:cancel', unselected)).code, 'unexpected_choice');
  assert.equal(unselected.requests.length, 0);
});
test('canonical attached skill does not authorize another actor or source action', async () => {
  for (const context of [{ actor: 'p9' }, { sourceAction: 'other-action' }]) {
    const h = harness([choice('e1', [option('s1', 'skill', { skill: 'nihil_chixian_global', contextSkillCanonical: 'nihil_chixian' })]), choice('e2', [option('cancel2', 'cancel')], { skill: 'nihil_chixian', ...context })], [[], [cardAction({ status: 'pending' })]]);
    assert.equal((await execute('skill:nihil_chixian_global > nihil_chixian_global:cancel', h)).code, 'unexpected_choice');
    assert.equal(h.requests.length, 1);
  }
});
test('selected skill does not authorize a skill with unknown context', async () => {
  const h = harness([choice('e1', [option('s1', 'skill', { skill: 'wusheng' })]), choice('e2', [option('cancel2', 'cancel')], { skill: 'wusheng', certainty: 'unknown' })]);
  assert.equal((await execute('skill:wusheng > cancel', h)).code, 'unexpected_choice');
});
test('matching scoped cancel uses known context', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e2', [option('cancel2', 'cancel')], { skill: 'duanyi', sourceAction: 'a1' }), running('r3')], [[], [cardAction({ status: 'pending' })]]);
  assert.equal((await execute('c1 > duanyi:cancel', h)).ok, true);
});
test('same skill attached to another source action stops', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e2', [option('cancel2', 'cancel')], { skill: 'duanyi', sourceAction: 'another' })], [[], [cardAction({ status: 'pending' })]]);
  assert.equal((await execute('c1 > duanyi:cancel', h)).code, 'unexpected_choice');
});

test('explicit skill scope binds its first source and rejects later different or missing sources', async () => {
  for (const [first, second] of [['skill-action-a', 'skill-action-b'], ['skill-action-a', null], [null, 'skill-action-b']]) {
    const h = harness([
      choice('e1', [option('s1', 'skill', { skill: 'duanyi' })]),
      choice('e2', [option('okA', 'confirm')], { skill: 'duanyi', sourceAction: first }),
      choice('e3', [option('cancelB', 'cancel')], { skill: 'duanyi', sourceAction: second }),
      running('r4'),
    ]);
    const result = await execute('skill:duanyi > duanyi:confirm > duanyi:cancel', h);
    assert.equal(result.code, 'unexpected_choice', `${first} -> ${second}`);
    assert.deepEqual(h.requests.map(r => r.id), ['s1', 'okA']);
  }
});

test('explicit skill scope can continue within its bound source', async () => {
  const h = harness([
    choice('e1', [option('s1', 'skill', { skill: 'duanyi' })]),
    choice('e2', [option('okA', 'confirm')], { skill: 'duanyi', sourceAction: 'skill-action-a' }),
    choice('e3', [option('cancelA', 'cancel')], { skill: 'duanyi', sourceAction: 'skill-action-a' }),
    running('r4'),
  ]);
  assert.equal((await execute('skill:duanyi > duanyi:confirm > duanyi:cancel', h)).ok, true);
  assert.deepEqual(h.requests.map(r => r.id), ['s1', 'okA', 'cancelA']);
});

test('a unique newly observed own card can advance the bound source', async () => {
  const h = harness([
    choice('e1', [option('okA', 'confirm')], { skill: 'duanyi', sourceAction: 'skill-action-a' }),
    choice('e2', [option('cancelCard', 'cancel')], { skill: 'duanyi', sourceAction: 'a1' }),
    running('r3'),
  ], [[], [cardAction({ status: 'pending' })]]);
  assert.equal((await execute('duanyi:confirm > duanyi:cancel', h)).ok, true);
  assert.deepEqual(h.requests.map(r => r.id), ['okA', 'cancelCard']);
});

test('an older lastCard does not overwrite the source of a newly selected skill', async () => {
  const h = harness([
    choice('e1', [option('okA', 'confirm')], { skill: 'duanyi', sourceAction: 'skill-action-a' }),
    choice('e2', [option('otherSkill', 'skill', { skill: 'other' })], { skill: 'duanyi', sourceAction: 'a1' }),
    choice('e3', [option('okB', 'confirm')], { skill: 'other', sourceAction: 'skill-action-b' }),
    choice('e4', [option('cancelB', 'cancel')], { skill: 'other', sourceAction: 'skill-action-b' }),
    running('r5'),
  ], [[], [cardAction()]]);
  const result = await execute({ steps: [
    { select: 'confirm', inSkill: 'duanyi' },
    { select: 'skill:other', inSkill: 'duanyi' },
    { select: 'confirm', inSkill: 'other' },
    { select: 'cancel', inSkill: 'other' },
  ] }, h);
  assert.equal(result.ok, true);
  assert.deepEqual(h.requests.map(r => r.id), ['okA', 'otherSkill', 'okB', 'cancelB']);
});
test('translated skills need unique matches; ambiguous skill buttons stop', async () => {
  const h = harness([choice('e1', [option('s1', 'skill', { skill: 'one', label: '武圣' }), option('s2', 'skill', { skill: 'two', label: '武圣' })])]);
  assert.equal((await execute('skill:武圣', h)).code, 'ambiguous_option'); assert.equal(h.requests.length, 0);
});
test('scoped translated labels require explicit uniqueness evidence', async () => {
  for (const unique of [false, true]) {
    const h = harness([choice('e1', [option('cancel', 'cancel')], { skill: 'duanyi', skillLabel: '断义', skillLabelUnique: unique }), running('r2')]);
    assert.equal((await execute('断义:cancel', h)).ok, unique);
  }
});
test('blind selector uses public hidden status and position, not any face or link', async () => {
  const h = harness([choice('e1', [option('public', 'button'), option('hidden1', 'button', { visibility: 'hidden', link: { name: 'tao' } }), option('hidden2', 'button', { visibility: 'hidden', link: { name: 'sha' } })], { skill: 'duanyi' }), running('r2')]);
  assert.equal((await execute({ steps: [{ inSkill: 'duanyi', blind: 2 }] }, h)).ok, true);
  assert.equal(h.requests[0].id, 'hidden2');
});
test('running game waits until scoped choice appears', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2'), choice('e3', [option('cancel3', 'cancel')], { skill: 'duanyi' }), running('r4')], [[], []], { onSleep: true });
  assert.equal((await execute('c1 > duanyi:cancel', h)).ok, true);
});
test('running game times out without retrying already completed actions', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')]);
  const result = await execute('c1 > duanyi:cancel', h, { timeoutMs: 15 });
  assert.equal(result.code, 'timeout'); assert.equal(h.requests.length, 1); assert.equal(result.completed.length, 1);
});
test('conditions only bind a new own card, ignoring preexisting history', async () => {
  const old = cardAction({ id: 'old' });
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e2', [option('ok', 'confirm')])], [[old], [old]]);
  const result = await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [{ select: 'confirm' }] }] }, h);
  assert.equal(result.code, 'unexpected_choice'); assert.equal(result.branches.length, 0); assert.equal(h.requests.length, 1);
});
test('completed damage can take true branch and resume normal phase-use choice', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e2', [option('c2', 'card')], {}, { phase: 'phaseUse' }), running('r3')], [[], [cardAction()]]);
  const result = await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [{ select: 'c2' }] }] }, h);
  assert.equal(result.ok, true); assert.equal(result.branches[0].branch, 'then'); assert.equal(result.branches[0].actionId, 'a1'); assert.equal(h.requests.length, 2);
});
test('completed card permits a concrete next card and then its target in normal phase use', async () => {
  const h = harness([
    choice('e1', [option('b187')], { skill: 'guohe', sourceAction: 'a1' }),
    choice('e2', [option('c177', 'card')], {}, { phase: 'phaseUse' }),
    choice('e2', [option('t3', 'target', { player: 'p9' })], {}, { phase: 'phaseUse' }),
    running('r4'),
  ], [[], [cardAction()]]);
  const result = await execute('b187 > c177 > p9', h);
  assert.equal(result.ok, true); assert.deepEqual(h.requests.map(request => request.id), ['b187', 'c177', 't3']);
});
test('completed card permits an exact skill ID in normal phase use', async () => {
  const h = harness([choice('e1', [option('b1')]), choice('e2', [option('s1', 'skill', { skill: 'wusheng' })], {}, { phase: 'phaseUse' }), choice('e3', [option('c2', 'card')], { skill: 'wusheng' }), running('r4')], [[], [cardAction()]]);
  assert.equal((await execute('b1 > skill:wusheng > c2', h)).ok, true);
});
test('completed card never grants a new phase choice to cancel, confirm, target or control', async () => {
  for (const [selector, item] of [['cancel', option('cancel', 'cancel')], ['confirm', option('confirm', 'confirm')], ['p9', option('t1', 'target', { player: 'p9' })], ['c177', option('c177', 'control')]]) {
    const h = harness([choice('e1', [option('b1')]), choice('e2', [item], {}, { phase: 'phaseUse' })], [[], [cardAction()]]);
    const result = await execute(`b1 > ${selector}`, h);
    assert.equal(result.code, 'unexpected_choice'); assert.equal(h.requests.length, 1);
  }
});
test('condition branches do not authorize a bare cancel in the next phase-use choice', async () => {
  const h = harness([choice('e1', [option('b1')]), choice('e2', [option('cancel', 'cancel')], {}, { phase: 'phaseUse' })], [[], [cardAction()]]);
  const result = await execute({ steps: [{ select: 'b1' }, { if: condition(), then: [{ select: 'cancel' }] }] }, h);
  assert.equal(result.code, 'unexpected_choice'); assert.equal(h.requests.length, 1);
});
test('completed card cannot authorize response, discard or another skill prompt', async () => {
  const variants = [
    choice('e2', [option('c177', 'card')], {}, { phase: 'phaseUse' }),
    choice('e2', [option('c177', 'card')], { skill: 'other' }, { phase: 'phaseUse' }),
    choice('e2', [option('c177', 'card')], { sourceAction: 'another' }, { phase: 'phaseUse' }),
    choice('e2', [option('c177', 'card')], { actor: 'p9' }, { phase: 'phaseUse' }),
    choice('e2', [option('c177', 'card')], { certainty: 'unknown' }, { phase: 'phaseUse' }),
  ];
  variants[0].choice.event = 'chooseToRespond';
  const discard = choice('e2', [option('c177', 'card')], {}, { phase: 'phaseDiscard' }); discard.choice.event = 'chooseToDiscard'; variants.push(discard);
  for (const next of variants) {
    const h = harness([choice('e1', [option('b1')]), next], [[], [cardAction()]]);
    assert.equal((await execute('b1 > c177', h)).code, 'unexpected_choice'); assert.equal(h.requests.length, 1);
  }
});
test('explicit next active card relies on current normal phase rather than prior card history', async () => {
  for (const [baseline, after] of [[[], []], [[cardAction()], [cardAction()]], [[cardAction({ status: 'pending' })], [cardAction()]], [[], [cardAction({ status: 'unknown' })]]]) {
    const h = harness([choice('e1', [option('b1')]), choice('e2', [option('c177', 'card')], {}, { phase: 'phaseUse' }), running('r3')], [baseline, after]);
    assert.equal((await execute('b1 > c177', h)).ok, true); assert.equal(h.requests.length, 2);
  }
});
test('finishing a card started before this plan permits a next card but never lends its result to IF', async () => {
  const previous = cardAction({ id: 'prior' });
  const h = harness([choice('e1', [option('b187')], { skill: 'guohe', sourceAction: 'prior' }), choice('e2', [option('c177', 'card')], {}, { phase: 'phaseUse' }), choice('e2', [option('t3', 'target', { player: 'p9' })], {}, { phase: 'phaseUse' })], [[{ ...previous, status: 'pending' }], [previous]]);
  const result = await execute({ steps: [{ select: 'b187' }, { select: 'c177' }, { if: condition(), then: [] }] }, h);
  assert.equal(result.completed.filter(item => item.kind === 'action').length, 2);
  assert.equal(result.branches.length, 0); assert.equal(result.code, 'unexpected_choice');
});
test('complete coverage with no damage takes false branch; loseHp is distinct', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')], [[], [cardAction({ effects: [{ kind: 'loseHp', target: 'p9', amount: 1 }] })]]);
  const result = await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [], else: [] }] }, h);
  assert.equal(result.ok, true); assert.equal(result.branches[0].branch, 'else'); assert.equal(result.branches[0].amount, 0);
});
test('partial coverage without damage is unknown and never false', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')], [[], [cardAction({ coverage: 'partial', effects: [] })]]);
  const result = await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [], else: [] }] }, h);
  assert.equal(result.code, 'result_unknown'); assert.equal(result.branches.length, 0);
});
test('per-effect complete coverage can prove zero damage despite globally partial coverage', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')], [[], [cardAction({ coverage: 'partial', effectCompleteness: { damage: true, loseHp: false }, effects: [] })]]);
  const result = await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [], else: [] }] }, h);
  assert.equal(result.ok, true); assert.equal(result.branches[0].branch, 'else');
});
test('per-effect completeness does not establish a different effect kind', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')], [[], [cardAction({ coverage: 'partial', effectCompleteness: { damage: true, loseHp: false }, effects: [] })]]);
  assert.equal((await execute({ steps: [{ select: 'c1' }, { if: condition({ effect: 'loseHp' }), then: [], else: [] }] }, h)).code, 'result_unknown');
});
test('partial coverage with certain damage proves positive lower-bound predicate', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')], [[], [cardAction({ coverage: 'partial' })]]);
  const result = await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [] }] }, h);
  assert.equal(result.ok, true); assert.equal(result.branches[0].lowerBound, true);
});
test('hidden or uncertain damage does not establish a branch', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')], [[], [cardAction({ effects: [{ kind: 'damage', target: 'p9', amount: 1, visibility: 'hidden' }] })]]);
  assert.equal((await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [] }] }, h)).code, 'result_unknown');
});
test('missing damage amount is not fabricated as one damage', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')], [[], [cardAction({ effects: [{ kind: 'damage', target: 'p9' }] })]]);
  assert.equal((await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [] }] }, h)).code, 'result_unknown');
});
test('condition at plan entry cannot reuse previous card history', async () => {
  const h = harness([choice('e1', [option('c1', 'card')])], [[cardAction()]]);
  assert.equal((await execute({ steps: [{ if: condition(), then: [] }] }, h)).code, 'result_unknown');
  assert.equal(h.requests.length, 0);
});
test('pending card with intervening choice stops instead of consuming it', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e2', [option('cancel', 'cancel')], { skill: 'other' })], [[], [cardAction({ status: 'pending' })]]);
  const result = await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [] }] }, h);
  assert.equal(result.code, 'unexpected_choice'); assert.equal(result.actionId, 'a1');
});
test('waits for pending own card to finish before evaluating', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')], [[], [cardAction({ status: 'pending' })], [cardAction({ status: 'pending' })], [cardAction()]], { onSleep: true });
  assert.equal((await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [] }] }, h)).ok, true);
});
test('another actor card cannot serve as lastCard', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e2', [option('cancel', 'cancel')])], [[], [cardAction({ actor: 'p9' })]]);
  assert.equal((await execute({ steps: [{ select: 'c1' }, { if: condition(), then: [] }] }, h)).code, 'unexpected_choice');
});
test('ambiguous multiple new own cards do not silently bind the last one', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')], [[], [cardAction(), cardAction({ id: 'a2' })]]);
  assert.equal((await execute('c1', h)).code, 'result_unknown');
});
test('failure reports completed steps and does not roll back or continue', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e1', [option('t1', 'target', { player: 'p9' })])], [[], []], { failAt: 2 });
  const result = await execute('c1 > p9 > confirm', h);
  assert.equal(result.code, 'illegal'); assert.equal(result.stoppedAt, 'steps[1]'); assert.equal(result.completed.length, 1); assert.equal(h.requests.length, 2);
});
test('connection failure after submitting an action returns uncertain result without replay', async () => {
  const h = harness([choice('e1', [option('c1', 'card')])], [[], []], { throwAct: true });
  assert.equal((await execute('c1', h)).code, 'result_unknown'); assert.equal(h.requests.length, 1);
});
test('deadline during mutation reports unknown, not unexecuted', async () => {
  const h = harness([choice('e1', [option('c1', 'card')])]);
  h.adapter.act = async () => new Promise(() => {});
  assert.equal((await execute('c1', h, { timeoutMs: 15 })).code, 'result_unknown');
});
test('stale revision, game end and step limits stop safely', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), choice('e1', [option('c2', 'card')])]);
  assert.equal((await execute('c1', h, { at: 'old' })).code, 'stale_choice');
  assert.equal((await execute('c1 > c2', h, { maxSteps: 1 })).code, 'step_limit');
  const end = harness([{ state: 'dead', revision: 'e1:1', me: { id: 'p1' } }]);
  assert.equal((await execute('c1', end)).code, 'dead');
});
test('game epoch changes invalidate action associations', async () => {
  const h = harness([choice('e1', [option('c1', 'card')]), running('r2')]);
  let calls = 0; h.adapter.effects = async () => ({ epoch: calls++ ? 'other' : 'epoch', actions: [] });
  assert.equal((await execute('c1', h)).code, 'session_changed');
});
