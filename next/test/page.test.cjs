'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installPage } = require('../src/page.cjs');
const { installFlow } = require('../src/flow.cjs');

// This DOM only models browser contracts used by the projection. Engine-facing
// fixtures below reproduce observed blank-card and control-container shapes.
class Element {
  constructor(classes = '', innerText = '') {
    this.classes = new Set(classes.split(/\s+/).filter(Boolean));
    this.classList = {
      contains: value => this.classes.has(value),
      add: value => this.classes.add(value),
      remove: value => this.classes.delete(value),
    };
    this.innerText = innerText;
    this.textContent = innerText;
    this.children = [];
    this.isConnected = true;
    this.style = {};
    this.clickCount = 0;
  }
  set innerHTML(value) { this.textContent = String(value).replace(/<[^>]*>/g, ''); }
  get innerHTML() { return this.textContent; }
  appendChild(node) {
    if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(item => item !== node);
    node.parentNode = node.parentElement = this; this.children.push(node); return node;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector.split(',').some(s => node.classes.has(s.trim().slice(1)))) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(node => [
      ...(selector.split(',').some(s => s.trim().startsWith('.') ? node.classes.has(s.trim().slice(1)) : node.tagName?.toLowerCase() === s.trim()) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { return this.isConnected && this.style.display !== 'none' ? [{}] : []; }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, width: 100, height: 50 }; }
  scrollIntoView() {}
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  dispatchEvent(event) { this.onEvent?.(event); return true; }
  click() { this.clickCount++; this.onClick?.(); }
}

function makePlayer(name, identity, hand) {
  const player = new Element('player');
  Object.assign(player, {
    name, identity, hp: 3, maxHp: 4, marks: {},
    getCards: zone => zone === 'h' || zone === 'hes' ? hand : [],
    countCards: () => hand.length,
    getSkills: () => [], getExpansions: () => [],
    isDead: () => false, isLinked: () => false, isTurnedOver: () => false,
  });
  return player;
}

function fixture({ choosing = true, mode = 'identity', flow = undefined, pauseMethods = false } = {}) {
  const ownCard = Object.assign(new Element('card selectable', '杀'), { name: 'sha', suit: 'spade', number: 7 });
  const secretCard = Object.assign(new Element('card'), { name: 'secret_other_hand', suit: 'heart', number: 12 });
  const me = makePlayer('nihil_luofei', 'fan', [ownCard]);
  const other = makePlayer('other', 'nei', [secretCard]);
  const game = { me, players: [me, other], dead: [], over() {} };
  const ui = { controls: [], dialogs: [] };
  const _status = { imchoosing: choosing, event: { name: 'chooseToUse', step: 0, isMine: () => true } };
  if (pauseMethods) {
    _status.paused = true;
    game.pause = () => { _status.paused = true; };
    game.resume = () => { _status.paused = false; };
  }
  const lib = { translate: { sha: '杀', spade: '黑桃' }, skill: {}, card: {} };
  const get = { mode: () => mode, select: value => value() };
  const timers = [];
  const document = { createElement: () => new Element(), querySelectorAll: () => ui.dialogs };
  const context = vm.createContext({
    window: { __nonameFlow: flow }, document,
    MouseEvent: class { constructor(type, options) { Object.assign(this, { type }, options); } },
    Event: class { constructor(type, options) { Object.assign(this, { type }, options); } },
    getComputedStyle: node => ({ visibility: node.style.visibility || 'visible' }),
    setTimeout: callback => { timers.push(callback); },
  });
  const install = vm.runInContext(`(${installPage.toString()})`, context);
  const api = install({ lib, game, ui, get, _status });
  return { api, game, ui, _status, lib, document, window: context.window, ownCard, other, secretCard, flush: () => timers.splice(0).forEach(fn => fn()) };
}

test('online room rejects stale retained choices after socket loss and changed seat without clicking', async () => {
  const f = fixture();
  f.window.__nonameRoomBinding = { id: 'room-a', epoch: 'room-epoch', memberId: 'a', role: 'guest', nativePlayerId: 'native-a', controller: 'agent' };
  f._status.connectMode = true; f.game.online = true; f.game.ws = { readyState: 1 }; f.game.me.playerid = 'native-a';
  const before = f.api.observe();
  assert.equal(before.state, 'choice');
  assert.equal(JSON.stringify(before).includes('secret_other_hand'), false, 'even an online renderer holding other hands must not expose them');
  f.game.ws.readyState = 3;
  assert.equal(f.api.observe().state, 'disconnected');
  assert.equal(f.api.observe().choice, null);
  assert.equal((await f.api.act({ id: before.choice.options[0].id, at: before.revision })).code, 'room_disconnected');
  f.game.ws.readyState = 1; f.game.me.playerid = 'native-b';
  f.game.me.getCards = () => { throw Error('must not read a changed seat'); };
  assert.equal(f.api.observe().room.state, 'seat_changed');
  assert.equal(f.api.observe().me, null);
  assert.throws(() => f.api.logs({}), /room_seat_changed/);
  assert.equal((await f.api.act({ id: before.choice.options[0].id, at: before.revision })).code, 'room_disconnected');
  assert.equal(f.ownCard.clickCount, 0);
});

test('human room seat and native auto cannot be operated by agent commands', async () => {
  const f = fixture();
  f.window.__nonameRoomBinding = { id: 'r', role: 'host', controller: 'human' };
  f.window.__nonameRoomServer = { _server: { listening: true } }; f._status.connectMode = true;
  let s = f.api.observe();
  assert.equal((await f.api.act({ id: s.choice.options[0].id, at: s.revision })).code, 'human_controlled');
  f.window.__nonameRoomBinding.controller = 'agent'; f._status.auto = true;
  s = f.api.observe(); assert.equal(s.choice, null);
  assert.equal((await f.api.act({ id: 'c1', at: s.revision })).code, 'room_auto');
  assert.equal(f.ownCard.clickCount, 0);
});

test('online native waitingForPlayer flag can persist after start and must not hide character selection', () => {
  const f = fixture();
  f.window.__nonameRoomBinding = { id: 'r', role: 'guest', controller: 'agent' };
  f.game.online = true; f.game.ws = { readyState: 1 }; f._status.connectMode = true; f._status.waitingForPlayer = true;
  f.lib.configOL = { gameStarted: false };
  assert.equal(f.api.observe().choice, null);
  f.lib.configOL.gameStarted = true;
  assert.equal(f.api.observe().room.state, 'playing'); assert.equal(f.api.observe().state, 'choice');
});

test('native online 2v2 exposes public teams without reading teammates hands', () => {
  const f = fixture({ mode: 'versus' });
  f._status.connectMode = true; f._status.mode = '2v2'; f.lib.configOL = { versus_mode: '2v2' };
  f.game.me.side = true; f.other.side = true;
  f.other.isUnderControl = () => true; f.game.me.hasSkillTag = () => true;
  const original = f.other.getCards;
  f.other.getCards = zone => { assert.ok(!zone.includes('h')); return original(zone); };
  let state = f.api.observe(true);
  assert.equal(state.players[0].team.relation, 'ally'); assert.match(state.victory, /2v2/);
  assert.equal(state.players[0].hand, undefined); assert.ok(!JSON.stringify(state).includes('secret_other_hand'));
  f.other.side = false;
  state = f.api.observe(); assert.equal(state.players[0].team.relation, 'enemy');
  f.lib.configOL.versus_mode = '4v4';
  assert.equal(f.api.observe().players[0].team, undefined);
});

test('guest page uses a host scope for normal play and preserves it while awaiting a remote result', () => {
  const f = fixture();
  f.window.__nonameRoomBinding = { id:'room',role:'guest',controller:'agent' };
  f.game.online=true; f.game.ws={readyState:1}; f._status.connectMode=true;
  let normal=true, phaseId='host-phase-1'; const remembered=[];
  f.window.__nonameRoomPlay={snapshot:()=>({phaseId,normal,requestId:'host-request-1'}),rememberCard:(card,id)=>remembered.push(id),receipts:()=>[]};
  let state=f.api.observe();
  assert.equal(state.phase,'phaseUse'); assert.equal(state.actor,state.me.id);
  assert.equal(state.choice.context.transportRequestId,'host-request-1'); assert.equal(state.choice.context.certainty,'known');
  assert.ok(remembered.includes(state.me.hand[0].id)); const bound=state.phaseId;
  f._status.imchoosing=false; normal=false;
  assert.equal(f.api.observe().phaseId,bound);
  phaseId=null; assert.equal(f.api.observe().phaseId,null);
  f._status.imchoosing=true; assert.equal(f.api.observe().choice.context.certainty,'unknown');
});

test('page installs its stable local card ID resolver into flow', () => {
  let resolver;
  const flow = {
    setCardIdentityResolver(value) { resolver = value; },
    choiceContext() { return { skill: null, actor: 'p1', sourceAction: null, certainty: 'known' }; },
    logs() { return { entries: [] }; }, eventLogs() { return { entries: [] }; },
  };
  const f = fixture({ flow });
  assert.equal(typeof resolver, 'function');
  assert.equal(resolver(f.ownCard), f.api.observe().me.hand[0].id);
});

test('real flow and page installers share local entity receipt IDs in one VM without identifying opponent materials', () => {
  class GameEvent {
    constructor(name, props = {}) { Object.assign(this, { name, finished: false }, props); }
    async loop() { this.finished = true; }
    getParent() { return this.parent || null; }
    trigger(name) { return name; }
  }
  class Player extends Element {
    constructor(name, identity, hand) {
      super('player'); Object.assign(this, { name, identity, hp: 3, maxHp: 4, hujia: 0, marks: {}, hand,
        actionHistory: [{ damage: [], gain: [], lose: [], useCard: [] }], zones: { e: [], j: [] } });
    }
    update() { return this; }
    getCards(zone) { return zone === 'h' || zone === 'hes' ? this.hand : this.zones[zone] || []; }
    countCards() { return this.hand.length; }
    getSkills() { return []; }
    getExpansions() { return []; }
    isDead() { return false; }
    isLinked() { return false; }
    isTurnedOver() { return false; }
  }
  const ownCard = Object.assign(new Element('card selectable', '杀'), { name: 'sha', suit: 'heart', number: 8 });
  const opponentMaterial = Object.assign(new Element('card', '秘密材料'), { name: 'secret_material', suit: 'spade', number: 1 });
  const me = new Player('self', 'fan', [ownCard]), other = new Player('other', 'nei', [opponentMaterial]);
  const phase = new GameEvent('phaseUse', { player: me });
  const choosing = new GameEvent('chooseToUse', { player: me, type: 'phase', parent: phase, step: 0 });
  const ownUse = new GameEvent('useCard', { player: me, card: { name: 'sha' }, cards: [ownCard], targets: [other] });
  const opponentUse = new GameEvent('useCard', { player: other, card: { name: 'tao' }, cards: [opponentMaterial], targets: [other] });
  const game = { me, players: [me, other], dead: [], over() {} }, ui = { controls: [], dialogs: [] };
  const _status = { imchoosing: true, event: choosing, currentPhase: me, dying: [], globalHistory: [{ everything: [ownUse, opponentUse], changeHp: [] }] };
  const lib = { element: { GameEvent, Player }, translate: { sha: '杀', tao: '桃', heart: '红桃' }, skill: {}, card: {} };
  const get = { mode: () => 'identity', select: value => typeof value === 'function' ? value() : value, plainText: value => String(value), itemtype: value => [ownCard, opponentMaterial].includes(value) ? 'card' : null };
  const document = { createElement: () => new Element(), querySelectorAll: () => [] };
  const context = vm.createContext({ window: {}, args: { lib, game, ui, get, _status }, document,
    MouseEvent: class { constructor(type, options) { Object.assign(this, { type }, options); } },
    Event: class { constructor(type, options) { Object.assign(this, { type }, options); } },
    getComputedStyle: node => ({ visibility: node.style?.visibility || 'visible' }), setTimeout });
  vm.runInContext(`(${installFlow.toString()})(args)`, context);
  const api = vm.runInContext(`(${installPage.toString()})(args)`, context);
  const handId = api.observe().me.hand[0].id, actions = api.effects().actions;
  const own = actions.find(action => action.actor === api.observe().me.id), opponent = actions.find(action => action !== own);
  assert.deepEqual(Array.from(own.physicalCards), [handId]); assert.equal(own.physicalMode, 'direct');
  assert.equal(opponent.physicalCards, undefined); assert.equal(JSON.stringify(actions).includes('secret_material'), false);
});

test('phase identity uses the actual phaseUse event and is stable through child choices and option changes', () => {
  const f = fixture();
  const phase = { name: 'phaseUse', player: f.game.me };
  f._status.event.parent = phase; f.game.roundNumber = 2; f._status.currentPhase = f.game.me;
  const first = f.api.observe();
  assert.match(first.phaseId, new RegExp(`^${first.revision.split(':')[0]}:phaseUse:e\\d+$`));
  f._status.event = { name: 'chooseTarget', parent: phase, step: 3 };
  const second = f.api.observe();
  assert.equal(second.phase, 'phaseUse'); assert.equal(second.phaseId, first.phaseId);
  f.ownCard.classList.add('selected');
  assert.equal(f.api.observe().phaseId, first.phaseId);
});

test('extra phaseUse in the same round for the same actor gets a new phase identity and revision', () => {
  const f = fixture();
  f.game.roundNumber = 1; f._status.currentPhase = f.game.me;
  f._status.event.parent = { name: 'phaseUse', player: f.game.me };
  const first = f.api.observe();
  f._status.event.parent = { name: 'phaseUse', player: f.game.me };
  const second = f.api.observe();
  assert.equal(first.round, second.round); assert.equal(first.actor, second.actor);
  assert.notEqual(first.phaseId, second.phaseId); assert.notEqual(first.revision, second.revision);
});

test('non-play phases and unknown ancestry do not manufacture a phaseUse identity', () => {
  const f = fixture();
  assert.equal(f.api.observe().phaseId, null);
  f._status.event.parent = { name: 'phaseDiscard', parent: { name: 'phaseUse' } };
  assert.equal(f.api.observe().phase, 'phaseDiscard'); assert.equal(f.api.observe().phaseId, null);
  f._status.event.parent = f._status.event;
  assert.equal(f.api.observe().phaseId, null);
});

function moveFixture({ allowed = true, selected = false } = {}) {
  const f = fixture();
  const dialog = new Element('dialog');
  const source = dialog.appendChild(new Element('buttons guanxing'));
  const destination = dialog.appendChild(new Element('buttons guanxing'));
  const button = source.appendChild(new Element('button card', '杀'));
  if (selected) button.classList.add('glow2');
  button.onClick = () => button.classList.add('glow2');
  // Engine chooseToMove moves selected buttons in a mouseup handler. A click
  // changes glow2 first, but filterMove may independently reject the move.
  destination.onEvent = event => {
    assert.equal(event.type, 'mouseup');
    assert.equal(event.which, 1);
    if (allowed && button.classList.contains('glow2')) {
      destination.appendChild(button);
      button.classList.remove('glow2');
    }
  };
  f.document.elementFromPoint = () => destination;
  Object.assign(f._status.event, { name: 'chooseToMove', dialog, buttonss: [source, destination], custom: { replace: { button() {} } } });
  return { ...f, button, source, destination };
}

test('player-view projection never reads another hand and hides an unrevealed identity', () => {
  const f = fixture();
  const original = f.other.getCards;
  f.other.getCards = zone => {
    assert.ok(!zone.includes('h'), 'projection requested another player hand');
    return original(zone);
  };
  for (const detail of [false, true]) {
    const state = f.api.observe(detail);
    assert.equal(state.me.hand[0].name, 'sha');
    assert.equal(state.players[0].identity.visibility, 'hidden');
    assert.equal('value' in state.players[0].identity, false);
    assert.equal('hand' in state.players[0], false);
    assert.equal(JSON.stringify(state).includes('secret_other_hand'), false);
  }
  f.other.identityShown = true;
  assert.equal(f.api.observe().players[0].identity.value, 'nei');
});

test('native number selectors expose allowed values and dispatch change without bypassing the engine', async () => {
  const f = fixture();
  const dialog = new Element('dialog', '请选择移去的血数');
  const select = Object.assign(new Element('', ''), { tagName: 'SELECT', value: '1', options: [{value:'1',textContent:'1'}, {value:'2',textContent:'2'}, {value:'3',textContent:'3',disabled:true}] });
  dialog.appendChild(select); f.ui.dialog = dialog; f.ui.dialogs.push(dialog); f._status.event.name = 'chooseNumbers';
  let accepted;
  select.onEvent = event => { assert.equal(event.type, 'change'); accepted = select.value; };
  const before = f.api.observe();
  const option = before.choice.options.find(o => o.kind === 'number');
  assert.ok(option, 'number selector missing');
  assert.equal(option.value, '1');
  assert.deepEqual(Array.from(option.values, x => x.value), ['1','2']);
  const invalid = await f.api.act({ id: option.id, value: '3', at: before.revision });
  assert.equal(invalid.ok, false); assert.equal(accepted, undefined);
  const pending = f.api.act({ id: option.id, value: '2', at: before.revision }); f.flush();
  const after = await pending;
  assert.equal(after.ok, true); assert.equal(accepted, '2');
  assert.equal(after.state.choice.options.find(o => o.kind === 'number').value, '2');
});

test('elemental sha labels retain their visible nature in hands and card options', () => {
  const f = fixture(); f.lib.translate.fire = '火'; f.lib.translate.thunder = '雷';
  for (const [nature, expected] of [['fire', '火杀'], ['thunder', '雷杀'], ['fire|thunder', '火雷杀']]) {
    f.ownCard.nature = nature;
    const state = f.api.observe();
    assert.equal(state.me.hand[0].label, expected);
    assert.ok(state.choice.options.find(o => o.kind === 'card').label.startsWith(expected));
  }
});

test('initial-hand redraw changes revision and reports its actual effect', async () => {
  const f = fixture(); f.ownCard.classList.remove('selectable');
  const control = new Element('control'); const confirm = Object.assign(new Element('', '确定'), { link: 'ok' }); control.appendChild(confirm); f.ui.controls.push(control); f.ui.confirm = control;
  f._status.event.name = 'gameDraw'; f._status.event.isMine = () => false;
  confirm.onClick = () => { const replacement = Object.assign(new Element('card'), { name:'tao',suit:'heart',number:3 }); f.game.me.getCards = zone => zone === 'h' || zone === 'hes' ? [replacement] : []; };
  const before=f.api.observe(); const pending=f.api.act({id:'confirm',at:before.revision}); f.flush(); const after=await pending;
  assert.equal(after.ok,true); assert.notEqual(after.state.revision,before.revision); assert.equal(after.state.me.hand[0].name,'tao');
});

test('composed actions stop after a rejected item and retain partial execution evidence', async () => {
  const f=fixture(); f.ownCard.onClick=()=>f.ownCard.classList.add('selected');
  const before=f.api.observe(); const id=before.choice.options.find(x=>x.kind==='card').id;
  const pending=f.api.actMany({ids:[id,'nonexistent','confirm'],at:before.revision});
  for(let i=0;i<8;i++){f.flush();await Promise.resolve();}
  const output=await pending;assert.equal(output.ok,false);assert.equal(output.code,'option_unavailable');assert.equal(output.actions.length,1);assert.equal(f.ownCard.clickCount,1);
});

test('composed actions never carry a confirm into a different choice', async () => {
  const f=fixture();f.ownCard.onClick=()=>{f._status.event={name:'chooseBool'};};
  const before=f.api.observe();const id=before.choice.options.find(x=>x.kind==='card').id;
  const pending=f.api.actMany({ids:[id,'confirm'],at:before.revision});
  for(let i=0;i<8;i++){f.flush();await Promise.resolve();}
  const output=await pending;assert.equal(output.ok,false);assert.equal(output.code,'choice_changed');assert.equal(output.actions.length,1);
});

test('composed actions stop before cancel when the same event object returns as a new decision', async () => {
  const f = fixture({ pauseMethods: true });
  const control = new Element('control');
  const confirm = control.appendChild(Object.assign(new Element('', '确定'), { link: 'ok' }));
  const cancel = control.appendChild(Object.assign(new Element('', '取消'), { link: 'cancel' }));
  f.ui.controls.push(control);
  // chooseToUse can finish a submission and reuse its event at step 0, with
  // both pause boundaries occurring before the next observation.
  confirm.onClick = () => { f.game.resume(); f.game.pause(); };
  const before = f.api.observe(), original = f._status.event;
  const pending = f.api.actMany({ ids: ['confirm', 'cancel'], at: before.revision });
  for (let i = 0; i < 8; i++) { f.flush(); await Promise.resolve(); }
  const result = await pending;
  assert.equal(f._status.event, original);
  assert.equal(result.ok, false); assert.equal(result.code, 'choice_changed');
  assert.equal(result.actions.length, 1); assert.equal(confirm.clickCount, 1);
  assert.equal(cancel.clickCount, 0);
  assert.notEqual(result.state.choice.decisionId, before.choice.decisionId);
});

test('composed card, target and confirm stay executable within one decision', async () => {
  const f = fixture({ pauseMethods: true });
  f.ownCard.onClick = () => f.ownCard.classList.add('selected');
  f.other.classList.add('selectable');
  f.other.onClick = () => f.other.classList.add('selected');
  const control = new Element('control');
  const confirm = control.appendChild(Object.assign(new Element('', '确定'), { link: 'ok' }));
  f.ui.controls.push(control);
  confirm.onClick = () => { f.game.resume(); f._status.imchoosing = false; };
  const before = f.api.observe();
  const card = before.choice.options.find(o => o.kind === 'card').id;
  const target = before.choice.options.find(o => o.kind === 'target').id;
  const pending = f.api.actMany({ ids: [card, target, 'confirm'], at: before.revision });
  for (let i = 0; i < 12; i++) { f.flush(); await Promise.resolve(); }
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.actions.length, 3);
  assert.equal(result.state.state, 'running');
  assert.equal(f.ownCard.clickCount, 1); assert.equal(f.other.clickCount, 1);
  assert.equal(confirm.clickCount, 1);
});

