'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { lookupCharacter, character } = require('../src/character.cjs');

function fixture() {
  const entry = ['female', 'custom-faction', '3/5/2', ['stranger_rule'], []];
  const lib = { character: { arbitrary_hero: entry }, characterPack: { friends: { arbitrary_hero: entry } }, config: { banned: [], forbidai: [] }, translate: { arbitrary_hero: '<b>陌生角色</b>', stranger_rule: '陌生规则', stranger_rule_info: '每次<b>事件</b>后，摸一张牌。' }, skill: { stranger_rule: { group: ['stranger_rule_tick'] } }, dynamicTranslate: new Proxy({}, { get() { throw Error('private dynamic tooltip accessed'); } }) };
  return { lib, get: { mode: () => 'identity', skillInfoTranslation() { throw Error('player tooltip accessed'); }, translation() { throw Error('unnecessary translation callback'); } } };
}

test('arbitrary tuple character exposes static rules without a live player', () => {
  const f = fixture(); const result = lookupCharacter(f, 'arbitrary_hero');
  assert.equal(result.scope, 'static_public_catalog');
  const c = result.character;
  assert.equal(c.name, '陌生角色'); assert.equal(c.sex, 'female'); assert.equal(c.group, 'custom-faction');
  assert.deepEqual([c.hp, c.maxHp, c.armor], [3, 5, 2]); assert.equal(c.available, true);
  assert.equal(c.skills.length, 1); assert.equal(c.skills[0].description, '每次事件后，摸一张牌。');
  assert.deepEqual(c.skills[0].group, ['stranger_rule_tick']);
});

test('disabled pack remains inspectable but is not selectable', () => {
  const f = fixture(); delete f.lib.character.arbitrary_hero;
  const c = lookupCharacter(f, 'arbitrary_hero').character;
  assert.equal(c.available, false); assert.equal(c.reason, 'pack_not_enabled');
  assert.equal(c.skills[0].descriptionSource, 'static_public_rule'); assert.deepEqual(c.packs, ['friends']);
});

test('character ID lookup is exact, own-key only, and does not fuzzy-match translated names', () => {
  const f = fixture();
  for (const id of ['arbitrary', '陌生角色', 'toString', 'ARBITRARY_HERO']) assert.equal(lookupCharacter(f, id).error.code, 'character_not_found');
  for (const id of ['', null, ' arbitrary_hero ']) assert.equal(lookupCharacter(f, id).error.code, 'invalid_character');
});

test('object definitions respect maxHP, armor, tuple bans and AI restrictions', () => {
  const f = fixture(); f.lib.character.arbitrary_hero = { sex: 'male', group: 'wei', hp: 4, skills: [], isAiForbidden: true };
  let c = lookupCharacter(f, 'arbitrary_hero').character;
  assert.equal(c.maxHp, 4); assert.equal(c.armor, 0); assert.equal(c.aiAllowed, false); assert.equal(c.available, true);
  f.lib.character.arbitrary_hero = ['male', 'wei', 4, [], ['boss', 'forbidai']];
  c = lookupCharacter(f, 'arbitrary_hero').character;
  assert.equal(c.reason, 'not_offered_by_free_choice'); assert.equal(c.aiAllowed, false);
  f.lib.character.arbitrary_hero[4].push('bossallowed');
  assert.equal(lookupCharacter(f, 'arbitrary_hero').character.available, true);
  f.lib.config.banned.push('arbitrary_hero');
  assert.equal(lookupCharacter(f, 'arbitrary_hero').character.reason, 'banned_in_current_mode');
});

test('sourceSkill falls back to a public parent rule, not dynamic code or grouped ownership', () => {
  const f = fixture(); delete f.lib.translate.stranger_rule_info;
  f.lib.skill.stranger_rule.sourceSkill = 'parent_rule'; f.lib.translate.parent_rule_info = '公开父规则';
  let skill = lookupCharacter(f, 'arbitrary_hero').character.skills[0];
  assert.equal(skill.descriptionSkill, 'parent_rule'); assert.equal(skill.description, '公开父规则');
  delete f.lib.translate.parent_rule_info; f.lib.skill.parent_rule = { sourceSkill: 'stranger_rule' };
  skill = lookupCharacter(f, 'arbitrary_hero').character.skills[0];
  assert.equal(skill.descriptionSource, 'unavailable'); assert.equal(skill.description, null);
});

test('missing static text and failed custom availability checks remain explicit', () => {
  const f = fixture(); f.lib.characterFilter = { arbitrary_hero() { throw Error('custom content failure'); } };
  f.lib.translate.stranger_rule_info = () => 'do not invoke';
  const c = lookupCharacter(f, 'arbitrary_hero').character;
  assert.equal(c.reason, 'availability_check_failed'); assert.equal(c.skills[0].description, null);
  f.lib.character.arbitrary_hero[2] = '∞';
  assert.equal(lookupCharacter(f, 'arbitrary_hero').character.hp, 'Infinity');
});

test('renderer transport is shared with native/isolated and guards native import readiness', async () => {
  const modules = fixture(); let imports = 0;
  const document = { readyState: 'complete', querySelectorAll: () => [{ textContent: JSON.stringify({ imports: { vue: '/vue.js', noname: '/noname.js' } }) }] };
  const cdp = { evaluate: code => vm.runInNewContext(code.replace("await import('/noname.js')", 'loadModules()'), { loadModules: () => { imports++; return modules; }, document, URL, location: { href: 'http://localhost:8089/index.html' } }) };
  assert.equal((await character(cdp, 'arbitrary_hero')).character.id, 'arbitrary_hero');
  assert.equal((await require('../src/native-setup.cjs').character(cdp, 'arbitrary_hero')).character.id, 'arbitrary_hero');
  assert.equal((await require('../src/setup.cjs').character(cdp, 'arbitrary_hero')).character.id, 'arbitrary_hero');
  await assert.rejects(character(cdp, 'unknown'), { code: 'character_not_found' });
  const before = imports; document.readyState = 'loading';
  await assert.rejects(character(cdp, 'arbitrary_hero', { native: true }), /native_entry_not_ready/);
  assert.equal(imports, before);
});
