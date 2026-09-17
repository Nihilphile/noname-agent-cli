'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlay, executePlay } = require('../src/play.cjs');
const { matchesCard, cardSelector, ABBREVIATIONS } = require('../src/play-language.cjs');
const { formatExperimental } = require('../src/experimental-format.cjs');

const sha = { id: 'c1', name: 'sha', label: '雷杀', nature: 'thunder', suit: 'heart', number: 12 };
const guohe = { id: 'c2', name: 'guohe', label: '过河拆桥', suit: 'club', number: 3 };
const bow = { id: 'c3', name: 'zhuge', label: '诸葛连弩', suit: 'club', number: 1 };
const me = { id: 'p1', name: 'hero', label: '自己', hand: [sha, guohe], equipment: [], judgments: [] };
const opponent = { id: 'p2', name: 'ding', label: '丁真', equipment: [bow], judgments: [] };
const cardOption = (card, selected = false, id = card.id) => ({ id, kind: 'card', card, selected });
const target = { id: 't2', kind: 'target', player: 'p2', selected: false };
const confirm = { id: 'ok', kind: 'confirm' };
function state(n, options = [], extra = {}) {
  return { state: 'choice', revision: `e:${n}`, phase: 'phaseUse', phaseId: 'phase-1', actor: 'p1', me, players: [opponent],
    choice: { id: 'event-1', decisionId: 'decision-1', event: 'chooseToUse', context: { certainty: 'known', actor: 'p1', skill: null, sourceAction: null }, options, ...extra } };
}
function harness(states, effects = states.map(() => ({ actions: [] })), responses) {
  let index = 0;
  const requests = [], progress = [];
  return { requests, progress, run: (expression, options = {}) => executePlay(expression, {
    observe: async () => states[index], effects: async () => ({ epoch: 'flow', ...effects[index] }), sleep: async () => {},
    act: async request => { requests.push(request); const response = responses?.[index]; if (response) return response; index = Math.min(index + 1, states.length - 1); return { ok: true, action: { id: request.id }, state: states[index] }; },
  }, { at: 'e:1', intervalMs: 0, timeoutMs: 100, random: () => 0, onProgress: async r => progress.push(r), ...options }) };
}
const action = (card, kind = 'card') => ({ id: 'fa1', kind, actor: 'p1', name: card.name, status: 'completed', physicalMode: 'direct', physicalCards: [card.id], targets: ['p2'] });

test('nested card syntax preserves group operators and exact constraints', () => {
  const p = parsePlay('拆【♥Q】[丁真<诸葛连弩【id:c3】>] > 杀[] | 弃置<闪【♥12】,杀【♠7】>');
  assert.equal(p.groups.length, 2);
  assert.deepEqual(p.groups[0][0].face, { suit: 'heart', number: 12 });
  assert.equal(p.groups[0][0].objectTarget.objects[0].face.id, 'c3');
  assert.equal(p.groups[0][1].randomTarget, true);
  assert.equal(p.groups[1][0].objects.length, 2);
  assert.equal(parsePlay('拆[<诸葛连弩>]').groups[0][0].objectTarget.target, null);
  for (const bad of ['拆[丁真<诸葛连弩]', '拆[< >]', '杀[甲,,乙]', '选择<>', '杀【id:】', '杀【♥14】', '弃置<杀>junk', '杀 >']) assert.throws(() => parsePlay(bad), { code: 'invalid_play' });
});
test('card constraints intersect and unqualified sha includes elemental sha', () => {
  for (const text of ['杀', '雷杀', '杀【♥12】', '杀【♥Q】', '杀【12】', '杀【♥】', '杀【id:c1】', '【id:c1】']) assert.ok(matchesCard(sha, cardSelector(text)), text);
  for (const text of ['火杀', '普通杀', '杀【♠12】', '闪【id:c1】', '杀【id:other】']) assert.equal(matchesCard(sha, cardSelector(text)), false, text);
  assert.equal(matchesCard({ ...sha, visibility: 'hidden' }, cardSelector('杀')), false);
  assert.equal(matchesCard({ visibility: 'hidden' }, cardSelector('任意')), true);
  assert.equal(matchesCard({ visibility: 'hidden' }, cardSelector('任意【♥12】')), false);
  for (const [full, short] of Object.entries(ABBREVIATIONS)) {
    assert.equal(cardSelector(full).name, cardSelector(short).name);
    assert.match(formatExperimental({ entries: [{ seq: 1, kind: 'operation', actor: { id: 'p1', label: '甲' }, operation: { kind: 'card', label: full }, targets: [] }] }), new RegExp(short));
  }
});
test('empty target authorizes one legal target and saves the resolved physical face', async () => {
  const h = harness([state(1, [cardOption(sha)]), state(2, [cardOption(sha, true), target]), state(3)], [{ actions: [] }, { actions: [] }, { actions: [action(sha)] }]);
  const r = await h.run('杀[]');
  assert.equal(r.ok, true); assert.equal(r.steps[0].resolved, '雷杀【♥12】[丁真]');
  assert.deepEqual(h.requests.map(r => r.id), ['c1', 't2']);
  assert.ok(h.progress.some(p => p.steps[0].inFlight?.status === 'unknown'));
});
test('omitted target never chooses an available role', async () => {
  const h = harness([state(1, [cardOption(sha)]), state(2, [cardOption(sha, true), target])]);
  const r = await h.run('杀'); assert.equal(r.code, 'target_required'); assert.equal(h.requests.length, 1);
});
test('an exact mismatched entity never clicks', async () => {
  const h = harness([state(1, [cardOption(sha)])]);
  assert.equal((await h.run('闪【id:c1】')).steps[0].code, 'card_unavailable');
  assert.equal(h.requests.length, 0);
});