test('a real blank card button never exposes its hidden link name', () => {
  const f = fixture();
  const dialog = new Element('dialog', '请选择一张牌');
  // ui.create.buttonPresets.blank uses .button.card and link, without infohidden.
  const blank = Object.assign(new Element('button card selectable'), { link: f.secretCard });
  dialog.appendChild(blank);
  f.ui.dialog = dialog; f.ui.dialogs.push(dialog);
  for (const detail of [false, true]) {
    const state = f.api.observe(detail);
    assert.equal(JSON.stringify(state).includes('secret_other_hand'), false);
    const option = state.choice.options.find(o => o.kind === 'button');
    assert.equal(option.visibility, 'hidden');
    assert.equal(option.label, '暗牌');
  }
});

test('native textbutton votes are enumerated once and dispatched through their actual click handler', async () => {
  const f = fixture();
  const dialog = new Element('dialog', '秉法：投票');
  const first = dialog.appendChild(new Element('popup text textbutton selectable', '本轮造成伤害最多者受到2点无来源伤害'));
  const second = dialog.appendChild(new Element('popup text textbutton selectable', '本轮获得牌数最多者手牌上限-2'));
  // ui.create.textbuttons stores the inner node in dialog.buttons, without
  // adding .button. Its custom handler allows multiple votes on one law.
  dialog.buttons = [first, second];
  f.ui.dialog = dialog; f.ui.dialogs.push(dialog); f.ui.selected = { buttons: [] };
  const customClick = button => {
    if (f.ui.selected.buttons.length >= 2) return;
    button.classList.add('selected'); f.ui.selected.buttons.push(button);
  };
  first.onClick = () => customClick(first); second.onClick = () => customClick(second);
  Object.assign(f._status.event, { name: 'chooseButton', dialog, selectButton: [1, 2], custom: { replace: { button: customClick } } });
  const before = f.api.observe();
  const options = before.choice.options.filter(o => o.kind === 'button');
  assert.equal(options.length, 2);
  assert.equal(options[0].label, first.innerText);
  const pending = f.api.act({ id: options[0].id, at: before.revision }); f.flush();
  const once = await pending; assert.equal(once.ok, true);
  const again = f.api.act({ id: options[0].id, at: once.state.revision }); f.flush();
  const twice = await again;
  assert.equal(twice.ok, true); assert.equal(first.clickCount, 2); assert.equal(second.clickCount, 0);
  assert.equal(twice.state.choice.options.find(o => o.id === options[0].id).selectionCount, 2);
  const excessive = f.api.act({ id: options[0].id, at: twice.state.revision }); f.flush();
  assert.equal((await excessive).code, 'no_effect');
  assert.equal(f.ui.selected.buttons.length, 2, 'native limit remains authoritative');
  assert.equal((await f.api.act({ id: options[0].id, at: twice.state.revision, unselect: true })).code, 'custom_selection');
});

