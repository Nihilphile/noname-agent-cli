'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatLogs } = require('../src/log-format.cjs');
const journal = texts => ({ epoch: 'battle-epoch', from: 13, to: 12 + texts.length, entries: texts.map((text, i) => ({ seq: 13 + i, text })), truncated: false });

test('adjacent actor lines merge in chronological order with original sequence ranges', () => {
  const log = journal(['甲的回合开始', '甲摸了两张牌', '乙打出了闪【♥︎J】', '甲对乙使用了乐不思蜀【♣︎10】', '甲对乙使用了兵粮寸断【♦︎A】']);
  const text = formatLogs(log, { actors: ['甲', '乙'] });
  assert.match(text, /^战报 battle-epoch\n\[13-17\]/);
  assert.match(text, /\[13-14\] 甲：回合开始；摸2\n\[15\] 乙：打出闪【♥︎J】\n\[16-17\] 甲：用乐【♣︎10】→乙；用兵【♦︎A】→乙/);
});

test('only card syntax gets abbreviations, never actor, target or skill names', () => {
  const log = journal(['乐不思蜀对顺手牵羊使用了过河拆桥【♣︎3】', '乐不思蜀对顺手牵羊发动了【过河拆桥】', '乐不思蜀使用了无中生有', '乐不思蜀使用了无懈可击', '乐不思蜀使用了火攻', '乐不思蜀使用了自制奇牌【♠︎K】']);
  const text = formatLogs(log, { actors: ['乐不思蜀', '顺手牵羊'] });
  assert.match(text, /乐不思蜀：用拆【♣︎3】→顺手牵羊；发动【过河拆桥】→顺手牵羊；用无中；用无懈；用火攻；用自制奇牌【♠︎K】/);
});

test('damage, explicit HP loss, recovery, upper limit changes and source remain distinct', () => {
  const log = journal(['乙受到了来自甲的两点伤害', '乙受到了来自甲的一点火焰伤害', '乙失去了一点体力', '乙减少了一点体力上限', '乙回复了一点体力', '乙增加了两点体力上限']);
  const text = formatLogs(log, { actors: ['甲', '乙'] });
  assert.match(text, /受伤2←甲；受火焰伤1←甲；hp-1；上限-1；hp\+1；上限\+2/);
  assert.equal((text.match(/hp-1/g) || []).length, 1, 'only explicit loseHp becomes hp-1');
});

test('dying and rescue are not invented as a death or causally linked outcome', () => {
  const text = formatLogs(journal(['甲濒死', '乙对甲使用了桃【♦︎3】', '甲回复了一点体力']), { actors: ['甲', '乙'] });
  assert.match(text, /甲：濒死\n\[14\] 乙：用桃【♦︎3】→甲\n\[15\] 甲：hp\+1/);
  assert.ok(!text.includes('死亡')); assert.ok(!text.includes('杀害')); assert.ok(!text.includes('因此'));
});

test('unknown custom and negated lines remain verbatim and break groups', () => {
  const texts = ['甲摸了一张牌', '未知技能：甲对乙使用了顺手牵羊但取消', '甲摸了一张牌', '甲没有使用了无中生有', '甲减少了梦境上限', '甲展示了未定义概念'];
  const text = formatLogs(journal(texts), { actors: ['甲', '乙'] });
  for (const index of [1, 3, 4, 5]) assert.ok(text.includes(`[${index + 13}] ${texts[index]}`));
  assert.match(text, /\[13\] 甲：摸1\n\[14\] 未知技能/); assert.match(text, /\[15\] 甲：摸1\n\[16\] 甲没有/);
});

