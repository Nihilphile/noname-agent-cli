'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installFlow } = require('../src/flow.cjs');

function fixture() {
  class GameEvent {
    constructor(name, props = {}) { Object.assign(this, { name, finished: false }, props); }
    async loop() { if (this.run) await this.run(); this.finished = true; }
    getParent() { return this.parent || null; }
    trigger(name) { return name; }
  }
  class Player {
    constructor(identity) { Object.assign(this, { identity, hujia: 3, actionHistory: [{ damage: [], gain: [], lose: [], useCard: [] }], zones: { e: [], j: [] } }); }
    update() { return this; }
    getCards(zone) { return this.zones[zone] || []; }
  }
  const self = new Player('nei'), other = new Player('fan');
  const args = { lib: { element: { GameEvent, Player }, translate: { duanyi: '断义', duanyi_info: '断义公开说明' }, skill: { duanyi: {}, secret: { hiddenSkill: true } } }, game: { players: [self, other], dead: [], me: self }, ui: { sidebar: { children: [] } }, get: { plainText: s => s.replace(/<[^>]+>/g, '') }, _status: { dying: [], globalHistory: [{ everything: [], changeHp: [] }] } };
  const window = {};
  const context = vm.createContext({ window, args });
  const api = vm.runInContext(`(${installFlow.toString()})(args)`, context);
  const read = () => JSON.parse(JSON.stringify(api.effects()));
  const row = text => ({ innerText: text });
  const add = event => { args._status.globalHistory.at(-1).everything.push(event); return event; };
  return { args, self, other, api, read, row, add, GameEvent, context };
}

test('serialized installer is idempotent and logs retain same-text nodes without consuming on peek', () => {
  const f = fixture();
  f.args.ui.sidebar.children.unshift(f.row('相同战报'));
  const a = f.api.logs();
  f.args.ui.sidebar.children.unshift(f.row('相同战报'));
  assert.deepEqual(Array.from(f.api.logs().entries, x => x.seq), [1, 2]);
  assert.equal(f.api.logs().entries.length, 2);
  f.api.commitLogs(a.to);
  assert.equal(f.api.logs().entries.length, 1);
  assert.equal(f.api.logs().from, 2);
  assert.equal(f.api.logs().to, 2);
  assert.strictEqual(vm.runInContext(`(${installFlow.toString()})(args)`, f.context), f.api);
  f.api.commitLogs(2);
  assert.equal(f.api.logs().from, 3);
  assert.equal(f.api.logs().to, 2);
  assert.equal(f.api.logs().entries.length, 0);
  assert.throws(() => f.api.commitLogs(99), /invalid/);
});

test('log sequence is chronological across initial import, truncation is explicit, reload changes epoch', () => {
  const f = fixture();
  f.args.ui.sidebar.children = Array.from({ length: 2002 }, (_, i) => f.row(`log${2002 - i}`));
  const out = f.api.logs();
  assert.equal(out.truncated, true);
  assert.equal(out.from, 3);
  assert.equal(out.to, 2002);
  assert.equal(out.entries[0].text, 'log3');
  assert.equal(out.entries.at(-1).text, 'log2002');
  assert.notEqual(out.epoch, fixture().api.logs().epoch);
});

test('damage requires applied history and loop completion; later num is read, no internal HP double-count', async () => {
  const f = fixture();
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha', secret: 'hidden' }, targets: [f.other] }));
  const damage = f.add(new f.GameEvent('damage', { player: f.other, parent: use, num: 3 }));
  const hp = f.add(new f.GameEvent('changeHp', { player: f.other, parent: damage, num: -1 }));
  f.other.actionHistory[0].damage.push(damage);
  assert.equal(f.read().actions[0].effects.length, 0);
  damage.num = 1;
  await hp.loop(); await damage.loop();
  let action = f.read().actions[0];
  assert.equal(action.status, 'pending');
  assert.deepEqual(action.effects.map(x => [x.kind, x.amount]), [['damage', 1]]);
  await use.loop();
  action = f.read().actions[0];
  assert.equal(action.status, 'completed');
  assert.equal(action.coverage, 'partial');
  assert.equal(action.effectCompleteness.damage, true);
  assert.match(action.actor, /^fp/);
  assert.equal(JSON.stringify(action).includes('hidden'), false);
  assert.equal(JSON.stringify(action).includes('nei'), false);
  assert.equal(JSON.stringify(action).includes('fan'), false);
});