test('registered buttons with custom classes retain visibility and privacy boundaries', () => {
  const f = fixture();
  const dialog = new Element('dialog', '公开选择');
  const eligible = dialog.appendChild(new Element('extension-choice selectable', '公开选项'));
  const secret = dialog.appendChild(Object.assign(new Element('card selectable'), { link: 'secret_other_hand' }));
  const hidden = dialog.appendChild(new Element('extension-choice selectable hidden', 'hidden_option'));
  const disabled = dialog.appendChild(new Element('extension-choice selectable disabled', 'disabled_option'));
  const noclick = dialog.appendChild(new Element('extension-choice selectable noclick', 'noclick_option'));
  const unavailable = dialog.appendChild(new Element('extension-choice unselectable', 'unavailable_option'));
  const detached = new Element('extension-choice selectable', 'detached_option'); detached.isConnected = false;
  dialog.buttons = [eligible, secret, hidden, disabled, noclick, unavailable, detached];
  f.ui.dialog = dialog;
  const options = f.api.observe().choice.options.filter(o => o.kind === 'button');
  assert.deepEqual(Array.from(options, o => o.label), ['公开选项', '暗牌']);
  assert.equal(options[1].visibility, 'hidden');
  assert.equal(JSON.stringify(options).includes('secret_other_hand'), false);
});

