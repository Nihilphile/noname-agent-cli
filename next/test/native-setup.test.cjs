'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { prepare, characters, chooseCharacter } = require('../src/native-setup.cjs');
function mock(config) {
  const writes = [], storage = new Map(), calls = [], imports = [];
  const window = {};
  const document = { readyState: 'complete', querySelectorAll: () => [{ textContent: JSON.stringify({ imports: { vue: '/vue.js', noname: '/noname.js' } }) }] };
  class Player {
    constructor() { Object.assign(this, { playerid: 'me-id', hujia: 0, actionHistory: [] }); }
    getCards() { return []; }
    isDead() { return false; }
    logSkill() {}
    update() {}
  }
  class GameEvent {
    constructor(name, props = {}) { Object.assign(this, { name, finished: false }, props); }
    async loop() { await this.run?.(); this.finished = true; }
    trigger() {}
  }
  const me = new Player();
  const modules = { lib: { config, configprefix: 'noname_', element: { Player, GameEvent }, skill: { nihil_yinshang: { forced: true }, nihil_yinshang_init: { charlotte: true, popup: false, sourceSkill: 'nihil_yinshang' } }, translate: { nihil_yinshang: '殷殇', nihil_yinshang_info: '公开锁定技' }, character: { nihil_yinhua: {}, zus_test: {} }, characterPack: { nihilphile: { nihil_yinhua: {} }, zus: { zus_test: {} } }, characterFilter: {} }, game: { me, players: [me], dead: [], promises: { saveConfig: async (key, value, mode) => { writes.push({ key, value, mode }); if (mode) config.mode_config[mode][key] = value; else config[key] = value; } } }, ui: { cheat2: { classList: { contains: () => false } }, dialogs: [] }, get: { mode: () => config.mode, translation: x => x, plainText: x => x }, _status: { event: { name: 'chooseButton' }, dying: [], globalHistory: [] } };
  const cdp = { evaluate: async code => { const transformed = code.replace("await import('/noname.js')", 'loadModules()'); return vm.runInNewContext(transformed, { modules, loadModules: () => { imports.push('noname'); return modules; }, document, window, URL, location: { href: 'http://localhost:8089/index.html' }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } }); }, send: async method => calls.push(method) };
  return { cdp, modules, writes, storage, calls, document, imports, window };
}
test('native setup only changes requested mode and free choice; preserves user content and rules', async () => {
  const config = { mode: 'identity', characters: ['nihilphile', 'friends'], extensions: ['Nihilphile', 'Friends'], forbidai: ['nihil_yinhua'], identity_banned: ['some_other'], auto_confirm: true, mode_config: { identity: {}, doudizhu: { doudizhu_mode: 'normal', free_choose: false } } };
  const preserved = JSON.stringify({ ...config, mode: undefined, mode_config: undefined }); const f = mock(config); let recorded;
  const result = await prepare(f.cdp, { mode: 'doudizhu', onConfigChanges: changes => { recorded = changes; } });
  assert.equal(result.state, 'character_selection'); assert.deepEqual(f.writes.map(x => x.key), ['mode', 'free_choose']);
  assert.ok(f.window.__nonameFlow, 'event observation must be installed while character selection is still pending');
  assert.equal(JSON.stringify({ ...config, mode: undefined, mode_config: undefined }), preserved);
  assert.equal(recorded.length, 3); assert.equal(f.calls[0], 'Page.navigate');
});
test('catalog distinguishes human availability from AI prohibition and excludes zus as test candidate', async () => {
  const f = mock({ mode: 'identity', mode_config: { identity: {} }, forbidai: ['nihil_yinhua'], banned: [] });
  const result = await characters(f.cdp); const yinhua = result.characters.find(x => x.id === 'nihil_yinhua');
  assert.equal(yinhua.available, true); assert.equal(yinhua.aiAllowed, false); assert.equal(yinhua.testCandidate, true);
  assert.equal(result.characters.find(x => x.id === 'zus_test').testCandidate, false);
});
test('unsupported existing double-general mode is explained without changing settings', async () => {
  const f = mock({ mode: 'identity', mode_config: { identity: { double_character: true } } });
  await assert.rejects(prepare(f.cdp), /double-character/); assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0);
});
test('native auto-confirm commits asynchronously and never confirms the following skill prompt', async () => {
  const f = mock({ mode: 'identity', mode_config: { identity: {} }, banned: [] }); let laterClicks = 0;
  const selected = [], button = { link: 'nihil_yinhua', classList: { contains: name => name === 'selectable' }, click: () => {
    selected.length = 0;
    setTimeout(async () => {
      Object.assign(f.modules.game.me, { name: 'nihil_yinhua', hp: 3, maxHp: 3 });
      const startup = new f.modules.lib.element.GameEvent('nihil_yinshang_init', { player: f.modules.game.me, run() { f.modules._status.event = this; f.modules.game.me.logSkill('nihil_yinshang'); } });
      await startup.loop();
      f.modules._status.event = { name: 'chooseBool' };
    }, 30);
  } };
  const dialog = { buttons: [button], querySelector: () => null };
  f.modules._status.event.dialog = dialog; f.modules.ui.cheat2.dialog = dialog;
  f.modules.ui.selected = { buttons: selected }; f.modules.ui.confirm = { childNodes: [{ link: 'ok', click: () => { laterClicks++; } }] };
  const result = await chooseCharacter(f.cdp, { character: 'nihil_yinhua' });
  assert.equal(result.character, 'nihil_yinhua'); assert.equal(laterClicks, 0); assert.equal(f.modules._status.event.name, 'chooseBool');
  const rows = JSON.parse(JSON.stringify(f.window.__nonameFlow.eventLogs())).entries;
  assert.deepEqual(rows.map(row => [row.operation?.id, row.rawSkill, row.confirmation]), [['nihil_yinshang', 'nihil_yinshang', 'logSkill']]);
});
test('navigation parsing never imports the game before its import map is effective', async () => {
  const f = mock({ mode: 'identity', mode_config: { identity: {} }, banned: [] });
  f.document.readyState = 'loading';
  await assert.rejects(characters(f.cdp), /native_entry_not_ready/); assert.equal(f.imports.length, 0);
  f.document.readyState = 'interactive';
  const map = f.document.querySelectorAll; f.document.querySelectorAll = () => [];
  await assert.rejects(characters(f.cdp), /native_entry_not_ready/); assert.equal(f.imports.length, 0);
  f.document.querySelectorAll = map;
  assert.equal((await characters(f.cdp)).characters.length, 2); assert.equal(f.imports.length, 1);
});
