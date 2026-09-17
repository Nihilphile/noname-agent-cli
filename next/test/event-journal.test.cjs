'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createEventJournal } = require('../src/event-journal.cjs');

function fixture() {
  const player = name => ({ name, playerid: `${name}-id`, hp: 3, maxHp: 4, hujia: 0, count: 2, zones: { e: [], j: [] }, actionHistory: [{ gain: [], lose: [] }], countCards(zone) { assert.equal(zone, 'h'); return this.count; }, getCards(zone) { assert.notEqual(zone, 'h'); return this.zones[zone]; } });
  const a = player('a'), b = player('b');
  const ids = new Map([[a, 'p1'], [b, 'p2']]);
  const args = { game: { players: [a, b], dead: [], me: a }, lib: { skill: { shield: {}, shield_sub: { charlotte: true }, other: {}, secret: { hiddenSkill: true }, _recasting: { discard: false, lose: false }, _chongzhu: {}, nihil_xiegong: { forced: true }, nihil_junshang: {} }, translate: { a: '甲', b: '乙', shield: '加盾', other: '另技', secret: '暗技', _recasting: '重铸', nihil_xiegong: '协攻', nihil_junshang: '军赏', sha: '杀', shan: '闪', horse: '+1马' }, card: {} }, get: {}, _status: { dying: [] }, playerId: p => ids.get(p), canonicalSkill: name => name === 'shield_sub' ? 'shield' : name.startsWith('_') ? null : name };
  const context = vm.createContext({ args });
  const api = vm.runInContext(`(${createEventJournal.toString()})(args)`, context);
  return { a, b, args, api, read: opts => JSON.parse(JSON.stringify(api.logs(opts))) };
}

test('serialized factory establishes baseline and captures silent skills without log writes', () => {
  const f = fixture(); f.args.lib.skill.shield.silent = true; assert.equal(f.read().entries.length, 0);
  const event = { name: 'shield', player: f.a, targets: [f.b] };
  f.api.begin(event); f.args._status.event = event;
  assert.equal(f.read().entries.length, 0);
  f.b.hujia = 1;
  const rows = f.read().entries;
  assert.equal(rows[0].operation.label, '加盾');
  assert.equal(rows[0].targets[0].id, 'p2');
  assert.equal(rows[1].player.id, 'p2');
  assert.deepEqual(rows[1].changes, [{ kind: 'armor', before: 0, after: 1, amount: 1 }]);
});

test('nested operations preserve different skills and actors, collapse same skill wrappers and repeated begin', () => {
  const f = fixture(), first = { name: 'shield', player: f.a };
  f.api.begin(first); f.api.begin(first);
  f.api.begin({ name: 'shield_sub', player: f.a, parent: first });
  const other = { name: 'other', player: f.b, parent: first }; f.api.begin(other);
  f.api.begin({ name: 'shield', player: f.a, parent: other });
  assert.deepEqual(f.read().entries.map(r => [r.actor.id, r.operation.id]), [['p1', 'shield'], ['p2', 'other'], ['p1', 'shield']]);
});

test('state sampled before next operation, hp never asserted to be damage, terminal and public zones captured', () => {
  const f = fixture();
  f.api.begin({ name: 'useCard', player: f.a, card: { name: 'sha' }, targets: [f.b] });
  f.b.hp = 0; f.args._status.dying.push(f.b);
  f.api.begin({ name: 'respond', player: f.b, card: { name: 'shan' } });
  let rows = f.read().entries;
  assert.deepEqual(rows.map(r => r.kind), ['operation', 'state', 'operation']);
  assert.deepEqual(rows[1].changes.map(c => c.kind), ['hp', 'dying']);
  f.args.game.players = [f.a]; f.args.game.dead = [f.b]; f.args._status.dying = [];
  rows = f.read().entries;
  assert.deepEqual(rows.at(-1).changes.map(c => c.kind), ['dead', 'dying']);
});

test('hidden hands/storage and trigger targets are never read; hidden skills/owners and wrappers omitted', () => {
  const f = fixture();
  Object.defineProperty(f.a, 'storage', { get() { throw Error('private storage'); } });
  const event = { name: 'shield', player: f.a, _trigger: { get target() { throw Error('trigger target'); } }, get cards() { throw Error('hand faces'); } };
  f.api.begin(event);
  f.api.begin({ name: 'chooseToUse', player: f.a, skill: 'shield' });
  f.api.begin({ name: 'useSkill', player: f.a, skill: 'secret' });
  f.api.begin({ name: 'privateUnknown', player: f.a });
  f.b.classList = { contains: cls => cls === 'unseen2' };
  f.api.begin({ name: 'shield', player: f.b });
  assert.equal(f.read().entries.length, 1);
  assert.deepEqual(f.read().entries[0].targets, []);
});

test('same-name equipment replacement records public removal and addition by object identity', () => {
  const f = fixture(), first = { name: 'horse' };
  f.a.zones.e = [first]; f.api.sample(); f.api.commit(f.read().to);
  f.a.zones.e = [{ name: 'horse' }];
  const row = f.read().entries[0];
  assert.deepEqual(row.changes.map(c => c.kind), ['equipRemove', 'equipAdd']);
  assert.deepEqual(row.changes[0].card, { name: 'horse', label: '+1马' });
  assert.doesNotMatch(JSON.stringify(row), /discard/);
});

test('cursor reads do not consume, commits monotonic, truncation and fresh epoch explicit', () => {
  const f = fixture();
  for (let i = 0; i < 2002; i++) f.api.begin({ name: 'shield', player: f.a });
  const out = f.read();
  assert.equal(out.from, 3); assert.equal(out.to, 2002); assert.equal(out.truncated, true);
  assert.equal(out.entries.length, 2000); assert.equal(f.read().entries.length, 2000);
  assert.equal(out.source, 'eventflow');
  f.api.validateCommit(2001); assert.equal(f.read().entries.length, 2000);
  f.api.commit(2001); assert.equal(f.read().entries.length, 1);
  assert.throws(() => f.api.commit(2000), /invalid/); assert.throws(() => f.read({ since: 3000 }), /invalid/);
  assert.notEqual(out.epoch, fixture().read().epoch);
  assert.equal(out.coverage, 'experimental_partial');
});