test('infohidden card buttons hide text even when their link or text contains a card name', () => {
  const f = fixture();
  const dialog = new Element('dialog', '请选择');
  dialog.appendChild(Object.assign(new Element('button selectable infohidden', 'secret_other_hand'), { link: f.secretCard }));
  f.ui.dialog = dialog;
  const option = f.api.observe().choice.options.find(o => o.kind === 'button');
  assert.equal(option.label, '暗牌');
  assert.equal(option.visibility, 'hidden');
});

test('other players private expansions remain hidden even without an infohidden CSS class', () => {
  const f = fixture();
  // nihil_duanyi2 stores physical cards in x; its mark renderer exposes only a
  // count to other players. infohidden is placed on animation clones, not x.
  f.secretCard.gaintag = ['nihil_duanyi2'];
  f.secretCard.hasGaintag = name => f.secretCard.gaintag.includes(name);
  f.lib.skill.nihil_duanyi2 = { intro: { markcount: 'expansion', mark: () => '共有一张牌被扣置' } };
  f.other.getExpansions = () => [f.secretCard];
  f.other.marks.nihil_duanyi2 = new Element('mark', '1');
  const state = f.api.observe(true);
  assert.equal(JSON.stringify(state).includes('secret_other_hand'), false);
});

test('disabled parent controls are not offered as legal actions', () => {
  const f = fixture();
  const control = new Element('control disabled');
  control.appendChild(Object.assign(new Element('', '确定'), { link: 'ok' }));
  f.ui.controls.push(control);
  assert.equal(f.api.observe().choice.options.some(o => o.kind === 'confirm'), false);
});