test('a delayed wugu choice binds to the submitted card after a running animation', async () => {
  const grain = { ...guohe, name: 'wugu', label: '五谷丰登' };
  const initial = state(1, [cardOption(grain)]), running = { ...state(2), state: 'running', choice: null };
  initial.me = { ...me, hand: [grain] };
  const choice = state(3, [{ id: 'b1', kind: 'button', card: bow }], { id: 'grain-choice', decisionId: 'grain-decision', event: 'chooseButton', context: { certainty: 'known', actor: 'p1', skill: null, sourceAction: 'fa1' } });
  let current = initial, clicks = 0;
  const result = await executePlay('五 > 选择<诸葛连弩>', {
    observe: async () => current,
    effects: async () => ({ epoch: 'flow', actions: clicks ? [action(grain)] : [], choices: clicks > 1 ? [{ id: 'cr1', decisionId: 'grain-decision', accepted: true, cards: ['c3'] }] : [] }),
    act: async request => { clicks++; current = clicks === 1 ? running : state(4); return { ok: true, action: { id: request.id }, state: current }; },
    sleep: async () => { if (current === running) current = choice; },
  }, { at: 'e:1', timeoutMs: 1000, intervalMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(clicks, 2);
});
test('nested dismantle fixes owner and physical object before submit, then follows rebuilt option IDs', async () => {
  const follow = { id: 'event-2', decisionId: 'decision-2', event: 'discardPlayerCard', objectOwner: 'p2', context: { certainty: 'known', actor: 'p1', skill: null, sourceAction: 'fa1' }, constraints: { buttons: [1, 1] } };
  const states = [state(1, [cardOption(guohe)]), state(2, [cardOption(guohe, true), target]),
    state(3, [{ id: 'b-new', kind: 'button', card: bow }], follow),
    state(4, [{ id: 'b-rebuilt', kind: 'button', card: bow, selected: true }, confirm], follow), state(5)];
  const h = harness(states, [{ actions: [] }, { actions: [] }, { actions: [action(guohe)] }, { actions: [action(guohe)] },
    { actions: [action(guohe)], choices: [{ id: 'choice-r', decisionId: 'decision-2', accepted: true, cards: ['c3'] }] }]);
  const r = await h.run('拆[<诸葛连弩>]');
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.steps[0].followup.status, 'completed');
  assert.deepEqual(h.requests.map(r => r.id), ['c2', 't2', 'b-new', 'ok']);
  assert.equal(r.steps[0].resolved, '拆【♣3】[丁真<诸葛连弩【♣1】>]');
});
test('nested object cannot select a matching card in an unrelated inserted inquiry', async () => {
  const h = harness([state(1, [cardOption(guohe)]), state(2, [cardOption(guohe, true), target]),
    state(3, [{ id: 'intruder', kind: 'button', card: bow }], { decisionId: 'new', event: 'discardPlayerCard', objectOwner: 'p2', context: { certainty: 'known', actor: 'p1', sourceAction: 'another' } })],
  [{ actions: [] }, { actions: [] }, { actions: [action(guohe)] }]);
  const r = await h.run('拆[丁真<诸葛连弩>] > 杀[]');
  assert.equal(r.code, 'followup_unavailable'); assert.equal(r.steps[0].submission.actionId, 'fa1');
  assert.equal(h.requests.length, 2); assert.equal(r.remaining, '杀[]');
});

test('native automatic singleton selection completes only with a matching causal entity receipt', async () => {
  for (const chosen of ['c3', 'different-card']) {
    const h = harness([state(1, [cardOption(guohe)]), state(2, [cardOption(guohe, true), target]), state(3)],
      [{ actions: [] }, { actions: [] }, { actions: [action(guohe)], objectChoices: [{ id: 'auto1', event: 'discardPlayerCard', sourceAction: 'fa1', owner: 'p2', skill: null, count: 1, cards: [chosen], accepted: true }] }]);
    const r = await h.run('拆[<诸葛连弩>]');
    assert.equal(r.ok, chosen === 'c3'); assert.equal(h.requests.length, 2);
    if (chosen === 'c3') assert.equal(r.steps[0].followup.receipt, 'auto1');
    else assert.equal(r.code, 'followup_unavailable');
  }
});
test('discard selects a fixed set, confirms, and requires the same inquiry receipt', async () => {
  const extra = { event: 'chooseToDiscard', constraints: { cards: [2, 2] } };
  const h = harness([state(1, [cardOption(sha), cardOption(guohe)], extra), state(2, [cardOption(sha, true), cardOption(guohe)], extra),
    state(3, [cardOption(sha, true), cardOption(guohe, true), confirm], extra), state(4)],
  [{ actions: [] }, { actions: [] }, { actions: [] }, { actions: [], choices: [{ id: 'cr1', decisionId: 'decision-1', accepted: true, cards: ['c1', 'c2'] }] }]);
  const r = await h.run('弃置<杀【♥Q】,拆>');
  assert.equal(r.ok, true); assert.deepEqual(h.requests.map(r => r.id), ['c1', 'c2', 'ok']);
  assert.equal(r.steps[0].choiceReceipt, 'cr1');
});
test('selection does not claim success from a closed dialog without acceptance evidence', async () => {
  const h = harness([state(1, [cardOption(sha)], { event: 'chooseCard' }), state(2, [], { decisionId: 'another' })]);
  assert.equal((await h.run('选择<杀>')).code, 'selection_unconfirmed'); assert.equal(h.requests.length, 1);
});
test('respond uses a response receipt and normal use handles a rescue inquiry', async () => {
  const h = harness([state(1, [cardOption(sha)], { event: 'chooseToRespond' }), state(2)], [{ actions: [] }, { actions: [action(sha, 'respond')] }]);
  assert.equal((await h.run('打出杀')).ok, true);
  const peach = { id: 'peach', name: 'tao', label: '桃', suit: 'heart', number: 6 };
  const rescue = state(1, [cardOption(peach)], { context: { certainty: 'known', sourceAction: 'enemy', actor: 'p1', skill: null } });
  rescue.me = { ...me, hand: [peach] }; rescue.actor = 'p2';
  const use = harness([rescue, state(2)], [{ actions: [] }, { actions: [action(peach)] }]);
  assert.equal((await use.run('桃')).ok, true);
});
test('end phase and generic cancel stay bound to their intended inquiry', async () => {
  const h = harness([state(1, [{ id: 'cancel-node', kind: 'cancel' }]), state(2)]);
  assert.equal((await h.run('结束出牌')).ok, true);
  const blocked = harness([state(1, [{ id: 'cancel-node', kind: 'cancel' }], { event: 'chooseToDiscard' }), state(2)]);
  assert.equal((await blocked.run('结束出牌')).code, 'unexpected_choice'); assert.equal(blocked.requests.length, 0);
  assert.equal((await blocked.run('cancel')).ok, true);
});

test('last end-phase action returns the next phase choice, but never executes a following step across phases', async () => {
  const start = state(1, [{ id: 'end', kind: 'control', label: '结束回合' }]);
  const next = { ...state(2, [], { event: 'chooseToDiscard' }), phase: 'phaseDiscard', phaseId: null };
  const h = harness([start, next]);
  assert.equal((await h.run('结束出牌')).ok, true);
  const cross = harness([start, next]);
  assert.equal((await cross.run('结束出牌 > cancel')).code, 'phase_changed'); assert.equal(cross.requests.length, 1);
});

test('same-source equipment insertion is not the promised dismantle choice', async () => {
  const h = harness([state(1, [cardOption(guohe)]), state(2, [cardOption(guohe, true), target]),
    state(3, [{ id: 'intruder', kind: 'button', card: bow }], { decisionId: 'new', event: 'discardPlayerCard', objectOwner: 'p2', context: { certainty: 'known', actor: 'p1', skill: 'equipment_trigger', sourceAction: 'fa1' } })],
  [{ actions: [] }, { actions: [] }, { actions: [action(guohe)] }]);
  assert.equal((await h.run('拆[丁真<诸葛连弩>]')).code, 'followup_unavailable'); assert.equal(h.requests.length, 2);
});

test('unsupported nested card actions fail before any selection', async () => {
  const h = harness([state(1, [cardOption(sha)])]);
  const r = await h.run('杀[丁真<诸葛连弩>]');
  assert.equal(r.steps[0].code, 'unsupported_object_action'); assert.equal(h.requests.length, 0);
});