test('no historical event or native log backfill and returned rows cannot mutate journal', () => {
  const f = fixture();
  Object.defineProperty(f.args._status, 'globalHistory', { get() { throw Error('history'); } });
  Object.defineProperty(f.args.game, 'log', { get() { throw Error('log'); } });
  f.api.begin({ name: 'useSkill', skill: 'shield', player: f.a });
  const out = f.read(); out.entries[0].operation.label = 'corrupted';
  assert.equal(f.read().entries[0].operation.label, '加盾');
});

test('hand count changes are excluded while maxHp and public judgment changes remain', () => {
  const f = fixture();
  f.a.count = 4; f.a.maxHp = 3;
  f.a.zones.j = [{ name: 'sha' }, { name: 'private', classList: { contains: c => c === 'infohidden' } }];
  const out = f.read();
  assert.deepEqual(out.entries[0].changes.map(c => c.kind), ['maxHp', 'judgeAdd']);
  assert.doesNotMatch(JSON.stringify(out), /handCount/);
  assert.doesNotMatch(JSON.stringify(out), /private/);
});

test('public card nature survives use/respond; only actual physical card suit and number retained', () => {
  const f = fixture();
  f.args.get.itemtype = c => c.physical ? 'card' : 'vcard';
  f.api.begin({ name: 'useCard', player: f.a, card: { name: 'sha', nature: 'thunder', suit: 'spade', number: 5, physical: true }, get cards() { throw Error('materials'); } });
  f.api.begin({ name: 'respond', player: f.b, card: { name: 'sha', nature: 'fire', suit: 'secret', number: 8 } });
  const rows = f.read().entries;
  assert.deepEqual(rows[0].operation, { kind: 'card', id: 'sha', name: 'sha', label: '雷杀', nature: 'thunder', suit: 'spade', number: 5 });
  assert.deepEqual(rows[1].operation, { kind: 'respond', id: 'sha', name: 'sha', label: '火杀', nature: 'fire' });
});

test('judgment viewAs uses public effective name and zone cards retain nature', () => {
  const f = fixture(); f.args.lib.translate.lebu = '乐不思蜀';
  f.a.zones.j = [{ name: 'sha', nature: 'thunder', viewAs: 'lebu' }];
  f.a.zones.e = [{ name: 'sha', nature: ['fire', 'thunder'] }];
  const changes = f.read().entries[0].changes;
  assert.equal(changes[0].card.label, '火雷杀');
  assert.equal(changes[1].card.name, 'lebu');
  assert.equal(changes[1].card.label, '乐不思蜀');
});

test('zone read errors do not invent removal and first recovered sample only rebuilds baseline', () => {
  const f = fixture(); f.a.zones.e = [{ name: 'horse' }];
  f.api.sample(); f.api.commit(f.read().to);
  const original = f.a.getCards;
  f.a.getCards = zone => { if (zone === 'e') throw Error('temporarily unavailable'); return original.call(f.a, zone); };
  assert.equal(f.read().entries.length, 0);
  f.a.zones.e = []; f.a.getCards = original;
  assert.equal(f.read().entries.length, 0);
  f.a.zones.e = [{ name: 'horse' }];
  assert.deepEqual(f.read().entries[0].changes.map(c => c.kind), ['equipAdd']);
});

test('explicit conversion skill in useCard/respond yields skill then card without material access', () => {
  const f = fixture();
  const event = { name: 'useCard', player: f.a, skill: 'shield', card: { name: 'sha' }, targets: [f.b], get cards() { throw Error('secret materials'); } };
  f.api.begin(event); f.api.begin(event);
  f.api.begin({ name: 'respond', player: f.b, skill: 'other', card: { name: 'shan' } });
  const rows = f.read().entries;
  assert.deepEqual(rows.map(r => [r.actor.id, r.operation.id]), [['p1', 'shield'], ['p1', 'sha'], ['p2', 'other'], ['p2', 'shan']]);
  assert.deepEqual(rows[0].targets, rows[1].targets);
});

test('conversion avoids duplicate public ancestor and never reveals hidden conversion skill', () => {
  const f = fixture(), parent = { name: 'useSkill', skill: 'shield', player: f.a };
  f.api.begin(parent);
  f.api.begin({ name: 'useCard', skill: 'shield_sub', player: f.a, parent, card: { name: 'sha' } });
  f.api.begin({ name: 'respond', skill: 'secret', player: f.b, card: { name: 'shan' } });
  assert.deepEqual(f.read().entries.map(r => r.operation.id), ['shield', 'sha', 'shan']);
});

test('borrowed sword keeps both ordered targets and never aliases engine sorting arrays', () => {
  const f = fixture();
  f.args.lib.card.jiedao = { singleCard: true };
  const ordered = [f.b, f.a];
  const event = { name: 'useCard', player: f.a, card: { name: 'jiedao' }, _targets: ordered, targets: [f.b], target: f.b, addedTargets: [f.a] };
  f.api.begin(event);
  ordered.reverse(); event.targets.push(f.a);
  assert.deepEqual(f.read().entries[0].targets.map(p => p.id), ['p2', 'p1']);
  const second = { name: 'useSkill', skill: 'shield', player: f.a, targets: [f.b, f.a, f.b] };
  f.api.begin(second); second.targets.reverse();
  assert.deepEqual(f.read().entries[1].targets.map(p => p.id), ['p2', 'p1', 'p2']);
});