test('local physical card receipts use page IDs, distinguish conversion materials and do not identify opponent materials', () => {
  const f = fixture(), resolved = [];
  const direct = { name: 'sha', nature: 'fire' }, converted = { name: 'shan' }, secret = { name: 'tao' };
  const ids = new Map([[direct, 'c-direct'], [converted, 'c-converted'], [secret, 'c-secret']]);
  f.api.setCardIdentityResolver(card => { resolved.push(card); return ids.get(card); });
  f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha', nature: 'fire' }, cards: [direct], targets: [f.other] }));
  f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha' }, cards: [converted], skill: 'duanyi', targets: [f.other] }));
  f.add(new f.GameEvent('useCard', { player: f.other, card: { name: 'tao' }, cards: [secret], targets: [f.other] }));
  const actions = f.read().actions;
  assert.deepEqual(actions[0].physicalCards, ['c-direct']); assert.equal(actions[0].physicalMode, 'direct'); assert.equal(actions[0].nature, 'fire');
  assert.deepEqual(actions[1].physicalCards, ['c-converted']); assert.equal(actions[1].physicalMode, 'materials');
  assert.equal(actions[2].physicalCards, undefined);
  assert.deepEqual(resolved, [direct, converted]);
});

test('automatic object selection receipts expose only previously observed physical identities', async () => {
  const f = fixture(), publicCard = { name: 'zhuge' }, secret = { name: 'secret_hand' };
  f.api.setKnownCardIdentityResolver(card => card === publicCard ? 'c-public' : null);
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'guohe' }, targets: [f.other] }));
  const visible = f.add(new f.GameEvent('discardPlayerCard', { player: f.self, target: f.other, parent: use, result: { bool: true, links: [publicCard] } }));
  const hidden = f.add(new f.GameEvent('discardPlayerCard', { player: f.self, target: f.other, parent: use, result: { bool: true, links: [secret] } }));
  const someoneElse = f.add(new f.GameEvent('discardPlayerCard', { player: f.other, target: f.self, parent: use, result: { bool: true, links: [publicCard] } }));
  assert.equal(f.read().objectChoices.length, 0);
  await visible.loop(); await hidden.loop(); await someoneElse.loop();
  const out = f.read();
  assert.equal(out.objectChoices.length, 2);
  assert.deepEqual(out.objectChoices.map(r => r.cards), [['c-public'], []]);
  assert.equal(out.objectChoices[0].sourceAction, out.actions[0].id);
  assert.equal(out.objectChoices[1].count, 1);
  assert.doesNotMatch(JSON.stringify(out), /secret_hand/);
});

test('empty or old finished actions remain partial: unknown does not imply zero', () => {
  const f = fixture();
  f.add(new f.GameEvent('useCard', { finished: true, player: f.self, card: { name: 'sha' } }));
  const action = f.read().actions[0];
  assert.equal(action.status, 'unknown');
  assert.equal(action.coverage, 'partial');
  assert.equal(action.effectCompleteness.damage, false);
  assert.deepEqual(action.effects, []);
});

test('a witnessed card loop stays pending while its finished event awaits passive settlement', async () => {
  const f = fixture();
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'jiu' }, targets: [f.self],
    async run() {
      // Native finish() ends content before the surrounding loop finishes its
      // after-events; a passive draw can still be awaiting completion here.
      this.finished = true;
      entered();
      await waiting;
    },
  }));
  const running = use.loop();
  await started;
  try {
    const action = f.read().actions[0];
    assert.equal(action.status, 'pending', 'unfinished witnessed loop is settlement in progress, not an unknown submission');
    assert.equal(action.effectCompleteness.draw, false);
  } finally { release(); await running; }
  assert.equal(f.read().actions[0].status, 'completed');
});

