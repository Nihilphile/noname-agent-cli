'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatExperimental } = require('../src/experimental-format.cjs');
const a = { id: 'p1', name: 'a', label: '甲' }, b = { id: 'p2', name: 'b', label: '乙' };
const operation = (seq, actor, label, targets = [], kind = 'card') => ({ seq, kind: 'operation', actor, operation: { kind, label }, targets });
const state = (seq, player, changes) => ({ seq, kind: 'state', player, changes });
const log = entries => ({ epoch: 'flow-test', from: entries[0]?.seq, to: entries.at(-1)?.seq, truncated: false, coverage: 'experimental_partial', entries });
const context = (round, turnActor, turnId, phaseName, phaseId) => ({ round, turn: { id: turnId, actor: turnActor }, phase: { id: phaseId, name: phaseName } });
const inContext = (entry, value) => ({ ...entry, context: value });

test('card use and response change operator, while state changes stay in the active block', () => {
  const rendered = formatExperimental(log([
    operation(1, a, '杀', [b]), operation(2, b, '闪', [], 'respond'),
    operation(3, a, '杀', [b]), state(4, b, [{ kind: 'hp', before: 3, after: 2 }]),
  ]));
  assert.equal(rendered, '实验战报（部分事件）\n[1-4]\n【进程上下文未知】\n[1] 甲 { 杀[乙] }\n[2] 乙 { 打出闪 }\n[3-4] 甲 { 杀[乙]，乙（hp-1） }');
  assert.doesNotMatch(rendered, /伤害|受伤/);
});

test('skill operations include targets and use identical form for passive skills', () => {
  const rendered = formatExperimental(log([
    operation(3, a, '加盾', [b], 'skill'), state(4, b, [{ kind: 'armor', before: 0, after: 1 }]),
    operation(5, b, '护身', [], 'skill'), state(6, a, [{ kind: 'hp', before: 2, after: 1 }]),
  ]));
  assert.match(rendered, /\[3-4\] 甲 \{ 加盾\[乙\]，乙（盾\+1） \}/);
  assert.match(rendered, /\[5-6\] 乙 \{ 护身，甲（hp-1） \}/);
  assert.doesNotMatch(rendered, /被动|锁定|来源/);
});

test('consecutive operations and cross-player state changes preserve order and names', () => {
  const twin = { id: 'p3', label: '甲' };
  const entries = [operation(1, a, '过河拆桥', [b]), state(2, b, [{ kind: 'equipRemove', card: { label: '+1马' } }]), operation(3, a, '无中生有'), state(4, a, [{ kind: 'handCount', before: 2, after: 4 }]), operation(5, twin, '火攻', [a, b])];
  const before = JSON.stringify(entries);
  const rendered = formatExperimental(log(entries));
  assert.match(rendered, /\[1-3\] 甲1 \{ 拆\[乙\]，乙（装备移出\+1马），无中 \}/);
  assert.match(rendered, /\[5\] 甲2 \{ 火攻\[甲1,乙\] \}/);
  assert.doesNotMatch(rendered, /手牌|\[4\] .*\{ *\}/);
  assert.doesNotMatch(rendered, /弃置|被弃/);
  assert.equal(JSON.stringify(entries), before);
});

test('state before first operator stays standalone; truncation and public zone changes remain visible', () => {
  const rendered = formatExperimental({ ...log([
    state(7, b, [{ kind: 'dying', after: true }, { kind: 'dead', after: true }]),
    operation(8, a, '清扫', [], 'skill'),
    state(9, b, [{ kind: 'maxHp', before: 4, after: 3 }, { kind: 'equipAdd', card: { name: '剑' } }, { kind: 'judgeAdd', card: { label: '乐不思蜀' } }, { kind: 'judgeRemove', card: { label: '兵粮寸断' } }]),
  ]), truncated: true });
  assert.match(rendered, /\[7-9\]（记录已截断）/);
  assert.match(rendered, /\[7\] 乙（濒死，死亡）\n/);
  assert.match(rendered, /体力上限-1，装备加入剑，判定区加入乐，判定区移出兵/);
});