test('late selections are append-only ordered batches, never a candidate pool or retroactive rewrite', () => {
  const f = fixture(), event = { name: 'shield', player: f.a };
  f.api.begin(event);
  const first = f.read(); f.api.commit(first.to);
  event.targets = [f.a, f.b]; // candidate pool, not selected targets
  const choice = { name: 'chooseTarget', player: f.a, parent: event, result: { bool: true, targets: [f.b] } };
  f.api.begin(choice); f.api.finish(choice); f.api.finish(choice);
  choice.result.targets.length = 0;
  f.api.finish({ name: 'chooseCardTarget', player: f.a, parent: event, result: { bool: true, targets: [f.a, f.b], get cards() { throw Error('private cards'); } } });
  const rows = f.read().entries;
  assert.deepEqual(rows.map(r => r.kind), ['selection', 'selection']);
  assert.deepEqual(rows.map(r => r.batch), [1, 2]);
  assert.deepEqual(rows.map(r => r.targets.map(p => p.id)), [['p2'], ['p1', 'p2']]);
  assert.ok(rows.every(r => r.operationId === first.entries[0].operationId));
  assert.deepEqual(first.entries[0].targets, []);
  assert.deepEqual(f.read({ since: 0 }).entries[0], first.entries[0]);
});

test('late singular declared target supplements the same operation before state and does not duplicate logSkill', () => {
  const f = fixture(), event = { name: 'shield', player: f.a };
  f.api.begin(event); event.target = f.b;
  f.api.confirmSkill({ player: f.a, skill: 'shield', targets: f.b, event });
  f.b.hujia++; f.api.sample(event); f.api.finish(event);
  const rows = f.read().entries;
  assert.deepEqual(rows.map(r => r.kind), ['operation', 'targets', 'state']);
  assert.equal(rows[1].targets[0].id, 'p2');
});

test('cancelled direct skill and cancelled requested damage never become activation records', () => {
  const f = fixture(); f.args.lib.skill.shield.direct = true;
  const event = { name: 'shield', player: f.a };
  f.api.begin(event); event.target = f.b;
  const choice = { name: 'chooseBool', player: f.a, parent: event, result: { bool: false } };
  f.api.begin(choice); f.api.finish(choice);
  const damage = { name: 'damage', player: f.b, parent: event, cancelled: true };
  f.api.begin(damage); f.api.finish(damage); f.api.finish(event);
  assert.deepEqual(f.read().entries, []);
});

test('yes to an intermediate question alone does not prove direct activation', () => {
  const f = fixture(); f.args.lib.skill.shield.direct = true;
  const event = { name: 'shield', player: f.a };
  f.api.begin(event);
  f.api.finish({ name: 'chooseBool', player: f.a, parent: event, result: { bool: true } });
  f.api.finish({ name: 'chooseTarget', player: f.a, parent: event, result: { bool: false, targets: [f.b] } });
  f.api.finish(event);
  assert.deepEqual(f.read().entries, []);
});

test('direct skill without prose is confirmed by actual public state change before that state', () => {
  const f = fixture(); f.args.lib.skill.shield.direct = true;
  const event = { name: 'shield', player: f.a };
  f.api.begin(event); event.target = f.b;
  const change = { name: 'changeHujia', player: f.b, parent: event };
  f.api.begin(change); f.b.hujia++; f.api.sample(change);
  const rows = f.read().entries;
  assert.deepEqual(rows.map(r => r.kind), ['operation', 'targets', 'state']);
  assert.equal(rows[0].operation.id, 'shield');
});

test('explicit logSkill confirms direct operation with no state change and separate instances stay separate', () => {
  const f = fixture(); f.args.lib.skill.shield.direct = true;
  for (let i = 0; i < 2; i++) {
    const event = { name: 'shield', player: f.a };
    f.api.begin(event);
    f.api.confirmSkill({ player: f.a, skill: ['shield', 'alias'], targets: [f.b], event });
    f.api.finish({ name: 'chooseTarget', player: f.a, parent: event, result: { bool: true, targets: [f.b] } });
  }
  const ops = f.read().entries.filter(r => r.kind === 'operation');
  assert.equal(ops.length, 2); assert.notEqual(ops[0].operationId, ops[1].operationId);
  const selections = f.read().entries.filter(r => r.kind === 'selection');
  assert.deepEqual(selections.map(r => r.operationId), ops.map(r => r.operationId));
  assert.deepEqual(selections.map(r => r.batch), [1, 1]);
});

test('hidden skill ancestry and hidden targets do not leak and silent foreign choices are conservative', () => {
  const f = fixture(); f.args.game.me = f.a;
  const hidden = { name: 'shield', player: f.b, skillHidden: true };
  f.api.begin(hidden);
  f.api.begin({ name: 'other', player: f.b, parent: hidden });
  f.api.finish({ name: 'chooseTarget', player: f.b, parent: hidden, result: { bool: true, targets: [f.a] } });
  assert.deepEqual(f.read().entries, []);
  const publicSkill = { name: 'shield', player: f.b }; f.api.begin(publicSkill);
  f.api.finish({ name: 'chooseTarget', player: f.b, parent: publicSkill, animate: false, result: { bool: true, targets: [f.a] } });
  f.api.finish({ name: 'chooseTarget', player: f.a, parent: publicSkill, animate: false, result: { bool: true, targets: [f.b] } });
  f.api.finish({ name: 'chooseTarget', player: f.a, parent: publicSkill, hideTargets: true, result: { bool: true, targets: [f.b] } });
  const selections = f.read().entries.filter(r => r.kind === 'selection');
  assert.equal(selections.length, 1); assert.equal(selections[0].actor.id, 'p1');
  f.api.begin({ name: 'useCard', player: f.b, hideTargets: true, card: { name: 'sha' }, targets: [f.a] });
  assert.deepEqual(f.read().entries.at(-1).targets, []);
});

test('explicit converted card confirms a deferred direct ancestor without duplicate activation', () => {
  const f = fixture(); f.args.lib.skill.shield.direct = true;
  const parent = { name: 'shield', player: f.a }; f.api.begin(parent);
  f.api.begin({ name: 'useCard', skill: 'shield_sub', player: f.a, parent, card: { name: 'sha' }, targets: [f.b] });
  assert.deepEqual(f.read().entries.map(r => r.operation.id), ['shield', 'sha']);
});