test('other player skill listing follows the normal tooltip visibility filter', () => {
  const f = fixture();
  f.other.getSkills = () => ['public_skill', 'secret_internal_state'];
  f.lib.skill.public_skill = {};
  f.lib.skill.secret_internal_state = { nopop: true };
  f.lib.translate.public_skill_info = '公开技能说明';
  f.lib.translate.secret_internal_state_info = '隐藏实现状态';
  const state = f.api.observe(true);
  assert.ok(state.players[0].skills.some(s => s.id === 'public_skill'));
  assert.equal(JSON.stringify(state.players[0].skills).includes('secret_internal_state'), false);
});

test('shared dynamic skill descriptions receive the engine skill-name argument', () => {
  const f = fixture();
  f.game.me.getSkills = () => ['changing_skill'];
  f.lib.skill.changing_skill = {};
  f.lib.translate.changing_skill_info = '原始描述';
  f.lib.dynamicTranslate = { changing_skill: (player, skillName) => {
    assert.equal(player, f.game.me);
    assert.equal(skillName, 'changing_skill');
    return '本回合还可发动两次';
  } };
  assert.equal(f.api.observe(true).me.skills[0].description, '本回合还可发动两次');
});

test('stale revisions and removed options cannot click a different object', async () => {
  const f = fixture();
  const before = f.api.observe();
  const option = before.choice.options.find(o => o.kind === 'card');
  f._status.event.step++;
  const stale = await f.api.act({ at: before.revision, id: option.id });
  assert.equal(stale.code, 'stale_choice');
  assert.equal(f.ownCard.clickCount, 0);
  f.ownCard.classList.remove('selectable');
  const fresh = f.api.observe();
  const removed = await f.api.act({ at: fresh.revision, id: option.id });
  assert.equal(removed.code, 'option_unavailable');
  assert.equal(f.ownCard.clickCount, 0);
});