test('trigger link preserves source card across polling and exposes only choice ownership', async () => {
  const f = fixture();
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha' } }));
  const sourceId = f.read().actions[0].id;
  f.args._status.globalHistory.push({ everything: [], changeHp: [] });
  const trigger = f.add(new f.GameEvent('duanyi', { player: f.self, _trigger: use }));
  const choice = new f.GameEvent('chooseBool', { player: f.self, parent: trigger });
  const c = f.api.choiceContext(choice);
  assert.equal(c.skill, 'duanyi'); assert.equal(c.sourceAction, sourceId); assert.equal(c.certainty, 'known');
  const damage = f.add(new f.GameEvent('damage', { player: f.other, parent: trigger, num: 2 }));
  f.other.actionHistory[0].damage.push(damage); await damage.loop();
  const action = f.read().actions.find(x => x.id === sourceId);
  assert.equal(action.effects[0].sourceSkill, 'duanyi');
  assert.equal(action.effects[0].amount, 2);
  assert.equal(f.api.choiceContext(new f.GameEvent('chooseBool')).certainty, 'unknown');
});

test('loseHp and recover use committed HP amounts; draw and gain expose counts only', async () => {
  const f = fixture();
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'tao' } }));
  const recover = f.add(new f.GameEvent('recover', { player: f.self, parent: use, num: 99 }));
  const hp = f.add(new f.GameEvent('changeHp', { player: f.self, parent: recover, num: 1 }));
  f.args._status.globalHistory[0].changeHp.push(hp);
  await hp.loop(); await recover.loop();
  const draw = f.add(new f.GameEvent('draw', { player: f.other, parent: use }));
  const gain = f.add(new f.GameEvent('gain', { player: f.other, parent: draw, cards: [{ name: 'secret_card' }] }));
  f.other.actionHistory[0].gain.push(gain); await gain.loop();
  const action = f.read().actions[0];
  assert.deepEqual(action.effects.map(x => [x.kind, x.amount]), [['recover', 1], ['draw', 1]]);
  assert.equal(JSON.stringify(action).includes('secret_card'), false);
});

test('instrumentation returns original promise and preserves failure', async () => {
  const f = fixture();
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha' }, run: () => { throw new Error('original error'); } }));
  await assert.rejects(use.loop(), /original error/);
  assert.equal(f.read().actions[0].status, 'unknown');
});

test('hidden skill metadata is not published as action or choice context', () => {
  const f = fixture();
  const secret = f.add(new f.GameEvent('useSkill', { player: f.other, skill: 'secret' }));
  const ch = new f.GameEvent('chooseBool', { player: f.other, parent: secret });
  assert.equal(f.api.choiceContext(ch).skill, null);
  assert.equal(f.api.choiceContext(ch).certainty, 'unknown');
  assert.equal(f.read().actions.length, 0);
});

test('closed fully observed action can prove no standard damage, pending action cannot', async () => {
  const f = fixture();
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha' } }));
  const blocked = f.add(new f.GameEvent('damage', { player: f.other, parent: use, num: 1 }));
  await blocked.loop();
  assert.equal(f.read().actions[0].effectCompleteness.damage, false);
  await use.loop();
  const out = f.read().actions[0];
  assert.equal(out.effectCompleteness.damage, true);
  assert.deepEqual(out.effects, []);
  assert.equal(out.actor, f.api.playerId(f.self));
});