test('same-skill content wrappers keep one activation while retaining late target observations', () => {
  const f = fixture(), parent = { name: 'useSkill', skill: 'shield', player: f.a, targets: [] };
  f.api.begin(parent);
  const child = { name: 'shield', player: f.a, parent }; f.api.begin(child);
  child.target = f.b; f.api.checkpoint(child);
  f.api.finish(child); f.api.finish(parent);
  const rows = f.read().entries;
  assert.deepEqual(rows.map(r => r.kind), ['operation', 'targets']);
  assert.equal(rows[1].operationId, rows[0].operationId);
  assert.equal(rows[1].targets[0].id, 'p2');
});

test('per-target same-skill children do not reorder or repeatedly supplement initial multi-target lists', () => {
  const f = fixture(), parent = { name: 'useSkill', skill: 'shield', player: f.a, targets: [f.b, f.a] };
  f.api.begin(parent);
  for (const target of [f.a, f.b]) {
    const child = { name: 'shield', player: f.a, parent, target };
    f.api.begin(child); f.api.checkpoint(child); f.api.finish(child);
  }
  f.api.finish(parent);
  assert.equal(f.read().entries.length, 1);
  assert.deepEqual(f.read().entries[0].targets.map(p => p.id), ['p2', 'p1']);
});

function committedHp(f, cause, { loss, absorbed = 0 }) {
  const change = { name: 'changeHp', player: cause.player, parent: cause, num: -loss, hujia: absorbed };
  f.args._status.globalHistory = [{ changeHp: [change] }];
  f.api.begin(change);
  cause.player.hp -= loss;
  f.api.sample(change);
  if (absorbed) {
    const armor = { name: 'changeHujia', player: cause.player, parent: change, type: 'damage' };
    f.api.begin(armor); cause.player.hujia -= absorbed; f.api.sample(armor); f.api.finish(armor);
  }
  f.api.finish(change); f.api.finish(change);
  return f.read().entries;
}

test('damage receipt distinguishes full and partial armor absorption without duplicate HP/armor losses', () => {
  for (const [loss, absorbed] of [[0, 2], [1, 2], [2, 0]]) {
    const f = fixture(); f.b.hujia = absorbed; f.api.sample(); f.api.commit(f.read().to);
    const damage = { name: 'damage', player: f.b, source: f.a, nature: 'fire', num: loss + absorbed };
    f.api.begin(damage);
    const rows = committedHp(f, damage, { loss, absorbed });
    assert.equal(rows.length, absorbed ? 2 : 1);
    assert.deepEqual(rows[0].changes, [{ kind: 'damage', damageId: 'jd1', amount: loss + absorbed, hpLoss: loss, armorAbsorbed: absorbed ? null : 0, source: { id: 'p1', name: 'a', label: '甲' }, nature: 'fire' }]);
    if (absorbed) assert.deepEqual(rows[1].changes, [{ kind: 'damageArmor', damageId: 'jd1', amount: absorbed }]);
  }
});

test('damage uses its actual source for chain hits and never guesses from the latest operation', () => {
  const f = fixture();
  f.api.begin({ name: 'useSkill', player: f.b, skill: 'other' });
  const damage = { name: 'damage', player: f.b, source: f.a, nature: 'thunder', num: 1, parent: { name: 'chain', player: f.b } };
  committedHp(f, damage, { loss: 1 });
  assert.equal(f.read().entries.at(-1).changes[0].source.id, 'p1');
  const unknown = { name: 'damage', player: f.a, num: 1 };
  committedHp(f, unknown, { loss: 1 });
  assert.equal(f.read().entries.at(-1).changes[0].source, null);
});

test('cancelled damage emits nothing and unproven HP changes remain ordinary deltas', () => {
  const f = fixture(), damage = { name: 'damage', player: f.b, num: 9, source: f.a, cancelled: true };
  f.api.begin(damage); f.api.finish(damage);
  assert.deepEqual(f.read().entries, []);
  f.b.hp--; f.api.sample(damage);
  assert.equal(f.read().entries[0].changes[0].kind, 'hp');
});

test('real loseHp and recovery are distinct from damage; mere pending changeHp is not proof', () => {
  const f = fixture();
  committedHp(f, { name: 'loseHp', player: f.b, num: 1 }, { loss: 1 });
  committedHp(f, { name: 'recover', player: f.b, num: 1 }, { loss: -1 });
  assert.deepEqual(f.read().entries.map(r => r.changes[0].kind), ['loseHp', 'recover']);
  const event = { name: 'changeHp', player: f.a, parent: { name: 'damage', player: f.a, num: 1 } };
  f.a.hp--; f.api.sample(event);
  assert.equal(f.read().entries.at(-1).changes[0].kind, 'hp');
});

for (const [kind, loss, absorbed] of [['damage', 1, 0], ['damage', 0, 1], ['loseHp', 1, 0], ['recover', -1, 0]]) {
  test(`direct skill confirmed only by committed ${kind} (loss ${loss}) precedes its result`, () => {
    const f = fixture(); f.args.lib.skill.shield.direct = true;
    f.b.hujia = absorbed; f.api.sample(); f.api.commit(f.read().to);
    const skill = { name: 'shield', player: f.a };
    f.api.begin(skill);
    assert.equal(f.read().entries.length, 0);
    const cause = { name: kind, player: f.b, parent: skill, num: 1, source: f.a };
    const rows = committedHp(f, cause, { loss, absorbed });
    assert.deepEqual(rows.map(row => row.kind), absorbed ? ['operation', 'state', 'state'] : ['operation', 'state']);
    assert.equal(rows[0].operation.id, 'shield');
    assert.equal(rows[1].changes[0].kind, kind);
  });
}

test('direct activation and HP evidence precede child operations without waiting for completion', () => {
  const f = fixture(); f.args.lib.skill.shield.direct = true;
  const skill = { name: 'shield', player: f.a };
  const damage = { name: 'damage', player: f.b, source: f.a, num: 1, parent: skill };
  const hp = { name: 'changeHp', player: f.b, parent: damage, num: -1 };
  f.api.begin(skill); f.api.begin(hp);
  f.args._status.globalHistory = [{ changeHp: [hp] }];
  f.b.hp--; f.api.sample(hp);
  assert.deepEqual(f.read().entries.map(row => row.operation?.id || row.changes[0].kind), ['shield', 'damage']);
  const child = { name: 'other', player: f.b, parent: hp };
  f.api.begin(child); f.b.count++; f.api.sample(child); f.api.finish(child);
  f.api.finish(hp);
  const rows = f.read().entries;
  assert.deepEqual(rows.map(row => row.operation?.id || row.changes[0].kind), ['shield', 'damage', 'other']);
  assert.equal(rows[1].changes[0].source.id, 'p1');
});