test('selection uses the real click result and rejects accidental repeated selection', async () => {
  const f = fixture();
  f.ownCard.onClick = () => {
    if (f.ownCard.classList.contains('selected')) f.ownCard.classList.remove('selected');
    else f.ownCard.classList.add('selected');
  };
  const before = f.api.observe();
  const option = before.choice.options.find(o => o.kind === 'card');
  const pending = f.api.act({ at: before.revision, id: option.id }); f.flush();
  const selected = await pending;
  assert.equal(selected.ok, true);
  assert.equal(selected.state.choice.options.find(o => o.id === option.id).selected, true);
  assert.equal((await f.api.act({ at: selected.state.revision, id: option.id })).code, 'already_selected');
  assert.equal(f.ownCard.clickCount, 1);
  const unselecting = f.api.act({ at: selected.state.revision, id: option.id, unselect: true }); f.flush();
  const unselected = await unselecting;
  assert.equal(unselected.ok, true);
  assert.equal(unselected.state.choice.options.find(o => o.id === option.id).selected, false);
});

test('no-effect actions report failure instead of success', async () => {
  const f = fixture();
  const before = f.api.observe();
  const pending = f.api.act({ at: before.revision, id: before.choice.options[0].id }); f.flush();
  assert.equal((await pending).code, 'no_effect');
});

test('concurrent requests cannot dispatch the same pending action twice', async () => {
  const f = fixture();
  const control = new Element('control');
  const button = Object.assign(new Element('', '继续'), { link: 'continue' });
  control.appendChild(button); f.ui.controls.push(control);
  const before = f.api.observe();
  const option = before.choice.options.find(o => o.kind === 'control');
  const first = f.api.act({ at: before.revision, id: option.id });
  const duplicate = f.api.act({ at: before.revision, id: option.id });
  f.flush();
  await Promise.all([first, duplicate]);
  assert.equal(button.clickCount, 1);
});

test('a legal chooseToMove action changes group membership through mouse events', async () => {
  const f = moveFixture();
  const before = f.api.observe();
  const id = before.choice.options.find(option => option.kind === 'button').id;
  const to = before.choice.groups[1].id;
  const pending = f.api.act({ at: before.revision, id, to }); f.flush();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(f.button.parentElement, f.destination);
  assert.ok(result.state.choice.groups[1].buttons.includes(id));
});