test('unknown kinds are explicit without leaking unrelated fields or inferring meaning', () => {
  const rendered = formatExperimental(log([
    { seq: 1, kind: 'future', private: 'do-not-render' },
    state(2, b, [{ kind: 'newField', value: 'do-not-render' }, { kind: 'hp', amount: -2 }]),
    operation(3, a, '无中生有', [], 'skill'),
  ]));
  assert.match(rendered, /\[1\] 未支持事件\(future\)/);
  assert.match(rendered, /未支持状态\(newField\)，hp-2/);
  assert.match(rendered, /\{ 无中生有 \}/); // Skill names are never card abbreviations.
  assert.doesNotMatch(rendered, /do-not-render/);
});

test('empty and unavailable streams are distinct', () => {
  assert.match(formatExperimental({ coverage: 'unavailable', entries: [] }), /不可用/);
  assert.match(formatExperimental(log([])), /无新增事件/);
  assert.equal(formatExperimental(null), '实验战报不可用（experimental_log_unavailable）');
  assert.equal(formatExperimental({ available: false, entries: [] }), '实验战报不可用（experimental_log_unavailable）');
});

test('public card faces remain visible and ending dying does not imply rescue', () => {
  const row = operation(1, a, '雷杀', [b]);
  Object.assign(row.operation, { suit: 'spade', number: 7 });
  const rendered = formatExperimental(log([row, state(2, b, [{ kind: 'dying', after: false }, { kind: 'dead', after: true }])]));
  assert.match(rendered, /雷杀【♠7】/);
  assert.match(rendered, /濒死流程结束，死亡/);
  assert.doesNotMatch(rendered, /脱离濒死|获救/);
});

test('ordered selection batches and target supplements are distinct from repeated activation', () => {
  const skill = { kind: 'skill', label: '均田' };
  const rendered = formatExperimental(log([
    { seq: 1, kind: 'operation', operation: skill, actor: a, targets: [] },
    { seq: 2, kind: 'selection', operation: skill, actor: a, batch: 1, targets: [b, a] },
    { seq: 3, kind: 'selection', operation: skill, actor: a, batch: 2, targets: [b] },
    { seq: 4, kind: 'targets', operation: skill, actor: a, targets: [a] },
  ]));
  assert.match(rendered, /均田，均田·选目标1\[乙,甲\]，均田·选目标2\[乙\]，均田·目标\[甲\]/);
});

test('adjacent late target can render on its operation without rewriting evidence or crossing a state', () => {
  const op = { ...operation(1, a, '加盾', [], 'skill'), operationId: 'jo1' };
  const target = { seq: 2, kind: 'targets', actor: a, operation: op.operation, operationId: 'jo1', targets: [b] };
  const entries = [op, target, state(3, b, [{ kind: 'armor', amount: 1 }])];
  assert.match(formatExperimental(log(entries)), /加盾\[乙\]，乙（盾\+1）/);
  assert.deepEqual(op.targets, []);
  assert.match(formatExperimental(log([target])), /加盾·目标\[乙\]/);
  assert.match(formatExperimental(log([op, state(2, b, [{ kind: 'hp', amount: -1 }]), { ...target, seq: 3 }])), /加盾，乙（hp-1），加盾·目标/);
});

test('selection by another player names both the chooser and the skill owner', () => {
  const rendered = formatExperimental(log([{ seq: 1, kind: 'selection', actor: b, owner: a, operation: { kind: 'skill', label: '皇命' }, targets: [a], batch: 1 }]));
  assert.match(rendered, /乙 \{ 甲的皇命·选目标1\[甲\] \}/);
});

