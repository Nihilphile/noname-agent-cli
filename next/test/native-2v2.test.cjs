'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { prepare, restart, chooseCharacter, validateOptions } = require('../src/native-setup.cjs');

function fixture({ actualMode = 'versus', actualSubmode = 'two', settings = {}, afterSelection } = {}) {
  const config = {
    mode: 'doudizhu', characters: ['nihilphile', 'standard'], extensions: ['Nihilphile'],
    versus_banned: ['banned_general'], forbidai: ['nihil_yinhua'], auto_confirm: true,
    mode_config: { doudizhu: { doudizhu_mode: 'normal' }, versus: {
      versus_mode: 'four', free_choose: false, two_assign: false,
      replace_character_two: false, two_phaseswap: false, ...settings,
    } },
  };
  const writes = [], navigations = [], storage = new Map(), window = {};
  let runningMode = 'doudizhu';
  const modules = {
    lib: { config, configprefix: 'noname_', character: { nihil_yinhua: {} }, characterPack: {}, characterFilter: {} },
    game: { me: {}, promises: { saveConfig: async (key, value, mode) => {
      writes.push({ key, value, mode });
      if (mode) config.mode_config[mode][key] = value; else config[key] = value;
    } } },
    get: { mode: () => runningMode, translation: value => value },
    ui: { dialogs: [], selected: { buttons: [] } },
    _status: { event: { name: 'chooseButton' }, mode: 'normal' },
  };
  const button = { link: 'nihil_yinhua', classList: { contains: value => value === 'selectable' }, click: () => {
    modules.game.me.name1 = 'nihil_yinhua';
    modules._status.event = { name: 'phase' };
    if (afterSelection) modules._status.mode = afterSelection;
  } };
  const dialog = { buttons: [button], querySelector: () => null };
  modules._status.event.dialog = dialog;
  modules.ui.cheat2 = { dialog, classList: { contains: () => false } };
  const document = { readyState: 'complete', querySelectorAll: () => [{ textContent: JSON.stringify({ imports: { vue: '/vue.js', noname: '/noname.js' } }) }] };
  const cdp = {
    evaluate: async code => vm.runInNewContext(code.replace("await import('/noname.js')", 'modules'), {
      modules, document, window, URL, location: { href: 'http://localhost:8089/index.html' },
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    }),
    send: async (method, params) => {
      navigations.push({ method, params });
      runningMode = actualMode;
      modules._status.mode = actualSubmode;
    },
  };
  return { config, modules, cdp, writes, navigations, storage };
}

test('2v2 alias preserves original intent and persists versus/two while preserving content and rules', async () => {
  assert.equal(validateOptions({ mode: '2v2' }).mode, '2v2');
  const f = fixture();
  const before = structuredClone(f.config);
  let recorded;
  const result = await prepare(f.cdp, { mode: '2v2', onConfigChanges: changes => { recorded = changes; } });
  assert.equal(result.mode, 'versus');
  assert.equal(result.submode, 'two');
  assert.equal(result.state, 'character_selection');
  assert.deepEqual(f.writes, [
    { key: 'mode', value: 'versus', mode: undefined },
    { key: 'versus_mode', value: 'two', mode: 'versus' },
    { key: 'free_choose', value: true, mode: 'versus' },
  ]);
  before.mode = 'versus'; before.mode_config.versus.versus_mode = 'two'; before.mode_config.versus.free_choose = true;
  assert.deepEqual(f.config, before);
  assert.equal(recorded.find(change => change.key === 'versus_mode').before, 'four');
  assert.equal(recorded.find(change => change.key === 'versus_mode').after, 'two');
  assert.equal(recorded.find(change => change.key === 'versus_mode').mode, 'versus');
  assert.equal(f.storage.get('noname_directstart'), 'true');
});

for (const [actualMode, actualSubmode] of [['versus', 'four'], ['identity', 'two']]) {
  test(`2v2 rejects actual engine ${actualMode}/${actualSubmode} despite successfully saved versus/two config`, async () => {
    const f = fixture({ actualMode, actualSubmode });
    await assert.rejects(prepare(f.cdp, { mode: '2v2' }), { code: 'unexpected_game_mode' });
    assert.equal(f.config.mode, 'versus');
    assert.equal(f.config.mode_config.versus.versus_mode, 'two');
    assert.equal(f.modules.game.me.name1, undefined);
  });
}

for (const key of ['two_assign', 'replace_character_two', 'two_phaseswap']) {
  test(`2v2 explains incompatible ${key} before any configuration or navigation changes`, async () => {
    const f = fixture({ settings: { [key]: true } });
    const before = structuredClone(f.config);
    await assert.rejects(prepare(f.cdp, { mode: '2v2', character: 'nihil_yinhua' }), error => {
      assert.equal(error.code, 'unsupported_2v2_settings');
      assert.ok(error.message.includes(key));
      assert.ok(error.message.includes('对决 → 2v2'));
      return true;
    });
    assert.deepEqual(f.config, before);
    assert.equal(f.writes.length, 0); assert.equal(f.navigations.length, 0); assert.equal(f.storage.size, 0);
  });
}

test('directed 2v2 choice observes actual character commit, and restart accepts original alias', async () => {
  const f = fixture();
  const result = await restart(f.cdp, { mode: '2v2', character: 'nihil_yinhua' });
  assert.equal(result.mode, 'versus'); assert.equal(result.submode, 'two');
  assert.equal(result.character, f.modules.game.me.name1);
  assert.equal(result.state, 'character_selected');
});

test('2v2 directed selection validates actual submode again after native confirmation', async () => {
  const f = fixture({ afterSelection: 'four' });
  await assert.rejects(prepare(f.cdp, { mode: '2v2', character: 'nihil_yinhua' }), { code: 'unexpected_game_mode' });
});

test('separate character command also preserves and rejects unsupported native 2v2 configuration', async () => {
  const f = fixture({ settings: { two_assign: true } });
  await f.cdp.send('Page.navigate', {});
  await assert.rejects(chooseCharacter(f.cdp, { character: 'nihil_yinhua' }), { code: 'unsupported_2v2_settings' });
  assert.equal(f.modules.game.me.name1, undefined);
  assert.equal(f.writes.length, 0);
});
