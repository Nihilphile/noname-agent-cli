'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { validate } = require('../src/test-room.cjs');
const runtime = require('../src/test-room-runtime.cjs');
const ddz = require('../examples/test-room-doudizhu.json');
const versus = require('../examples/test-room-2v2.json');
const copy = value => structuredClone(value);

test('lineup requires complete unique sessions, characters and balanced factions', () => {
  assert.deepEqual(validate(ddz), ddz);
  assert.deepEqual(validate(versus), versus);
  for (const mutate of [
    p => p.seats.pop(), p => { p.mode = '1v1'; },
    p => { p.seats[1].session = 'TEST-A'; }, p => { p.seats[1].character = 'caocao'; },
    p => { p.seats[1].identity = 'zhu'; }, p => { p.seats[1].character = ''; },
    p => { p.seats[0].character = ' caocao'; }, p => { p.seats[0].team = 'A'; },
    p => { p.seed = 123; },
  ]) { const plan = copy(ddz); mutate(plan); assert.throws(() => validate(plan), { code: 'invalid_test_lineup' }); }
  const unbalanced = copy(versus); unbalanced.seats[0].team = 'B';
  assert.throws(() => validate(unbalanced), { code: 'invalid_test_lineup' });
  const plan = copy(ddz), result = validate(plan); plan.seats[0].character = 'wrong';
  assert.equal(result.seats[0].character, 'caocao');
});

test('catalog rejects missing, disabled and non-enabled-pack characters', () => {
  const lib = { configOL: { characterPack: ['standard'] }, characterPack: { standard: { caocao: [] } }, character: { caocao: [], hidden: [] }, filter: { characterDisabled: () => false }, connectBanned: [] };
  const env = { lib, game: {}, _status: { connectMode: true } };
  assert.equal(runtime.catalog(env, { seats: [{ character: 'caocao' }] }).ready, true);
  assert.throws(() => runtime.catalog(env, ddz), /test_character_not_loaded/);
  assert.throws(() => runtime.catalog(env, { seats: [{ character: 'hidden' }] }), /test_character_not_loaded/);
  lib.connectBanned.push('caocao');
  assert.throws(() => runtime.catalog(env, { seats: [{ character: 'caocao' }] }), /test_character_disabled/);
});

test('runtime refuses unfamiliar engine before mutating the host selection method', () => {
  const original = function () {};
  const context = { window: {}, env: { lib: { configOL: { mode: 'doudizhu', doudizhu_mode: 'normal' } }, game: { chooseCharacterOL: original }, _status: { waitingForPlayer: true } }, plan: ddz };
  assert.throws(() => vm.runInNewContext(`(${runtime.install})(env, plan)`, context), /native selection changed/);
  assert.equal(context.env.game.chooseCharacterOL, original);
  assert.equal(context.window.__nonameTestRoom, undefined);
});

test('selection helper never confirms a later skill or chooses a different character', () => {
  let clicks = 0;
  const expected = ddz.seats[0];
  const env = { lib: {}, game: { me: {} }, ui: { confirm: { childNodes: [{ link: 'ok', click() { clicks++; } }] } }, get: {}, _status: { imchoosing: true, event: { name: 'chooseToUse' } } };
  assert.equal(runtime.select(env, expected).selected, false);
  assert.equal(clicks, 0);
  env.game.me.name1 = 'guanyu';
  assert.throws(() => runtime.select(env, expected), /test_character_mismatch/);
  env.game.me.name1 = 'caocao';
  assert.equal(runtime.select(env, expected).selected, true);
  assert.equal(clicks, 0);
});

