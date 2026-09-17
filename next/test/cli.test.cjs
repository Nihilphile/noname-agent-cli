'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatState, parse, render } = require('../bin/noname.cjs');

test('compact output omits absent skill state while detailed output preserves it', () => {
  const state = { state: 'choice', me: { identity: {}, hand: [], equipment: [], judgments: [], marks: [] }, players: [] };
  assert.equal(formatState(state).includes('技能状态'), false);
  state.me.skillState = { used: { example: 1 }, awakened: [], disabled: [], temporary: [] };
  assert.ok(formatState(state).includes('技能状态 {"used":{"example":1}'));
});

test('state_hide removes board text but preserves the current actionable choice and raw log escape hatch', () => {
  const state = { state: 'choice', revision: 'game:8', me: { label: '甲', identity: {}, hp: 2, maxHp: 4, hand: [], equipment: [], judgments: [], marks: [] }, players: [],
    choice: { event: 'chooseToUse', prompt: '请选择', constraints: {}, options: [{ id: 'c1', kind: 'card', label: '无中生有' }] },
    log: { epoch: 'game', from: 13, to: 13, entries: [{ seq: 13, text: '甲摸了两张牌' }] } };
  const text = formatState(state, { state: 'hide', raw: true });
  assert.doesNotMatch(text, /HP 2\/4|自身装备|自身标记/);
  assert.match(text, /revision game:8/);
  assert.match(text, /c1 card 无中生有/);
  assert.match(text, /\[13\] 甲摸了两张牌/);
  assert.equal(JSON.parse(render(state, true, { state: 'hide' })).me, undefined);
  assert.equal(JSON.parse(render(state, true)).me.hp, 2);
  assert.deepEqual(parse(['act', 'c1', '--state_hide', '--raw', '--at', 'game:8']).options, { state_hide: true, raw: true, at: 'game:8' });
});