test('unavailable receipts and additional unclassified HP changes never disappear behind damage metadata',()=>{
  const f=fixture(), cause={name:'damage',player:f.b,source:f.a,num:1};
  const hp={name:'changeHp',player:f.b,parent:cause,num:-1};
  f.api.begin(hp); f.args._status.globalHistory=[{changeHp:[hp]}];
  f.b.hp--; f.api.sample(hp);
  f.b.hp++; f.api.sample(hp); f.api.finish(hp);
  assert.deepEqual(f.read().entries.map(r=>r.changes[0].kind),['damage','hp']);
  const second={name:'changeHp',player:f.a,parent:{name:'damage',player:f.a,num:1}};
  f.api.begin(second);
  Object.defineProperty(f.args._status,'globalHistory',{get(){throw Error('unavailable');}});
  f.a.hp--; f.api.sample(second);
  assert.equal(f.read().entries.at(-1).changes[0].kind,'hp');
});

test('judge emits one system operation with the final physical card, including replacements and fixing', () => {
  const f = fixture(); f.args.get.itemtype = x => x?.physical ? 'card' : null;
  const initial = { physical: true, name: 'sha', suit: 'spade', number: 7 };
  const final = { physical: true, name: 'shan', suit: 'heart', number: 2 };
  const event = { name: 'judge', player: f.b, card: { name: 'bingliang' }, result: { card: initial } };
  f.api.begin(event);
  event.result.card = final; event.finished = true;
  f.api.finish(event); f.api.finish(event);
  const row = f.read().entries[0];
  assert.equal(row.actor.system, true); assert.equal(row.targets[0].id, 'p2');
  assert.deepEqual(row.operation, { kind: 'judgment', card: { name: 'shan', label: '闪', suit: 'heart', number: 2 } });
  assert.equal(f.read().entries.length, 1);
  assert.doesNotMatch(JSON.stringify(row), /bingliang|spade|reason/);
});

test('uncompleted/private/absent judge result is not exposed', () => {
  const f = fixture(); f.args.get.itemtype = () => 'card';
  for (const props of [{}, { finished: true, hidden: true, result: { card: { name: 'private' } } }, { finished: true }]) {
    const event = { name: 'judge', player: f.a, ...props }; f.api.begin(event); f.api.finish(event);
  }
  assert.deepEqual(f.read().entries, []);
});

test('only actual public showCards exposes complete visible faces, order and quantity', () => {
  const f = fixture(); f.args.get.itemtype = x => x?.physical ? 'card' : null;
  const visible = [{ physical: true, name: 'sha', suit: 'heart', number: 7 }, { physical: true, name: 'sha', nature: 'thunder', suit: 'spade', number: 9 }];
  const privateCard = { physical: true, name: 'private', suit: 'club', number: 1 };
  const event = { name: 'showCards', player: f.a, cards: [...visible, privateCard], hiddencards: [privateCard] };
  f.api.begin(event); assert.deepEqual(f.read().entries, []);
  f.api.reveal({ event, cards: event.cards }); f.api.reveal({ event, cards: event.cards });
  const row = f.read().entries[0];
  assert.equal(row.operation.count, 2);
  assert.deepEqual(row.operation.cards.map(c => [c.label, c.suit, c.number]), [['杀', 'heart', 7], ['雷杀', 'spade', 9]]);
  assert.doesNotMatch(JSON.stringify(row), /private/);
  for (const props of [{ triggeronly: true }, { hidden: true }, { createDialog: [] }, { customButton() {} }]) {
    const e = { name: 'showCards', player: f.a, cards: [privateCard], ...props }; f.api.begin(e); f.api.reveal({ event: e, cards: e.cards });
  }
  assert.equal(f.read().entries.length, 1);
});

test('materials come only from actually public physical throws, never private skill cost_data or hidden cards', () => {
  const f = fixture(); f.args.get.itemtype = x => x?.physical ? 'card' : null;
  const material = { physical: true, name: 'shan', suit: 'heart', number: 9 };
  const event = { name: 'useCard', player: f.a, skill: 'shield', card: { name: 'sha' }, cards: [material], targets: [f.b], get cost_data() { throw Error('private'); } };
  f.api.begin(event);
  f.api.materials({ event, cards: [material, { physical: true, name: 'private' }] });
  f.api.materials({ event, cards: [material] });
  const rows = f.read().entries;
  assert.deepEqual(rows.map(r => r.kind), ['operation', 'operation', 'materials']);
  assert.equal(rows[2].operationId, rows[0].operationId);
  assert.deepEqual(rows[2].cards, [{ name: 'shan', label: '闪', suit: 'heart', number: 9 }]);
  assert.doesNotMatch(JSON.stringify(rows), /private/);
  const privateEvent = { name: 'useCard', player: f.a, skill: 'shield', card: { name: 'sha' }, hideCards: true, cards: [material] };
  f.api.begin(privateEvent); f.api.materials({ event: privateEvent, cards: [material] });
  assert.equal(f.read().entries.filter(r => r.kind === 'materials').length, 1);
});

test('public lose materials require same-player useSkill ancestry, explicit visibility and exact material intersection', () => {
  const f = fixture(); f.args.get.itemtype = x => x?.physical ? 'card' : null;
  const material = {physical:true,name:'shan',suit:'heart',number:9}, other = {physical:true,name:'sha',suit:'spade',number:7};
  const skill = {name:'useSkill',skill:'shield',player:f.a,cards:[material],get cost_data(){throw Error('private');}};
  f.api.begin(skill);
  function throwLoss(player, visible, hidden = false) {
    const discard = {name:'discard',player,parent:skill,hidden};
    const loss = {name:'lose',player,parent:discard,visible}; f.api.begin(loss);
    f.api.materials({event:loss,player,cards:[material,other]});
  }
  throwLoss(f.b,true); throwLoss(f.a,false); throwLoss(f.a,undefined); throwLoss(f.a,true,true);
  assert.equal(f.read().entries.length,1);
  throwLoss(f.a,true); throwLoss(f.a,true);
  const rows=f.read().entries;
  assert.equal(rows.length,2);
  assert.deepEqual(rows[1].cards,[{name:'shan',label:'闪',suit:'heart',number:9}]);
  assert.equal(rows[1].operationId,rows[0].operationId);
});