test('native character selection clicks once then confirms only the exact chosen button', () => {
  let clicked = 0, confirmed = 0;
  const classes = new Set(['character', 'selectable']);
  const button = { link: 'caocao', classList: { contains: c => classes.has(c) }, click() { clicked++; classes.add('selected'); env.ui.selected.buttons = [button]; } };
  const env = { game: { me: {} }, lib: {}, get: {}, ui: { selected: { buttons: [] }, confirm: { childNodes: [{ link: 'ok', click() { confirmed++; } }] } },
    _status: { imchoosing: true, event: { name: 'chooseButton', dialog: { textContent: '选择角色', buttons: [button] } } } };
  runtime.select(env, ddz.seats[0]); runtime.select(env, ddz.seats[0]);
  assert.equal(clicked, 1); assert.equal(confirmed, 1);
  env.ui.selected.buttons.push({ link: 'guanyu' });
  assert.throws(() => runtime.select(env, ddz.seats[0]), /test_character_selection_conflict/);
});

for (const native of require('./fixtures/test-room/native-selection.json')) {
  test(`pinned native ${native.method} keeps exact characters and factions after shuffled seats`, () => {
    const plan = copy(native.method === 'chooseCharacterOL' ? ddz : versus);
    plan.seats = plan.seats.map((s, i) => ({ ...s, host: i === 0, playerId: String(i) }));
    const context = vm.createContext({ plan, native, install: runtime.install.toString() });
    vm.runInContext(`
      var window = {}, lib = {configOL:{}, characterReplace:{}, characterPack:{standard:{}}, character:{}, connectBanned:[], filter:{characterDisabled:()=>false}};
      Object.assign(lib.configOL, plan.mode==='2v2' ? {mode:'versus',versus_mode:'2v2'} : {mode:'doudizhu',doudizhu_mode:'normal'});
      for (const s of plan.seats) lib.characterPack.standard[s.character] = lib.character[s.character] = [];
      lib.configOL.characterPack = ['standard'];
      var ui = {arena:{classList:{add(){}}}}, get = {verticalStr:x=>x,cnNumber:x=>x}, ai = {}, _status = {waitingForPlayer:true};
      var players = plan.seats.map((s,i)=>({playerid:String(i),node:{name:{},identity:{firstChild:{},dataset:{}}},showIdentity(){}}));
      var host = players[0]; players.reverse();
      players.forEach((p,i)=>{p.next=players[(i+1)%players.length];p.previous=players[(i+players.length-1)%players.length];});
      players.randomGet = () => players[1];
      var event = {}, content, captured;
      var game = {players,me:host, broadcast:fn=>{}, createEvent:()=>({setContent:fn=>{content=fn;}})};
      const expression = native.source.startsWith('function') ? native.source : 'function '+native.source;
      game[native.method] = eval('('+expression+')');
      eval('('+install+')')({lib,game,ui,get,ai,_status},plan);
      game[native.method]();
      var body = content.toString().slice(content.toString().indexOf('{')+1);
      if(plan.mode==='doudizhu') {
        game.me.chooseButtonOL = list=>{captured=list.map(x=>({id:x[0].playerid,character:x[1][1][0][0],type:x[1][1][1]}));};
        eval(body.slice(0,body.indexOf('"step 2";')));
      } else {
        eval(body.slice(0,body.indexOf('game._characterChoice = choose;')));
        captured = Object.entries(choose).map(([id,choices])=>({id,character:choices[0]}));
        // Exercise the actual patched broadcast callback separately.
        var callback;
        game.broadcast = (fn,...args)=>{callback=()=>fn(...args);};
        eval(body.slice(0,body.indexOf('game._characterChoice = choose;')));
        callback();
      }
    `, context);
    const captured = JSON.parse(JSON.stringify(context.captured));
    for (const s of plan.seats) {
      assert.equal(captured.find(p => p.id === s.playerId).character, s.character);
      const player = context.players.find(p => p.playerid === s.playerId);
      if (plan.mode === 'doudizhu') { assert.equal(player.identity, s.identity); assert.equal(captured.find(p => p.id === s.playerId).type, 'character'); }
      else assert.equal(player.side, s.team === 'A');
    }
  });
}