test('a rejected chooseToMove action cannot report success just because source got selected', async () => {
  const f = moveFixture({ allowed: false });
  const before = f.api.observe();
  const id = before.choice.options.find(option => option.kind === 'button').id;
  const pending = f.api.act({ at: before.revision, id, to: before.choice.groups[1].id }); f.flush();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(f.button.parentElement, f.source);
});

test('chooseToMove accepts an already selected source without toggling it off', async () => {
  const f = moveFixture({ selected: true });
  const before = f.api.observe();
  const id = before.choice.options.find(option => option.kind === 'button').id;
  const pending = f.api.act({ at: before.revision, id, to: before.choice.groups[1].id }); f.flush();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(f.button.clickCount, 0);
  assert.equal(f.button.parentElement, f.destination);
});

test('moving to a group cannot accidentally swap with a card occupying the hit point', async () => {
  const f = moveFixture();
  const otherButton = f.destination.appendChild(new Element('button card', '桃'));
  f.document.elementFromPoint = () => otherButton;
  otherButton.onEvent = () => {
    f.source.appendChild(otherButton);
    f.destination.appendChild(f.button);
  };
  const before = f.api.observe();
  const id = before.choice.groups[0].buttons[0];
  const pending = f.api.act({ at: before.revision, id, to: before.choice.groups[1].id }); f.flush();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(otherButton.parentElement, f.destination);
  assert.equal(f.button.parentElement, f.source);
});

test('death is not fabricated as a loss and actual game.over controls final outcome', () => {
  const f = fixture({ choosing: false });
  f.game.me.isDead = () => true;
  const dead = f.api.observe();
  assert.equal(dead.state, 'dead');
  assert.equal(dead.result.outcome, 'death');
  assert.equal(dead.result.finalOutcome, 'unobserved');
  f.game.over(true); f._status.over = true;
  const over = f.api.observe();
  assert.equal(over.state, 'over');
  assert.equal(over.result.outcome, 'win');
});

test('displayed terminal dialog remains readable when its container is non-interactive', () => {
  const f = fixture(); f.game.over(true); f._status.over = true;
  const arena = new Element('disabled');
  const dialog = new Element('dialog', '战斗胜利 伤害 受伤 摸牌 出牌 杀敌 陌生角色 2 1 7 4 1');
  arena.appendChild(dialog); f.ui.dialog = dialog; f.ui.dialogs = [dialog];
  assert.deepEqual(Array.from(f.api.observe(true).visibleDialogs), [dialog.innerText]);
  assert.deepEqual(Array.from(f.api.observe().visibleDialogs), [dialog.innerText]);
});

test('terminal projection reads registered dialogs without the standard class and omits hidden text', () => {
  const f = fixture(); f.game.over(true); f._status.over = true;
  const registered = new Element('custom-result');
  const publicRow = new Element('', '战斗胜利 伤害 2'); publicRow.nodeType = 1;
  const hidden = new Element('infohidden', 'hidden_hand_sentinel'); hidden.nodeType = 1;
  registered.appendChild(publicRow); registered.appendChild(hidden); registered.childNodes = registered.children;
  f.ui.dialog = registered; f.ui.dialogs = []; f.document.querySelectorAll = () => [];
  assert.deepEqual(Array.from(f.api.observe(true).visibleDialogs), ['战斗胜利 伤害 2']);
  registered.classes.add('hidden'); assert.equal(f.api.observe(true).visibleDialogs.length, 0);
  registered.classes.delete('hidden'); registered.isConnected = false; assert.equal(f.api.observe(true).visibleDialogs.length, 0);
});

test('result dialogs are observed when actually displayed, with no fabricated early statistics', () => {
  const f = fixture(); f.game.over(true); f._status.over = true;
  assert.equal(f.api.observe().visibleDialogs.length, 0);
  const dialog = new Element('dialog', '战斗胜利 伤害 2'); f.ui.dialogs.push(dialog);
  assert.deepEqual(Array.from(f.api.observe().visibleDialogs), [dialog.innerText]);
  dialog.style.visibility = 'hidden'; assert.equal(f.api.observe().visibleDialogs.length, 0);
});