test('loseHp and recover remain visible before an enclosing event can finish',()=>{
  for (const [kind,amount] of [['loseHp',-1],['recover',1]]) {
    const f=fixture(), cause={name:kind,player:f.b,num:1};
    const hp={name:'changeHp',player:f.b,parent:cause,num:amount};
    f.api.begin(hp); f.args._status.globalHistory=[{changeHp:[hp]}];
    f.b.hp+=amount; f.api.sample(hp);
    const before=f.read().entries;
    assert.equal(before.length,1); assert.equal(before[0].changes[0].kind,kind);
    f.api.finish(hp); assert.deepEqual(f.read().entries,before);
  }
});

test('group maintenance and silent metadata alone never prove public activation',()=>{
  for (const metadata of [{charlotte:true,popup:false},{silent:true},{nopop:true},{popup:false},{}]) {
    const f=fixture(); Object.assign(f.args.lib.skill.shield_sub,metadata);
    if (!Object.keys(metadata).length) delete f.args.lib.skill.shield_sub.charlotte;
    const event={name:'shield_sub',player:f.a}; f.api.begin(event);
    f.a.storage={maintenance:1}; f.api.sample(event); f.api.finish(event);
    assert.deepEqual(f.read().entries,[]);
  }
});

test('silent or charlotte public effects are retained with raw public source and confirmation evidence',()=>{
  for (const raw of ['shield','shield_sub']) {
    const f=fixture(); f.args.lib.skill[raw].silent=true;
    const event={name:raw,player:f.a}; f.api.begin(event);
    assert.equal(f.read().entries.length,0);
    f.b.hujia++; f.api.sample(event); f.api.finish(event);
    const rows=f.read().entries;
    assert.deepEqual(rows.map(row=>row.kind),['operation','state']);
    assert.equal(rows[0].operation.id,'shield');
    assert.equal(rows[0].rawSkill,raw); assert.equal(rows[0].confirmation,'public_state');
  }
});

test('explicit useSkill, public logSkill and conversion each confirm deferred operations without duplicates',()=>{
  for (const evidence of ['useSkill','logSkill','conversion']) {
    const f=fixture(), parent={name:'shield_sub',player:f.a}; f.api.begin(parent);
    if(evidence==='useSkill') f.api.begin({name:'useSkill',skill:'shield',player:f.a,parent});
    if(evidence==='logSkill') f.api.confirmSkill({skill:'shield',player:f.a,event:parent});
    if(evidence==='conversion') f.api.begin({name:'useCard',skill:'shield_sub',player:f.a,parent,card:{name:'sha'}});
    f.api.finish(parent);
    const operations=f.read().entries.filter(row=>row.operation?.kind==='skill');
    assert.equal(operations.length,1); assert.equal(operations[0].confirmation,evidence);
    assert.equal(operations[0].rawSkill,evidence==='conversion'?'shield_sub':'shield');
  }
});

test('hidden maintenance sources are never exposed even when public state changes',()=>{
  for(const privacy of ['hiddenSkill','skillHidden','hidden']) {
    const f=fixture(),event={name:'shield_sub',player:f.a};
    if(privacy==='hiddenSkill') f.args.lib.skill.shield_sub.hiddenSkill=true;
    else event[privacy]=true;
    f.api.begin(event); f.b.hujia++; f.api.sample(event); f.api.finish(event);
    const rows=f.read().entries;
    assert.deepEqual(rows.map(row=>row.kind),['state']);
    assert.doesNotMatch(JSON.stringify(rows),/shield|rawSkill|confirmation/);
  }
});

test('pre-content public logSkill is consumed once by its exact native trigger child',()=>{
  const f=fixture(), wrapper={name:'trigger',skill:'shield_sub',player:f.a};
  f.api.begin(wrapper);
  f.api.confirmSkill({player:f.a,skill:'shield_sub',event:wrapper});
  f.api.confirmSkill({player:f.a,skill:'shield_sub',event:wrapper});
  assert.deepEqual(f.read().entries,[]);
  const child={name:'shield_sub',player:f.a,parent:wrapper}; f.api.begin(child); f.api.finish(child);
  f.api.confirmSkill({player:f.a,skill:'shield_sub',event:wrapper});
  f.api.begin({name:'shield_sub',player:f.a,parent:wrapper});
  const rows=f.read().entries;
  assert.equal(rows.length,1); assert.equal(rows[0].confirmation,'logSkill'); assert.equal(rows[0].rawSkill,'shield_sub');
});

test('pre-content confirmation never moves across wrappers, actors, raw aliases or indirect descendants',()=>{
  const f=fixture(), wrapper={name:'trigger',skill:'shield_sub',player:f.a};
  f.args.lib.skill.shield.silent=true;
  f.api.begin(wrapper); f.api.confirmSkill({player:f.a,skill:'shield_sub',event:wrapper});
  f.api.begin({name:'shield_sub',player:f.b,parent:wrapper});
  f.api.begin({name:'shield',player:f.a,parent:wrapper});
  f.api.begin({name:'shield_sub',player:f.a,parent:{name:'chooseBool',parent:wrapper}});
  f.api.begin({name:'shield_sub',player:f.a,parent:{name:'trigger',skill:'shield_sub',player:f.a}});
  assert.deepEqual(f.read().entries,[]);
  f.api.begin({name:'shield_sub',player:f.a,parent:wrapper});
  assert.equal(f.read().entries.length,1);
});