test('missing final number and incomplete child prevent false zero assertions', async () => {
  const f = fixture();
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha' } }));
  const damage = f.add(new f.GameEvent('damage', { player: f.other, parent: use }));
  f.other.actionHistory[0].damage.push(damage);
  await use.loop();
  assert.equal(f.read().actions[0].effectCompleteness.damage, false);
  await damage.loop();
  assert.equal(f.read().actions[0].effectCompleteness.damage, false);
  assert.deepEqual(f.read().actions[0].effects, []);
});

test('armor records actual public update delta, not requested amount', async () => {
  const f = fixture();
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha' } }));
  const armor = f.add(new f.GameEvent('changeHujia', { player: f.other, parent: use, num: -9, run() { f.other.hujia = 0; f.other.update(); } }));
  f.args._status.event = armor;
  await armor.loop(); await use.loop();
  const action = f.read().actions[0];
  assert.deepEqual(action.effects.map(x => [x.kind, x.amount]), [['armor', -3]]);
  assert.equal(action.effectCompleteness.armor, true);
});

test('dying and death are witnessed public transitions, not requested event names', async () => {
  const f = fixture();
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha' } }));
  let releaseDying, releaseDie;
  const dying = f.add(new f.GameEvent('dying', { player: f.other, parent: use, run: () => new Promise(resolve => { releaseDying = resolve; }) }));
  const die = f.add(new f.GameEvent('die', { player: f.other, parent: dying, run: () => new Promise(resolve => { releaseDie = resolve; }) }));
  const dyingLoop = dying.loop(), dieLoop = die.loop();
  assert.deepEqual(f.read().actions[0].effects, []);
  f.args._status.dying.push(f.other);
  dying.trigger('dying');
  assert.deepEqual(f.read().actions[0].effects.map(x => x.kind), ['dying']);
  f.args.game.dead.push(f.other);
  die.trigger('die');
  assert.deepEqual(f.read().actions[0].effects.map(x => x.kind), ['dying', 'death']);
  releaseDying(); releaseDie(); await Promise.all([dyingLoop, dieLoop]);
});

test('equipment and judgment output only confirmed visible zone movement', async () => {
  const f = fixture();
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'shunshou' } }));
  const hidden = { name: 'secret', classList: { contains: () => true } };
  const equip = f.add(new f.GameEvent('equip', { player: f.self, parent: use, run() { f.self.zones.e.push({ name: 'qinglong' }); } }));
  const judge = f.add(new f.GameEvent('addJudge', { player: f.other, parent: use, run() { f.other.zones.j.push({ name: 'lebu' }, hidden); } }));
  await equip.loop(); await judge.loop();
  const out = f.read().actions[0];
  assert.deepEqual(out.effects.map(x => [x.kind, x.name]), [['equip', 'qinglong'], ['judge', 'lebu']]);
  assert.equal(JSON.stringify(out).includes('secret'), false);
  assert.equal(out.effectCompleteness.equip, false);
});

test('only native own phase-use prompt without skill insertion has known empty scope', () => {
  const f = fixture();
  const phase = new f.GameEvent('phaseUse', { player: f.self });
  const normal = new f.GameEvent('chooseToUse', { player: f.self, type: 'phase', parent: phase });
  assert.equal(f.api.choiceContext(normal).certainty, 'known');
  assert.equal(f.api.choiceContext(normal).skill, null);
  const nested = new f.GameEvent('chooseToUse', { player: f.self, type: 'phase', parent: new f.GameEvent('custom', { parent: phase }) });
  assert.equal(f.api.choiceContext(nested).certainty, 'unknown');
  normal._trigger = new f.GameEvent('damage');
  assert.equal(f.api.choiceContext(normal).certainty, 'unknown');
});

test('concealed opponent skill is not revealed through context or actions', () => {
  const f = fixture();
  f.other.classList = { contains: x => x === 'unseen' };
  const secretOwner = f.add(new f.GameEvent('duanyi', { player: f.other }));
  assert.equal(f.api.choiceContext(secretOwner).skill, null);
  assert.equal(f.read().actions.length, 0);
});