test('offline 2v2 shares allied hands with native viewHandcard permission without inspecting enemy hands', () => {
  const f = fixture({ mode: 'versus' }); f._status.mode = 'two'; f.game.me.side = false; f.other.side = false;
  f.secretCard.name = 'ally_shared_card';
  const enemyCard = Object.assign(new Element('card'), { name: 'enemy_secret_card', suit: 'club', number: 2 });
  const enemy = makePlayer('enemy', 'secret_role', [enemyCard]); enemy.side = true; f.game.players.push(enemy);
  f.other.isUnderControl = () => false;
  f.game.me.hasSkillTag = (tag, unused, target, hidden) => {
    assert.equal(tag, 'viewHandcard'); assert.equal(unused, null); assert.equal(hidden, true);
    return target === f.other;
  };
  const original = enemy.getCards; enemy.getCards = zone => { assert.ok(!zone.includes('h')); return original(zone); };
  const state = f.api.observe();
  assert.equal(state.mode, 'versus'); assert.equal(state.submode, 'two');
  assert.equal(state.me.team.relation, 'self'); assert.equal(state.players[0].team.relation, 'ally'); assert.equal(state.players[1].team.relation, 'enemy');
  assert.equal(state.players[0].identity.label, '队友'); assert.equal(state.players[1].identity.label, '敌方');
  assert.match(state.victory, /2v2.*消灭敌方两名/);
  assert.equal(state.me.hand[0].name, 'sha');
  assert.equal(state.players[0].hand[0].name, 'ally_shared_card');
  assert.equal(state.players[0].hand[0].suit, 'heart'); assert.equal(state.players[0].hand[0].number, 12);
  assert.equal(state.players[0].handVisibility, 'team_rule');
  assert.equal(state.players[0].handVisibilityReason, 'native_viewHandcard');
  assert.equal(state.players[1].hand, undefined); assert.ok(!JSON.stringify(state).includes('enemy_secret_card'));
  assert.equal(f.api.observe(true).players[0].hand[0].name, 'ally_shared_card');
  const allyOriginal = f.other.getCards; f.other.getCards = zone => { assert.ok(!zone.includes('h'), 'inspect skills must not read hand contents'); return allyOriginal(zone); };
  const inspected = f.api.inspect({ id: state.players[0].id });
  assert.equal(inspected.ok, true); assert.equal(inspected.hand, undefined);
  f.other.getCards = allyOriginal;
  delete enemy.side; assert.equal(f.api.observe().players[1].identity.visibility, 'unavailable');
});

test('2v2 hand sharing accepts native control and fails closed without permission or on capability errors', () => {
  const f = fixture({ mode: 'versus' }); f._status.mode = 'two'; f.game.me.side = false; f.other.side = false;
  f.other.isUnderControl = self => { assert.equal(self, true); return true; };
  let state = f.api.observe(); assert.equal(state.players[0].handVisibilityReason, 'native_control');
  assert.equal(state.players[0].hand[0].name, 'secret_other_hand');
  const original = f.other.getCards; f.other.getCards = zone => { assert.ok(!zone.includes('h')); return original(zone); };
  delete f.other.isUnderControl;
  assert.equal(f.api.observe().players[0].hand, undefined);
  f.other.isUnderControl = () => false; f.game.me.hasSkillTag = () => false;
  assert.equal(f.api.observe().players[0].hand, undefined);
  f.game.me.hasSkillTag = () => { throw Error('broken viewHandcard rule'); };
  assert.equal(f.api.observe().players[0].hand, undefined);
  f.other.isUnderControl = () => { throw Error('broken control rule'); }; f.game.me.hasSkillTag = () => true;
  assert.equal(f.api.observe().players[0].hand, undefined);
});

test('team hand sharing denies other modes, online games, unknown or non-boolean sides', () => {
  const scenarios = [
    { mode: 'identity', submode: 'two' }, { mode: 'doudizhu', submode: 'two' },
    { mode: 'versus', submode: 'four' }, { mode: 'versus', submode: 'two', connectMode: true },
    { mode: 'versus', submode: 'two', meSide: undefined }, { mode: 'versus', submode: 'two', otherSide: undefined },
    { mode: 'versus', submode: 'two', meSide: 1, otherSide: 1 },
    { mode: 'versus', submode: 'two', meSide: 'red', otherSide: 'red' },
    { mode: 'versus', submode: 'two', meSide: true, otherSide: false },
  ];
  for (const scenario of scenarios) {
    const f = fixture({ mode: scenario.mode }); f._status.mode = scenario.submode; f._status.connectMode = scenario.connectMode;
    f.other.isUnderControl = () => true; f.game.me.hasSkillTag = () => true;
    f.game.me.side = Object.hasOwn(scenario, 'meSide') ? scenario.meSide : true;
    f.other.side = Object.hasOwn(scenario, 'otherSide') ? scenario.otherSide : true;
    const original = f.other.getCards; f.other.getCards = zone => { assert.ok(!zone.includes('h'), JSON.stringify(scenario)); return original(zone); };
    for (const detail of [false, true]) {
      const state = f.api.observe(detail);
      assert.equal(state.players[0].hand, undefined); assert.equal(state.players[0].handVisibility, undefined);
      assert.ok(!JSON.stringify(state).includes('secret_other_hand'));
      assert.equal(state.me.hand[0].name, 'sha');
    }
  }
});

test('2v2 team inference is not applied to identity or unverified versus variants', () => {
  for (const mode of ['identity','versus']) {
    const f = fixture({ mode }); f._status.mode = mode === 'identity' ? 'two' : 'four'; f.game.me.side = true; f.other.side = false;
    const state = f.api.observe(); assert.equal(state.players[0].identity.visibility, 'hidden'); assert.equal(state.players[0].team, undefined);
  }
});


test('skill button projection delegates canonical name to the same flow resolver as choice context', () => {
  const seen = [];
  const f = fixture({ flow: { logs() { return null; }, canonicalSkill(name) { seen.push(name); return name === 'tia_daowu_shan' ? 'tia_daowu' : null; }, choiceContext() { return { skill: 'tia_daowu', certainty: 'known' }; } } });
  const skills = new Element('skills'); skills.appendChild(Object.assign(new Element('', 'tia_daowu_shan'), { link: 'tia_daowu_shan' })); f.ui.skills = skills;
  const choice = f.api.observe().choice, option = choice.options.find(o => o.kind === 'skill');
  assert.equal(option.skill, 'tia_daowu_shan'); assert.equal(option.contextSkillCanonical, choice.context.skill); assert.deepEqual(seen, ['tia_daowu_shan']);
});