test('hidden, cancelled, mismatched or ended trigger confirmations cannot authorize a child',()=>{
  for(const mode of ['hidden','skillHidden','cancelled','resultCancelled','resultFalse','wrongActor','wrongRaw','ended','cancelAfter']) {
    const f=fixture(), wrapper={name:'trigger',skill:'shield_sub',player:f.a};
    if(['hidden','skillHidden','cancelled'].includes(mode)) wrapper[mode]=true;
    if(mode==='resultCancelled') wrapper.result='cancelled';
    if(mode==='resultFalse') wrapper.result={bool:false};
    f.api.begin(wrapper); if(mode==='ended') f.api.finish(wrapper);
    f.api.confirmSkill({player:mode==='wrongActor'?f.b:f.a,skill:mode==='wrongRaw'?'shield':'shield_sub',event:wrapper});
    if(mode==='cancelAfter') wrapper.cancelled=true;
    f.api.begin({name:'shield_sub',player:f.a,parent:wrapper});
    assert.deepEqual(f.read().entries,[],mode);
  }
});

test('an ordinary event named after the createTrigger content handler cannot authorize a child',()=>{
  const f=fixture(), wrapper={name:'createTrigger',skill:'shield_sub',player:f.a};
  f.api.begin(wrapper);
  f.api.confirmSkill({skill:'shield_sub',player:f.a,event:wrapper});
  f.api.begin({name:'shield_sub',player:f.a,parent:wrapper});
  assert.deepEqual(f.read().entries,[]);
});

test('every row freezes real round, turn and phase identities while logs expose the current locator', () => {
  const f = fixture(); f.args.game.roundNumber = 2;
  const turn = { name: 'phase', player: f.a };
  const use = { name: 'phaseUse', player: f.a, parent: turn };
  const first = { name: 'useCard', player: f.a, parent: use, card: { name: 'sha' }, targets: [f.b] };
  f.args._status.event = first; f.api.begin(first);
  const firstContext = f.read().entries[0].context;
  assert.deepEqual(firstContext, { round: 2, turn: { id: 'jt1', actor: { id: 'p1', name: 'a', label: '甲' } }, phase: { id: 'jp1', name: 'phaseUse' } });

  const extraUse = { name: 'phaseUse', player: f.a, parent: turn };
  const second = { name: 'respond', player: f.b, parent: extraUse, card: { name: 'shan' } };
  f.args._status.event = second; f.api.begin(second);
  const secondContext = f.read().entries[1].context;
  assert.equal(secondContext.turn.id, firstContext.turn.id);
  assert.notEqual(secondContext.phase.id, firstContext.phase.id);
  assert.deepEqual(f.read().context, secondContext);

  f.args.game.roundNumber = 3;
  const extraTurn = { name: 'phase', player: f.a };
  const third = { name: 'useCard', player: f.a, parent: { name: 'phaseUse', player: f.a, parent: extraTurn }, card: { name: 'sha' } };
  f.args._status.event = third; f.api.begin(third);
  const rows = f.read().entries;
  assert.equal(rows[0].context.round, 2);
  assert.notEqual(rows[2].context.turn.id, firstContext.turn.id);
  f.args._status.event = { name: 'unscoped', player: f.b };
  const current = f.read();
  assert.deepEqual(current.context, { round: 3, turn: null, phase: null });
  assert.deepEqual(current.players, [{ id: 'p1', name: 'a', label: '甲' }, { id: 'p2', name: 'b', label: '乙' }]);
  current.players[0].label = '破坏';
  assert.equal(f.read().players[0].label, '甲');
});

test('actual movement receipts distinguish draw, gain, transfer, discard and lose without private opponent faces', () => {
  const f = fixture(), publicCard = { physical: true, name: 'shan', suit: 'heart', number: 9 }, secretCard = { physical: true, name: 'sha', suit: 'spade', number: 7 };
  f.args.get.itemtype = card => card?.physical ? 'card' : null;
  const turn = { name: 'phase', player: f.a }, phase = { name: 'phaseUse', player: f.a, parent: turn };
  const complete = (event, kind) => {
    f.api.begin(event); event.player.actionHistory[0][kind].push(event); event.finished = true; f.api.finish(event);
  };

  complete({ name: 'gain', player: f.b, parent: { name: 'draw', player: f.b, parent: phase }, cards: [secretCard] }, 'gain');
  complete({ name: 'gain', player: f.a, parent: phase, cards: [publicCard] }, 'gain');
  complete({ name: 'gain', player: f.b, parent: phase, cards: [publicCard], visible: true, losing_map: { [f.a.playerid]: [[publicCard], [publicCard], []] } }, 'gain');
  complete({ name: 'lose', player: f.b, parent: { name: 'discard', player: f.b, parent: phase }, type: 'discard', visible: true, cards: [publicCard] }, 'lose');
  complete({ name: 'lose', player: f.b, parent: phase, cards: [secretCard] }, 'lose');
  complete({ name: 'gain', player: f.b, parent: phase, cards: [secretCard], losing_map: { missing: [[secretCard], [secretCard], []] } }, 'gain');

  const rows = f.read().entries.filter(row => row.kind === 'movement');
  assert.deepEqual(rows.map(row => [row.action, row.actor.id, row.from?.id || null, row.to?.id || null, row.count]), [
    ['draw', 'p2', null, 'p2', 1], ['gain', 'p1', null, 'p1', 1], ['transfer', 'p1', 'p1', 'p2', 1], ['discard', 'p2', 'p2', null, 1], ['lose', 'p2', 'p2', null, 1], ['gain', 'p2', null, 'p2', 1],
  ]);
  assert.deepEqual(rows[0].cards, []);
  assert.deepEqual(rows[1].cards, [{ name: 'shan', label: '闪', suit: 'heart', number: 9 }]);
  assert.deepEqual(rows[2].cards, rows[1].cards);
  assert.deepEqual(rows[3].cards, rows[1].cards);
  assert.deepEqual(rows[4].cards, []);
  assert.deepEqual(rows[5].cards, []);
  assert.ok(rows.every(row => row.context.phase.id === rows[0].context.phase.id));
});