test('native suppressed-error modes never prove complete effects or zero', async () => {
  for (const mode of ['ignore', 'online']) {
    const f = fixture();
    f.args.lib.config = mode === 'ignore' ? { ignore_error: true } : { debug: false };
    f.args._status.connectMode = mode === 'online';
    const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha' } }));
    await use.loop();
    assert.equal(f.read().actions[0].status, 'completed');
    assert.equal(f.read().actions[0].effectCompleteness.damage, false);
    f.args.lib.config = { ignore_error: false, debug: true };
    f.args._status.connectMode = false;
    // Turning error suppression off later does not repair old evidence.
    assert.equal(f.read().actions[0].effectCompleteness.damage, false);
  }
});

test('internal and undocumented skill events stay out of public actions without breaking card ancestry', async () => {
  const f = fixture();
  Object.assign(f.args.lib.skill, { _qhlyCheckSkin: {}, _fix_yh: { sourceSkill: 'duanyi' }, anonymous: {}, internalChild: { sourceSkill: 'duanyi', charlotte: true } });
  Object.assign(f.args.lib.translate, { _qhlyCheckSkin: '内部皮肤', _qhlyCheckSkin_info: '内部说明' });
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha' } }));
  const internal = f.add(new f.GameEvent('_fix_yh', { player: f.self, parent: use }));
  f.add(new f.GameEvent('_qhlyCheckSkin', { player: f.self }));
  f.add(new f.GameEvent('anonymous', { player: f.self }));
  f.add(new f.GameEvent('internalChild', { player: f.self }));
  const damage = f.add(new f.GameEvent('damage', { player: f.other, parent: internal, num: 1 }));
  f.other.actionHistory[0].damage.push(damage); await damage.loop();
  const out = f.read();
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].effects[0].amount, 1);
  assert.equal(out.actions[0].effects[0].sourceSkill, undefined);
  assert.equal(f.api.choiceContext(internal).skill, null);
});

test('untranslated real subskill prompt resolves public sourceSkill and preserves unique translated scope', () => {
  const f = fixture();
  f.args.lib.skill.duanyi_sub = { sourceSkill: 'duanyi' };
  const sub = f.add(new f.GameEvent('duanyi_sub', { player: f.self }));
  const prompt = new f.GameEvent('choosePlayerCard', { player: f.self, parent: sub });
  const context = f.api.choiceContext(prompt);
  assert.equal(context.skill, 'duanyi');
  assert.equal(context.skillLabel, '断义');
  assert.equal(context.skillLabelUnique, true);
  assert.equal(f.read().actions[0].name, 'duanyi');
});

test('Huojing charlotte choice resolves declared unique public group owner without sourceSkill or prompt parsing', () => {
  const f = fixture();
  Object.assign(f.args.lib.skill, {
    nihil_zhanshuai: { group: ['nihil_zhanshuai_init', 'nihil_zhanshuai_change'] },
    nihil_zhanshuai_init: { charlotte: true, silent: true },
    nihil_zhanshuai_change: { charlotte: true, direct: true, trigger: { player: 'phaseJieshuBegin' } },
  });
  Object.assign(f.args.lib.translate, { nihil_zhanshuai: '战帅', nihil_zhanshuai_info: '结束阶段可以令另一角色成为帅' });
  const change = f.add(new f.GameEvent('nihil_zhanshuai_change', { player: f.self }));
  const choice = new f.GameEvent('chooseTarget', { player: f.self, parent: change, prompt: '任意文本不参与归属判断' });
  const context = f.api.choiceContext(choice);
  assert.equal(context.skill, 'nihil_zhanshuai');
  assert.equal(context.skillLabel, '战帅');
  assert.equal(context.certainty, 'known');
  assert.equal(context.skillLabelUnique, true);
  assert.match(context.sourceAction, /^fa/);
  const secondChange = f.add(new f.GameEvent('nihil_zhanshuai_change', { player: f.self }));
  const secondChoice = new f.GameEvent('chooseTarget', { player: f.self, parent: secondChange });
  assert.notEqual(f.api.choiceContext(secondChoice).sourceAction, context.sourceAction);
  assert.equal(f.api.choiceContext(choice).sourceAction, context.sourceAction);
  assert.equal(f.read().actions.length, 0); // charlotte stays out of action noise.
});