test('damage names actual source without changing operation ownership and keeps HP/armor components explicit',()=>{
  const text=formatExperimental(log([
    operation(1,b,'桃',[a]),
    state(2,b,[{kind:'damage',amount:3,hpLoss:1,armorAbsorbed:2,source:a,nature:'fire'}]),
    state(3,a,[{kind:'loseHp',amount:-1}]),
    state(4,b,[{kind:'recover',amount:1}]),
    state(5,b,[{kind:'damage',amount:1,hpLoss:0,armorAbsorbed:1,source:null}]),
  ]));
  assert.match(text,/乙 \{ 桃\[甲\]，乙（受火伤-3｜来源甲｜hp-1｜盾吸收2）/);
  assert.match(text,/流失体力-1/); assert.match(text,/回复体力\+1/);
  assert.match(text,/来源未知｜hp不变｜盾吸收1/);
  assert.equal((text.match(/ \{ /g)||[]).length,1);
});

test('ordinary damage is short; unusual HP loss retains components without changing JSON evidence',()=>{
  const rows = [
    state(1,b,[{kind:'damage',amount:1,hpLoss:1,armorAbsorbed:0,source:a,nature:''}]),
    state(2,b,[{kind:'damage',amount:2,hpLoss:2,armorAbsorbed:0,source:a,nature:'fire'}]),
    state(3,b,[{kind:'damage',amount:2,hpLoss:1,armorAbsorbed:0,source:null,nature:'thunder'}]),
  ];
  const before = JSON.stringify(rows), text = formatExperimental(log(rows));
  assert.match(text, /\[1-3\] 乙（受伤-1｜来源甲，受火伤-2｜来源甲，受雷伤-2｜来源未知｜hp-1｜盾吸收0）/);
  assert.equal(JSON.stringify(rows),before);
});

test('judgment is a system operation and material faces supplement an operation without implying consumption',()=>{
  const skill={...operation(1,a,'武圣',[],'skill'),operationId:'jo1'};
  const text=formatExperimental(log([
    skill,operation(2,a,'杀',[b]),
    {seq:3,kind:'materials',actor:a,operationId:'jo1',operation:skill.operation,cards:[{label:'闪',suit:'heart',number:9}]},
    {seq:4,kind:'operation',actor:{id:'system',label:'系统',system:true},operation:{kind:'judgment',card:{label:'杀',suit:'spade',number:7}},targets:[b]},
    operation(5,a,'后续',[],'skill'),
  ]));
  assert.match(text,/甲 \{ 武圣‹闪【♥9】›，杀\[乙\] \}/);
  assert.match(text,/系统 \{ 判定\[乙\]：杀【♠7】 \}/);
  assert.doesNotMatch(text,/消耗|弃置|判定·/);
});

test('materials immediately follow the operation name, while late batches stay explicit without rewriting prior output',()=>{
  const skill={...operation(1,a,'武圣',[b],'skill'),operationId:'jo1'};
  const material={seq:2,kind:'materials',actor:a,operationId:'jo1',operation:skill.operation,cards:[{label:'闪',suit:'heart',number:9}]};
  assert.match(formatExperimental(log([skill,material])),/武圣‹闪【♥9】›\[乙\]/);
  assert.match(formatExperimental(log([material])),/武圣·所用牌‹闪【♥9】›/);
  const differentActor=operation(2,b,'应答',[],'skill');
  assert.match(formatExperimental(log([skill,differentActor,{...material,seq:3}])),/甲 \{ 武圣·所用牌‹闪【♥9】› \}/);
  assert.deepEqual(skill.targets,[b]);
});

test('judgment closes its system block before later player state or another judgment',()=>{
  const judgment={seq:1,kind:'operation',actor:{id:'system',system:true},operation:{kind:'judgment',card:{label:'闪',suit:'heart',number:2}},targets:[b]};
  const text=formatExperimental(log([judgment,state(2,b,[{kind:'hp',amount:-1}]),{...judgment,seq:3}]));
  assert.match(text,/系统 \{ 判定\[乙\]：闪【♥2】 \}\n\[2\] 乙（hp-1）\n\[3\] 系统 \{/);
});

test('adjacent damage and armor combine without modifying evidence; cross-call supplements never repeat HP',()=>{
  const damage=state(1,b,[{kind:'damage',damageId:'jd1',amount:3,hpLoss:1,armorAbsorbed:null,source:a,nature:'fire'}]);
  const armor=state(2,b,[{kind:'damageArmor',damageId:'jd1',amount:2}]);
  const before=JSON.stringify([damage,armor]);
  assert.match(formatExperimental(log([damage])),/受火伤-3｜来源甲｜hp-1｜盾待结算/);
  assert.match(formatExperimental(log([damage,armor])),/\[1-2\] 乙（受火伤-3｜来源甲｜hp-1｜盾吸收2）/);
  const supplement=formatExperimental(log([armor]));
  assert.match(supplement,/乙（伤害补充：盾吸收2）/); assert.doesNotMatch(supplement,/hp-|受火伤|受伤|jd1/);
  const separated=formatExperimental(log([damage,operation(2,a,'子技能',[],'skill'),{...armor,seq:3}]));
  assert.match(separated,/盾待结算/); assert.match(separated,/伤害补充：盾吸收2/); assert.doesNotMatch(separated,/jd1/);
  assert.equal(JSON.stringify([damage,armor]),before);
});

test('context headings make an incremental window self-contained and only the current turn actor is bare', () => {
  const use = context(2, a, 'jt1', 'phaseUse', 'jp1');
  const text = formatExperimental(log([
    inContext(operation(10, a, '铁索连环', [b]), use),
    inContext(operation(11, b, '闪', [], 'respond'), use),
    inContext(state(12, b, [{ kind: 'armor', amount: 1 }]), use),
  ]));
  assert.match(text, /【第2轮】\n【甲的回合】\n【出牌阶段】/);
  assert.match(text, /\[10\] \{ 铁索\[乙\] \}/);
  assert.match(text, /\[11-12\] 乙 \{ 打出闪，乙（盾\+1） \}/);
  assert.doesNotMatch(text, /p1|p2|jt1|jp1|flow-test/);
});

test('real turn and phase identities flush blocks even when their visible headings repeat', () => {
  const first = context(3, a, 'jt1', 'phaseUse', 'jp1');
  const extraPhase = context(3, a, 'jt1', 'phaseUse', 'jp2');
  const extraTurn = context(3, a, 'jt2', 'phaseUse', 'jp3');
  const text = formatExperimental(log([
    inContext(operation(1, a, '先制', [], 'skill'), first),
    inContext(state(2, b, [{ kind: 'hp', amount: -1 }]), first),
    inContext(state(3, b, [{ kind: 'armor', amount: 1 }]), extraPhase),
    inContext(operation(4, a, '再动', [], 'skill'), extraTurn),
  ]));
  assert.match(text, /\[1-2\] \{ 先制，乙（hp-1） \}\n【出牌阶段】\n\[3\] 乙（盾\+1）/);
  assert.equal((text.match(/【甲的回合】/g) || []).length, 2);
  assert.equal((text.match(/【出牌阶段】/g) || []).length, 3);
});

test('missing entry context stays explicit and never borrows the final log context', () => {
  const finalContext = context(9, b, 'jt9', 'phaseJieshu', 'jp9');
  const text = formatExperimental({ ...log([operation(1, a, '无中生有')]), context: finalContext });
  assert.match(text, /【进程上下文未知】/);
  assert.match(text, /\[1\] 甲 \{ 无中 \}/);
  assert.doesNotMatch(text, /第9轮|乙的回合|结束阶段/);
});

test('empty feedback uses logs context while a missing context remains honest', () => {
  const located = formatExperimental({ ...log([]), context: context(4, b, 'jt4', 'phaseDiscard', 'jp4') });
  assert.match(located, /\[无新增事件\]\n【第4轮】\n【乙的回合】\n【弃牌阶段】/);
  assert.match(formatExperimental(log([])), /\[无新增事件\]\n【进程上下文未知】/);
});

test('same-name actors, targets and damage sources are readable without exposing ids', () => {
  const twin = { id: 'p3', label: '甲' };
  const turn = context(1, a, 'jt1', 'phaseUse', 'jp1');
  const text = formatExperimental(log([
    inContext(operation(1, a, '杀', [twin]), turn),
    inContext(operation(2, twin, '桃', [a]), turn),
    inContext(state(3, b, [{ kind: 'damage', amount: 1, hpLoss: 1, armorAbsorbed: 0, source: twin, damageId: 'jd7' }]), turn),
  ]));
  assert.match(text, /【甲1的回合】/);
  assert.match(text, /\[1\] \{ 杀\[甲2\] \}/);
  assert.match(text, /\[2-3\] 甲2 \{ 桃\[甲1\]，乙（受伤-1｜来源甲2） \}/);
  assert.doesNotMatch(text, /p1|p2|p3|jt1|jp1|jd7/);
});

test('movement renders actual semantics and only the cards explicitly public in that event', () => {
  const use = context(1, a, 'jt1', 'phaseUse', 'jp1');
  const cardA = { label: '杀', suit: 'spade', number: 7 };
  const entries = [
    { seq: 1, kind: 'movement', context: use, action: 'draw', actor: a, from: null, to: a, count: 2, cards: [] },
    { seq: 2, kind: 'movement', context: use, action: 'discard', actor: a, from: a, to: null, count: 2, cards: [cardA] },
    { seq: 3, kind: 'movement', context: use, action: 'gain', actor: b, from: a, to: b, count: 1, cards: [cardA] },
    { seq: 4, kind: 'movement', context: use, action: 'transfer', actor: a, from: a, to: b, count: 1, cards: [cardA] },
    { seq: 5, kind: 'movement', context: use, action: 'lose', actor: b, from: b, to: a, count: 1, cards: [] },
  ];
  const before = JSON.stringify(entries), text = formatExperimental(log(entries));
  assert.match(text, /\[1-2\] \{ 摸2张，弃置2张（公开：杀【♠7】） \}/);
  assert.match(text, /\[3\] 乙 \{ 从甲获得1张‹杀【♠7】› \}/);
  assert.match(text, /\[4\] 牌转移：甲→乙，1张‹杀【♠7】›/);
  assert.match(text, /\[5\] 乙 \{ 失去1张→甲 \}/);
  assert.doesNotMatch(text, /交给|移动/);
  assert.equal(JSON.stringify(entries), before);
});

test('stolen transfer is a neutral fact, never a voluntary action by the loser', () => {
  const use = context(1, a, 'jt1', 'phaseUse', 'jp1');
  const stolen = { label: '桃', suit: 'heart', number: 6 };
  const text = formatExperimental(log([
    inContext(operation(1, a, '顺手牵羊', [b]), use),
    { seq: 2, kind: 'movement', context: use, action: 'transfer', actor: b, from: b, to: a, count: 1, cards: [stolen], operationId: 'jo1' },
  ]));
  assert.match(text, /\[1\] \{ 顺\[乙\] \}\n\[2\] 牌转移：乙→甲，1张‹桃【♥6】›/);
  assert.doesNotMatch(text, /乙 \{[^\n]*交给|乙交给|主动|移动/);
});

test('public roster keeps same-name ordinals stable across separate incremental windows', () => {
  const first = { id: 'fp2', label: '同名' }, second = { id: 'fp10', label: '同名' }, players = [second, first];
  const firstWindow = formatExperimental({ ...log([operation(1, first, '无中生有')]), players });
  const secondWindow = formatExperimental({ ...log([operation(2, second, '桃')]), players: players.slice().reverse() });
  assert.match(firstWindow, /同名1 \{ 无中 \}/);
  assert.match(secondWindow, /同名2 \{ 桃 \}/);
  assert.doesNotMatch(firstWindow + secondWindow, /fp2|fp10/);
});

test('hidden-player id fallback stays private in headings, actors, targets and sources', () => {
  const hidden1 = { id: 'fp7', name: null, label: 'fp7' }, hidden2 = { id: 'fp8', name: null, label: 'fp8' };
  const use = context(2, hidden1, 'jt-hidden', 'phaseUse', 'jp-hidden');
  const entries = [
    inContext(operation(1, hidden1, '杀', [hidden2]), use),
    inContext(operation(2, b, '桃', [hidden1]), use),
    inContext(state(3, b, [{ kind: 'damage', amount: 1, hpLoss: 1, armorAbsorbed: 0, source: hidden2 }]), use),
    { seq: 4, kind: 'movement', context: use, action: 'gain', actor: hidden2, from: hidden1, to: hidden2, count: 1, cards: [] },
  ];
  const input = { ...log(entries), players: [hidden2, b, hidden1] }, before = JSON.stringify(input);
  const text = formatExperimental(input);
  assert.match(text, /【未知角色1的回合】/);
  assert.match(text, /\[1\] \{ 杀\[未知角色2\] \}/);
  assert.match(text, /乙 \{ 桃\[未知角色1\]，乙（受伤-1｜来源未知角色2） \}/);
  assert.match(text, /未知角色2 \{ 从未知角色1获得1张 \}/);
  assert.doesNotMatch(text, /fp7|fp8|jt-hidden|jp-hidden/);
  assert.equal(JSON.stringify(input), before);
});

test('legacy handCount-only windows have no fake movement or empty action range', () => {
  const old = state(7, a, [{ kind: 'handCount', before: 1, after: 4 }]);
  const text = formatExperimental({ ...log([old]), context: context(1, a, 'jt1', 'phaseDraw', 'jp1') });
  assert.match(text, /\[7\]（无可显示事件）/);
  assert.doesNotMatch(text, /手牌|摸3|弃置|获得|\{ *\}/);
});

test('consecutive state events merge by recipient and omit only the current turn owner', () => {
  const use = context(6, a, 'jt6', 'phaseUse', 'jp6');
  const horse = { label: '爪黄飞电', suit: 'heart', number: 13 };
  const text = formatExperimental(log([
    inContext(state(254, a, [{ kind: 'damage', amount: 3, hpLoss: 3, armorAbsorbed: 0, source: null, nature: 'thunder' }]), use),
    inContext(state(255, a, [{ kind: 'dying', after: true }]), use),
    inContext(state(256, a, [{ kind: 'dying', after: false }]), use),
    inContext(state(257, a, [{ kind: 'dead', after: true }]), use),
    inContext(state(258, a, [{ kind: 'hp', amount: 1 }]), use),
    inContext(state(259, a, [{ kind: 'equipRemove', card: horse }]), use),
  ]));
  assert.match(text, /\[254-259\] （受雷伤-3｜来源未知，濒死，濒死流程结束，死亡，hp\+1，装备移出爪黄飞电【♥13】）/);
  assert.doesNotMatch(text, /甲（/);
});

test('another recipient keeps its name and breaks a bare state run without changing its owner', () => {
  const use = context(1, a, 'jt1', 'phaseUse', 'jp1');
  const text = formatExperimental(log([
    inContext(state(1, a, [{ kind: 'hp', amount: -1 }]), use),
    inContext(state(2, b, [{ kind: 'armor', amount: 1 }]), use),
    inContext(state(3, b, [{ kind: 'hp', amount: -1 }]), use),
    inContext(state(4, a, [{ kind: 'recover', amount: 1 }]), use),
  ]));
  assert.match(text, /\[1\] （hp-1）\n\[2-3\] 乙（盾\+1，hp-1）\n\[4\] （回复体力\+1）/);
});

test('actions and real phase identities split state runs while action-attached states stay compatible', () => {
  const use = context(2, a, 'jt2', 'phaseUse', 'jp-use');
  const extraUse = context(2, a, 'jt2', 'phaseUse', 'jp-extra');
  const text = formatExperimental(log([
    inContext(operation(1, a, '自愈', [], 'skill'), use),
    inContext(state(2, a, [{ kind: 'hp', amount: 1 }]), use),
    inContext(state(3, a, [{ kind: 'armor', amount: 1 }]), use),
    inContext(operation(4, a, '后续', [], 'skill'), use),
    inContext(state(5, a, [{ kind: 'hp', amount: -1 }]), use),
    inContext(state(6, a, [{ kind: 'dying', after: true }]), extraUse),
  ]));
  assert.match(text, /\[1-5\] \{ 自愈，（hp\+1，盾\+1），后续，（hp-1） \}/);
  assert.match(text, /【出牌阶段】\n\[6\] （濒死）/);
  assert.doesNotMatch(text, /（hp\+1，盾\+1，hp-1|（hp-1，濒死/);
});

test('turn owner states leave another player response block and preserve subsequent action boundaries', () => {
  const dingzhen = { id: 'fp2', label: '丁真' }, yinhua = { id: 'fp1', label: '殷华' };
  const turn = context(1, dingzhen, 'jt2', 'phaseUse', 'jp10');
  const response = { ...operation(64, yinhua, '雷杀', [], 'respond'), operationId: 'jo40' };
  const text = formatExperimental(log([
    inContext(response, turn),
    inContext({ seq: 65, kind: 'materials', actor: yinhua, operationId: 'jo40', operation: response.operation, cards: [{ label: '雷杀', suit: 'club', number: 8 }] }, turn),
    inContext(state(66, dingzhen, [{ kind: 'damage', amount: 1, hpLoss: 1, armorAbsorbed: 0, source: yinhua }]), turn),
    inContext(state(67, dingzhen, [{ kind: 'dying', after: true }]), turn),
    inContext(operation(68, yinhua, '桃', [dingzhen]), turn),
    inContext(state(69, dingzhen, [{ kind: 'recover', amount: 1 }]), turn),
    inContext(operation(70, dingzhen, '后续', [], 'skill'), turn),
  ]));
  assert.match(text, /\[64-65\] 殷华 \{ 打出雷杀【♣8】 \}\n\[66-67\] （受伤-1｜来源殷华，濒死）/);
  assert.match(text, /\[68\] 殷华 \{ 桃\[丁真\] \}\n\[69\] （回复体力\+1）\n\[70\] \{ 后续 \}/);
});

test('identical single materials fold into card faces without hiding conversion, multiple materials or skill costs', () => {
  const cases = [
    [{ kind: 'card', label: '雷杀', name: 'sha', nature: 'thunder' }, [{ label: '雷杀', name: 'sha', nature: 'thunder', suit: 'spade', number: 5 }], '雷杀【♠5】[乙]'],
    [{ kind: 'card', label: '朱雀羽扇' }, [{ label: '朱雀羽扇', suit: 'diamond', number: 1 }], '朱雀羽扇【♦1】[乙]'],
    [{ kind: 'respond', label: '杀' }, [{ label: '杀', suit: 'spade', number: 9 }], '打出杀【♠9】[乙]'],
    [{ kind: 'card', label: '雷杀', name: 'sha', nature: 'thunder' }, [{ label: '杀', name: 'sha', suit: 'spade', number: 8 }], '雷杀‹杀【♠8】›[乙]'],
    [{ kind: 'card', label: '无中生有' }, [{ label: '火杀', suit: 'diamond', number: 4 }], '无中‹火杀【♦4】›[乙]'],
    [{ kind: 'skill', label: '残言' }, [{ label: '火杀', suit: 'diamond', number: 4 }], '残言‹火杀【♦4】›[乙]'],
    [{ kind: 'card', label: '杀' }, [{ label: '杀', suit: 'spade', number: 9 }, { label: '杀', suit: 'club', number: 9 }], '杀‹杀【♠9】、杀【♣9】›[乙]'],
    [{ kind: 'card', label: '杀', suit: 'heart', number: 1 }, [{ label: '杀', suit: 'spade', number: 9 }], '杀【♥1】‹杀【♠9】›[乙]'],
    [{ kind: 'card', label: '杀', nature: 'thunder' }, [{ label: '杀', suit: 'spade', number: 9 }], '杀‹杀【♠9】›[乙]'],
    [{ kind: 'card', label: '雷杀', suit: 'spade', number: 5 }, [{ label: '雷杀', suit: 'spade', number: 5 }], '雷杀【♠5】[乙]'],
  ];
  for (const [operation, cards, expected] of cases) {
    const input = log([
      { seq: 1, kind: 'operation', actor: a, operationId: 'jo1', operation, targets: [b] },
      { seq: 2, kind: 'materials', actor: a, operationId: 'jo1', operation, cards },
    ]);
    const before = JSON.stringify(input);
    assert.ok(formatExperimental(input).includes(`甲 { ${expected} }`), expected);
    assert.equal(JSON.stringify(input), before);
  }
});

test('later material batches restore the full list and retain targets, while separate windows remain explicit', () => {
  const op = { ...operation(1, a, '杀'), operationId: 'jo1' };
  const material = { seq: 2, kind: 'materials', actor: a, operationId: 'jo1', operation: op.operation, cards: [{ label: '杀', suit: 'spade', number: 9 }] };
  const target = { seq: 3, kind: 'targets', actor: a, operationId: 'jo1', operation: op.operation, targets: [b] };
  const second = { ...material, seq: 4, cards: [{ label: '杀', suit: 'club', number: 9 }] };
  assert.match(formatExperimental(log([op, material, target, second])), /杀‹杀【♠9】、杀【♣9】›，杀·目标\[乙\]/);
  assert.match(formatExperimental(log([op, { ...target, seq: 2 }, { ...material, seq: 3 }])), /杀【♠9】\[乙\]/);
  assert.match(formatExperimental(log([material])), /杀·所用牌‹杀【♠9】›/);
});