test('movement confirms a passive activation and suppresses gain-side and use/respond loss duplicates', () => {
  const f = fixture(), card = { name: 'shan' };
  f.args.lib.skill.shield.silent = true;
  const phase = { name: 'phaseUse', player: f.a, parent: { name: 'phase', player: f.a } };
  const skill = { name: 'shield', player: f.a, parent: phase };
  f.api.begin(skill);
  const gain = { name: 'gain', player: f.a, parent: skill, cards: [card], finished: true };
  f.api.begin(gain); f.a.actionHistory[0].gain.push(gain); f.api.finish(gain);
  const transferLoss = { name: 'lose', player: f.b, parent: gain, type: 'gain', cards: [card], finished: true };
  f.api.begin(transferLoss); f.b.actionHistory[0].lose.push(transferLoss); f.api.finish(transferLoss);
  const use = { name: 'useCard', player: f.a, parent: phase, card: { name: 'sha' } };
  f.api.begin(use);
  const useLoss = { name: 'lose', player: f.a, parent: use, cards: [card], finished: true };
  f.api.begin(useLoss); f.a.actionHistory[0].lose.push(useLoss); f.api.finish(useLoss);
  const rows = f.read().entries;
  assert.deepEqual(rows.map(row => row.kind), ['operation', 'movement', 'operation']);
  assert.equal(rows[0].operation.id, 'shield');
  assert.equal(rows[1].operationId, rows[0].operationId);
  assert.equal(rows[1].action, 'gain');
  assert.equal(rows[2].operation.id, 'sha');
});

test('a private opponent-to-opponent transfer stays count-only despite a proven source partition', () => {
  const f = fixture(), card = { physical: true, name: 'shan', suit: 'heart', number: 9 };
  f.args.get.itemtype = value => value?.physical ? 'card' : null;
  f.args.game.me = {};
  const gain = { name: 'gain', player: f.b, cards: [card], losing_map: { [f.a.playerid]: [[card], [card], []] }, finished: true };
  f.api.begin(gain); f.b.actionHistory[0].gain.push(gain); f.api.finish(gain);
  const row = f.read().entries.find(entry => entry.kind === 'movement');
  assert.deepEqual({ action: row.action, from: row.from.id, to: row.to.id, count: row.count, cards: row.cards }, { action: 'transfer', from: 'p1', to: 'p2', count: 1, cards: [] });
});

test('engine recasting is the public built-in underscore activation and its alias/content child do not duplicate it', () => {
  for (const raw of ['_recasting', '_chongzhu']) {
    const f = fixture(), wrapper = { name: 'useSkill', skill: raw, player: f.a, cards: [{ name: 'shan' }], targets: [] };
    f.api.begin(wrapper);
    f.api.begin({ name: raw, player: f.a, parent: wrapper });
    const rows = f.read().entries;
    assert.equal(rows.length, 1, raw);
    assert.deepEqual(rows[0].operation, { kind: 'skill', id: '_recasting', name: '_recasting', label: '重铸' });
    assert.equal(rows[0].rawSkill, raw);
    assert.equal(rows[0].confirmation, 'useSkill');
  }
  const f = fixture();
  f.args.lib.skill._private_rule = {}; f.args.lib.translate._private_rule = '内部规则';
  f.api.begin({ name: 'useSkill', skill: '_private_rule', player: f.a });
  assert.deepEqual(f.read().entries, []);
});

test('recasting discard and replacement draw bind to the one explicit built-in activation', () => {
  const f = fixture(), card = { name: 'shan' };
  const wrapper = { name: 'useSkill', skill: '_recasting', player: f.a, cards: [card], targets: [] };
  const content = { name: '_recasting', player: f.a, parent: wrapper };
  const recast = { name: 'recast', player: f.a, parent: content };
  f.api.begin(wrapper); f.api.begin(content); f.api.begin(recast);
  const loss = { name: 'lose', player: f.a, parent: { name: 'loseToDiscardpile', player: f.a, parent: recast }, type: 'loseToDiscardpile', visible: true, cards: [card], finished: true };
  f.api.begin(loss); f.a.actionHistory[0].lose.push(loss); f.api.finish(loss);
  const gain = { name: 'gain', player: f.a, parent: { name: 'draw', player: f.a, parent: recast }, cards: [{ name: 'sha' }], finished: true };
  f.api.begin(gain); f.a.actionHistory[0].gain.push(gain); f.api.finish(gain);
  const rows = f.read().entries;
  assert.deepEqual(rows.map(row => row.operation?.label || row.action), ['重铸', 'discard', 'draw']);
  assert.ok(rows.slice(1).every(row => row.operationId === rows[0].operationId));
});

test('a distinct structured logSkill call inside an enclosing skill records the secondary activation once', () => {
  const f = fixture(), xiegong = { name: 'nihil_xiegong', player: f.a };
  f.api.begin(xiegong);
  f.api.confirmSkill({ player: f.a, skill: 'nihil_junshang', event: xiegong });
  f.api.confirmSkill({ player: f.a, skill: 'nihil_junshang', event: xiegong });
  const child = { name: 'nihil_junshang', player: f.a, parent: xiegong };
  f.api.begin(child);
  const rows = f.read().entries;
  assert.deepEqual(rows.map(row => [row.operation.id, row.confirmation]), [['nihil_xiegong', 'event'], ['nihil_junshang', 'logSkill']]);
});

test('same secondary logSkill inside one public event remains distinct for each confirmed actor', () => {
  const f = fixture(), xiegong = { name: 'nihil_xiegong', player: f.a };
  f.api.begin(xiegong);
  f.api.confirmSkill({ player: f.a, skill: 'nihil_junshang', event: xiegong });
  f.api.confirmSkill({ player: f.b, skill: 'nihil_junshang', event: xiegong });
  f.api.confirmSkill({ player: f.b, skill: 'nihil_junshang', event: xiegong });
  const rows = f.read().entries;
  assert.deepEqual(rows.map(row => [row.actor.id, row.operation.id]), [['p1', 'nihil_xiegong'], ['p1', 'nihil_junshang'], ['p2', 'nihil_junshang']]);
});