test('shared group child with multiple public owners remains unknown; group cycles cannot guess scope', () => {
  const f = fixture();
  Object.assign(f.args.lib.skill, { one: { group: 'shared' }, two: { group: 'shared' }, shared: { charlotte: true }, loopA: { group: 'loopB' }, loopB: { group: 'loopA' } });
  Object.assign(f.args.lib.translate, { one: '甲', one_info: '说明甲', two: '乙', two_info: '说明乙' });
  for (const name of ['shared', 'loopA']) {
    const e = new f.GameEvent('chooseTarget', { player: f.self, parent: new f.GameEvent(name, { player: f.self }), prompt: '甲' });
    assert.equal(f.api.choiceContext(e).skill, null);
    assert.equal(f.api.choiceContext(e).certainty, 'unknown');
  }
});

test('public mark effects are observed DOM net changes, with numeric deltas only from visible counts', async () => {
  const f = fixture();
  const mark = (text, count, hidden = false) => ({
    isConnected: true, innerText: text, getClientRects: () => [{}], closest: () => hidden ? {} : null,
    querySelector: selector => selector === '.markcount' && count !== undefined ? { isConnected: true, innerText: String(count), getClientRects: () => [{}], closest: () => null } : null,
  });
  f.self.marks = { public_count: mark('血2', 2), removed: mark('盾'), private_count: mark('秘密99', 99, true) };
  Object.defineProperty(f.self, 'storage', { get() { throw new Error('storage is private'); } });
  f.self.countMark = () => { throw new Error('countMark is not a public DOM read'); };
  const use = f.add(new f.GameEvent('useCard', { player: f.self, card: { name: 'sha' }, run() {
    f.self.marks.public_count = mark('血4', 4);
    delete f.self.marks.removed;
    f.self.marks.added = mark('缠');
    f.self.marks.private_count = mark('秘密100', 100, true);
  } }));
  await use.loop();
  const out = f.read().actions[0];
  assert.equal(out.effectCompleteness.mark, false);
  const marks = out.effects.filter(x => x.kind === 'mark');
  assert.equal(marks.length, 3);
  assert.deepEqual(marks.find(x => x.name === 'public_count'), { kind: 'mark', target: f.api.playerId(f.self), name: 'public_count', before: '血2', after: '血4', visibility: 'public', amount: 2 });
  assert.equal(marks.find(x => x.name === 'added').amount, undefined);
  assert.equal(marks.find(x => x.name === 'removed').after, null);
  assert.equal(JSON.stringify(out).includes('秘密'), false);
});


test('selectable group aliases and event contexts share the same public skill resolver', () => {
  const f = fixture();
  Object.assign(f.args.lib.skill, { tia_daowu: { group: ['tia_daowu_sha','tia_daowu_shan'] }, tia_daowu_sha: { enable: ['chooseToRespond'] }, tia_daowu_shan: { enable: ['chooseToUse'] } });
  Object.assign(f.args.lib.translate, { tia_daowu: '悼舞', tia_daowu_info: '黑色手牌响应' });
  for (const name of ['tia_daowu_sha','tia_daowu_shan']) {
    const e = new f.GameEvent('chooseToUse', { skill: name, player: f.self });
    assert.equal(f.api.canonicalSkill(name), 'tia_daowu'); assert.equal(f.api.canonicalSkill(name), f.api.choiceContext(e).skill);
  }
  f.args.lib.skill.other = { group: 'tia_daowu_shan' }; f.args.lib.translate.other = '另技'; f.args.lib.translate.other_info = '另一公开技能';
  assert.equal(f.api.canonicalSkill('tia_daowu_shan'), null);
});