test('raw is exact, input is untouched, truncation and repeated lines remain traceable', () => {
  const log = journal(['甲摸了一张牌', '甲摸了一张牌', '甲对乙使用了顺手牵羊【♠︎4】']); log.truncated = true;
  const before = JSON.stringify(log);
  assert.equal(formatLogs(log, { raw: true }), '战报 battle-epoch\n[13-15]（记录已截断）\n[13] 甲摸了一张牌\n[14] 甲摸了一张牌\n[15] 甲对乙使用了顺手牵羊【♠︎4】');
  assert.match(formatLogs(log, { actors: ['甲', '乙'] }), /\[13-15\] 甲：摸1；摸1；用顺【♠︎4】→乙/);
  assert.equal(JSON.stringify(log), before);
});

test('nonconsecutive or repeated sequence numbers never become a misleading range', () => {
  const log = journal(['甲摸了一张牌', '甲摸了一张牌', '甲摸了一张牌']); log.entries[1].seq = 17; log.entries[2].seq = 17;
  const text = formatLogs(log, { actors: ['甲'] });
  assert.match(text, /\[13\] 甲：摸1\n\[17\] 甲：摸1\n\[17\] 甲：摸1/);
});

test('card lists and judgment slots preserve cards, ranks, source and usage vs response', () => {
  const text = formatLogs(journal(['甲弃置了顺手牵羊【♠︎4】、过河拆桥【♦︎Q】', '甲进行兵粮寸断判定，亮出的判定牌为火杀【♦︎5】', '甲的判定结果为过河拆桥【♠︎Q】', '甲从乙获得了顺手牵羊【♠︎4】', '甲使用了杀', '甲打出了杀']), { actors: ['甲', '乙'] });
  assert.match(text, /弃置顺【♠︎4】、拆【♦︎Q】；兵判定：火杀【♦︎5】；判定结果：拆【♠︎Q】；从乙获得顺【♠︎4】；用杀；打出杀/);
});

test('unknown or ambiguous actor boundaries always keep original text including negation and hypotheticals', () => {
  assert.match(formatLogs(journal(['陌生角色摸了一张牌'])), /\[13\] 陌生角色摸了一张牌/);
  assert.match(formatLogs(journal(['特殊对手摸了一张牌'])), /\[13\] 特殊对手摸了一张牌/);
  assert.match(formatLogs(journal(['陌生角色摸了一张牌']), { actors: ['甲'] }), /\[13\] 陌生角色摸了一张牌/);
  assert.match(formatLogs(journal(['甲摸了一张牌']), { actors: ['甲', '甲'] }), /\[13\] 甲摸了一张牌/);
  assert.match(formatLogs(journal(['甲没有使用了无中生有'])), /\[13\] 甲没有使用了无中生有/);
  assert.match(formatLogs(journal(['甲拒绝使用了杀'])), /\[13\] 甲拒绝使用了杀/);
  for (const phrase of ['甲未死亡', '甲不会死亡', '甲不濒死', '甲本应摸了两张牌', '甲幸免于死亡']) {
    assert.equal(formatLogs(journal([phrase])).split('\n').at(-1), '[13] ' + phrase);
    assert.equal(formatLogs(journal([phrase]), { actors: ['甲'] }).split('\n').at(-1), '[13] ' + phrase);
  }
  assert.match(formatLogs(journal(['甲未死亡']), { actors: ['甲', '甲未'] }), /\[13\] 甲未死亡/);
});

test('empty log view is explicit instead of a reversed sequence range', () => {
  assert.equal(formatLogs({ epoch: 'battle', from: 1, to: 0, entries: [] }), '战报 battle\n[无新增日志]');
});

test('Chinese card abbreviations use first characters except fire attack and ambiguous names', () => {
  const text = formatLogs(journal(['甲使用了南蛮入侵', '甲使用了万箭齐发', '甲使用了五谷丰登', '甲使用了铁索连环', '甲使用了借刀杀人', '甲使用了决斗', '甲使用了桃园结义', '甲使用了桃']), { actors: ['甲'] });
  assert.match(text, /用南；用万；用五；用铁；用借；用决；用桃园；用桃/);
});
