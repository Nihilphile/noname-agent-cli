'use strict';
// Optional local-engine contract probes. Execute the installed engine's exact
// content and loop bodies read-only; UI/network and trigger dispatch are stubs.
// This is not a full-engine or live-client acceptance test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installFlow } = require('../src/flow.cjs');
const { createEventJournal } = require('../src/event-journal.cjs');
const { DEFAULT_SOURCE } = require('../src/native-session.cjs');
const engineDir = process.env.NONAME_NATIVE_ELEMENT_DIR || path.join(DEFAULT_SOURCE, 'noname', 'library', 'element');
const available = fs.existsSync(path.join(engineDir, 'content.js')) && fs.existsSync(path.join(engineDir, 'gameEvent.js'));
const skillFile = path.resolve(engineDir, '../skill.js');
const huojingFile = path.resolve(engineDir, '../../../extension/Nihilphile/module/huojing_rewrite.js');
const standardCardFile = path.resolve(engineDir, '../../../card/standard.js');

function between(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `native source boundary changed: ${start}`);
  return source.slice(from, to);
}
function fixture() {
  const source = fs.readFileSync(path.join(engineDir, 'content.js'), 'utf8');
  const eventSource = fs.readFileSync(path.join(engineDir, 'gameEvent.js'), 'utf8');
  const gameSource = fs.readFileSync(path.resolve(engineDir, '../../game/index.js'), 'utf8');
  const order = [];
  const _status = { dying: [], globalHistory: [{ changeHp: [], cardMove: [] }], pauseManager: { async waitPause() {} } };
  const lib = { element: {}, commonArea: [], phaseName: ['phaseZhunbei', 'phaseJudge', 'phaseDraw', 'phaseUse', 'phaseDiscard', 'phaseJieshu'], translate: { a: '甲', b: '乙', c: '丙', d: '丁', sha: '杀', shan: '闪', tao: '桃', jiu: '酒', wugu: '五谷丰登', zhiheng: '制衡', zhiheng_info: '公开技能', _recasting: '重铸', nihil_xiegong: '协攻', nihil_xiegong_info: '公开锁定技', nihil_junshang: '军赏', nihil_junshang_info: '公开技能' }, skill: { global: [], zhiheng: { direct: true }, _recasting: { discard: false, lose: false, logv: false }, nihil_xiegong: { forced: true }, nihil_junshang: {} }, card: {}, status: { videoId: 0 }, config: {} };
  const get = { plainText: x => x, itemtype: x => Array.isArray(x) ? 'cards' : x?.physical ? 'card' : null, position: () => 'c', cnNumber: String, translation: p => p.name, owner: () => null, cardInfo: x => x, id: () => 'card-id', number: c => c.number, suit: c => c.suit, color: () => 'red' };
  const ui = { sidebar: { children: [] }, ordering: { appendChild() {} }, discardPile: {}, arena: { classList: { remove() {} } }, clear() {} };
  const game = { players: [], dead: [], roundNumber: 1, getGlobalHistory: () => _status.globalHistory.at(-1), log() {}, logv() {}, trySkillAudio() {}, addVideo() {}, broadcast() {}, broadcastAll() {}, async delay() {}, checkMod() {}, cardsGotoOrdering: () => ({ async forResult() {} }) };
  const context = vm.createContext({ game, lib, get, ui, _status, window: {}, console });
  vm.runInContext('Array.prototype.add = function(value) { if (!this.includes(value)) this.push(value); return this; }; Array.prototype.addArray = function(values) { this.push(...(values || [])); return this; }; Array.prototype.removeArray = function(values) { for (const value of values || []) { let index; while ((index = this.indexOf(value)) >= 0) this.splice(index, 1); } return this; };', context);
  const content = vm.runInContext(`({${between(source, '  async changeHp(event) {', '  dying: [')}${between(source, '  judge: [', '  async turnOver(event) {')}})`, context);
  // Execute complete native first steps, leaving later unrelated skill/zone
  // content out of this narrow public-material boundary probe.
  for (const name of ['useSkill', 'lose']) {
    const marker = '    async (event, trigger, player) => {';
    const first = source.indexOf(marker, source.indexOf(`\n  ${name}: [`));
    const second = source.indexOf(marker, first + marker.length);
    assert.ok(first >= 0 && second > first);
    content[name] = vm.runInContext(`[${source.slice(first, second)}]`, context);
  }
  content.draw = vm.runInContext(`({${between(source, '  async draw(event, trigger, player) {', '  async discard(event, trigger, player) {')}}).draw`, context);
  content.cardsGotoOrdering = vm.runInContext(`({${between(source, '  async cardsGotoOrdering(event, trigger, player) {', '  async cardsGotoSpecial(event, trigger, player) {')}}).cardsGotoOrdering`, context);
  const gainSection = source.indexOf('\n  gain: ['), gainMarker = '    async (event, trigger, player) => {';
  const gainFirst = source.indexOf(gainMarker, gainSection), gainSecond = source.indexOf(gainMarker, gainFirst + gainMarker.length), gainThird = source.indexOf(gainMarker, gainSecond + gainMarker.length);
  assert.ok(gainSection >= 0 && gainFirst > gainSection && gainThird > gainSecond);
  content.gainReceipt = vm.runInContext(`[${source.slice(gainSecond, gainThird)}]`, context);
  const loseSection = source.indexOf('\n  lose: ['), loseReceiptStart = source.indexOf('      event.cards2 = hs.concat(es);', loseSection), loseReceiptEnd = source.indexOf('      if (event.position == ui.ordering)', loseReceiptStart);
  assert.ok(loseSection >= 0 && loseReceiptStart > loseSection && loseReceiptEnd > loseReceiptStart);
  content.loseReceipt = vm.runInContext(`async (event, trigger, player) => { let { cards } = event, hs = event.hs || cards, es = event.es || []; ${source.slice(loseReceiptStart, loseReceiptEnd)} }`, context);
  content.discard = vm.runInContext(`({${between(source, '  async discard(event, trigger, player) {', '  async loseToDiscardpile(event, trigger, player) {')}}).discard`, context);
  content.createTrigger = vm.runInContext(`({${between(source, '  async createTrigger(event, trigger, player) {', '  async playVideoContent(event, trigger, player) {')}}).createTrigger`, context);
  const nativeCreateTrigger = vm.runInContext(`({${between(gameSource, '  createTrigger(name2, skill, player, event2, indexedData) {', '  /**\n   *\n   * @param { string } name')}}).createTrigger`, context);
  get.info = name => lib.skill[name]; get.skillTranslation = name => lib.translate[name]; get.time = () => 0;
  context.nativeContent = content;
  context.order = order;
  const GameEvent = vm.runInContext(`(class GameEvent {
    #inContent; #waitNext;
    constructor(name, props = {}) { Object.assign(this, { name, finished: false, _triggered: 0, next: [], after: [], manager: {} }, props); }
    async checkSkipped() { return false; }
    getParent() { return this.parent; }
    finish() { this.finished = true; }
    untrigger() {}
    ${between(eventSource, '  cancel(all, player, notrigger) {', '  // @todo')}
    start() { return this._start ||= (async () => { const previous = _status.event; _status.event = this; try { await this.loop(); } finally { _status.event = previous; } })(); }
    then(resolve, reject) { return this.start().then(resolve, reject); }
    async trigger(name) { order.push(name); await this.onTrigger?.(name); }
    setContent(value) { this._content = typeof value === 'string' ? nativeContent[value] : value; return this; }
    async content() { const value = this._content || nativeContent[this.name]; for (const step of (Array.isArray(value) ? value : [value])) await step(this, this._trigger || null, this.player); this.finished = true; }
    ${between(eventSource, '  async loop() {', '  async checkSkipped() {')}
    ${between(eventSource, '  waitNext() {', '  // #endregion')}
  })`, context);
  class Player {
    constructor(name) { Object.assign(this, { name, playerid: `${name}-id`, hp: 4, maxHp: 4, hujia: 0, judging: [], stat: [{ skill: {} }], actionHistory: [{ gain: [], lose: [], useSkill: [] }], hiddenSkills: [], invisibleSkills: [], additionalSkills: {} }); }
    getCards() { return []; }
    countCards() { return 0; }
    isDead() { return false; }
    isOut() { return false; }
    hasSkillTag() { return false; }
    update() { order.push({ update: _status.event?.name, hp: this.hp, armor: this.hujia, receipt: _status.globalHistory[0].changeHp.includes(_status.event) }); }
    $damagepop() {}
    logSkill(skill) { order.push({logSkill:skill,event:_status.event?.name}); }
    $throw(cards) { order.push({throw:_status.event?.name,visible:_status.event?.visible,parent:_status.event?.parent?.name,ancestor:_status.event?.parent?.parent?.name}); for (const card of cards) card.clone = { classList: { add() {} } }; }
    checkShow() { return false; }
    trySkillAnimate() {}
    getSkills() { return []; }
    getHistory(kind) { return this.actionHistory.at(-1)[kind]; }
    discard(cards) { const event = new GameEvent('discard', { player: this, cards, parent: _status.event }); _status.event.next.push(event); return event; }
    lose(cards, position, visible) { const event = new GameEvent('lose', { player: this, cards, position, visible: visible === 'visible', parent: _status.event }); if (game.movementReceipt) { event.hs = cards; event.es = []; event.vcards = { cards: [] }; event.vcard_cards = []; event._content = content.loseReceipt; } _status.event.next.push(event); return event; }
    gain(cards, animate) { const event = new GameEvent('gain', { player: this, cards, visible: animate === 'gain2', parent: _status.event, gaintag: [] }); event.gaintag.addArray = values => event.gaintag.push(...(values || [])); event._content = content.gainReceipt; _status.event.next.push(event); return event; }
    changeHujia(num) { const parent = _status.event, event = new GameEvent('changeHujia', { parent, player: this, num }); parent.next.push(event); order.push('schedule-armor'); return event; }
  }
  lib.element = { Player, GameEvent };
  game.createEvent = (name, unused, triggerEvent) => { const parent=triggerEvent||_status.event, event=new GameEvent(name,{parent}); if(parent) parent.next.push(event); return event; };
  game.createTrigger = nativeCreateTrigger;
  const a = new Player('a'), b = new Player('b'); game.players = [a, b]; game.me = a; game.playerMap = { [a.playerid]: a, [b.playerid]: b };
  context.deps = { game, lib, get, ui, _status };
  const api = vm.runInContext(`(${installFlow.toString()})(deps,(${createEventJournal.toString()}))`, context);
  return { a, b, api, GameEvent, order, _status, ui, game, lib, get, context, content };
}

for (const [armor, damage] of [[0, 1], [2, 1], [2, 3]]) {
  test(`native HP application is immutable and visible during a paused changeHp trigger (armor ${armor}, damage ${damage})`, { skip: !available }, async () => {
    const f = fixture(); f.b.hujia = armor; f.b.update();
    const initial = f.api.eventLogs(); f.api.commitFeedback({ epoch: f.api.logs().epoch, to: 0, eventEpoch: initial.epoch, eventTo: initial.to });
    let release, paused;
    const ready = new Promise(resolve => { paused = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const hp = new f.GameEvent('changeHp', {
      player: f.b, parent: new f.GameEvent('damage', { player: f.b, source: f.a, num: damage }), num: -damage,
      async onTrigger(name) { if (name === 'changeHp') { paused(); await blocked; } },
    });
    const running = hp.start(); await ready;
    const before = JSON.parse(JSON.stringify(f.api.eventLogs()));
    assert.equal(hp.finished, false);
    assert.equal(before.entries.length, 1);
    assert.equal(before.entries[0].changes[0].kind, 'damage');
    assert.equal(before.entries[0].changes[0].hpLoss, Math.max(0, damage - armor));
    assert.equal(before.entries[0].changes[0].armorAbsorbed, armor ? null : 0);
    f.api.commitFeedback({ epoch: f.api.logs().epoch, to: 0, eventEpoch: before.epoch, eventTo: before.to });
    assert.equal(f.api.eventLogs().entries.length, 0);
    release(); await running;
    const after = JSON.parse(JSON.stringify(f.api.eventLogs()));
    assert.equal(after.entries.length, armor ? 1 : 0);
    if (armor) assert.deepEqual(after.entries[0].changes, [{kind:'damageArmor',damageId:before.entries[0].changes[0].damageId,amount:Math.min(armor,damage)}]);
    assert.deepEqual(JSON.parse(JSON.stringify(f.api.eventLogs({since:0}))).entries.find(row=>row.seq===before.entries[0].seq), before.entries[0]);
  });
}

test('native useSkill first step routes public materials through discard and lose.$throw, private loss is excluded', { skip: !available }, async () => {
  const f = fixture(), card = { physical: true, name: 'shan', suit: 'heart', number: 9 };
  f.ui.todiscard = {};
  f.game.broadcastAll = (fn, ...args) => fn(...args);
  const skill = new f.GameEvent('useSkill', { player: f.a, skill: 'zhiheng', cards: [card], targets: [] });
  await skill.start();
  const rows = JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
  assert.deepEqual(rows.map(row => row.kind), ['operation', 'materials'],JSON.stringify(f.order));
  assert.equal(rows[1].operationId, rows[0].operationId);
  assert.deepEqual(rows[1].cards, [{name:'shan',label:'闪',suit:'heart',number:9}]);
  const privateCard = {physical:true,name:'sha',suit:'spade',number:7};
  const privateSkill = new f.GameEvent('useSkill', { player:f.a,skill:'zhiheng',cards:[privateCard],targets:[],async content(){
    const discard = new f.GameEvent('discard', {player:f.a,parent:this});
    await new f.GameEvent('lose',{player:f.a,parent:discard,cards:[privateCard],visible:false,type:'discard'}).start(); this.finished=true;
  }});
  await privateSkill.start();
  assert.equal(f.api.eventLogs().entries.filter(row=>row.kind==='materials').length,1);
  assert.equal(f.api.eventLogs().samplingErrors,0);
});

test('native HP evidence survives a terminal child path that never resolves its parent', {skip:!available}, async()=>{
  const f=fixture(); let reached;
  const ready=new Promise(resolve=>{reached=resolve;});
  const hp=new f.GameEvent('changeHp',{player:f.b,num:-1,parent:new f.GameEvent('damage',{player:f.b,source:f.a,num:1}),async onTrigger(name){
    if(name==='changeHp'){ f.game.over=true; reached(); await new Promise(()=>{}); }
  }});
  hp.start(); await ready;
  const rows=JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
  assert.equal(hp.finished,false); assert.equal(rows.length,1);
  assert.equal(rows[0].changes[0].hpLoss,1); assert.equal(rows[0].changes[0].armorAbsorbed,0);
  assert.deepEqual(JSON.parse(JSON.stringify(f.api.eventLogs())).entries,rows);
});

const yccFile=path.resolve(engineDir,'../../../extension/Nihilphile/module/ycc.js');
test('installed group maintenance content updates storage without claiming its limited parent activated', {skip:!available||!fs.existsSync(yccFile)}, async()=>{
  const f=fixture(),source=fs.readFileSync(yccFile,'utf8');
  vm.runInContext(between(source,'function yccQinzhengEnemies(player) {','function yccQinzhengShouldUse(player) {'),f.context);
  const watch=vm.runInContext(`({${between(source,'    ycc_qinzheng_watch: {','    // 亲征 ->')}}).ycc_qinzheng_watch`,f.context);
  f.lib.skill.ycc_qinzheng={enable:'phaseUse',limited:true,group:'ycc_qinzheng_watch'};
  f.lib.skill.ycc_qinzheng_watch=watch;
  f.lib.translate.ycc_qinzheng='亲征'; f.lib.translate.ycc_qinzheng_info='公开限定技';
  f.game.roundNumber=2;
  f.game.players.push(new f.lib.element.Player('c'));
  f.game.filterPlayer=predicate=>f.game.players.filter(predicate);
  f.get.attitude=(from,to)=>from===to?1:-1;
  f.a.storage={}; f.a.hasSkill=()=>true;
  assert.equal(watch.filter({},f.a),true);
  f.content.ycc_qinzheng_watch=watch.content;
  await new f.GameEvent('ycc_qinzheng_watch',{player:f.a}).start();
  assert.deepEqual(f.a.storage,{ycc_qinzheng_watch_round:2,ycc_qinzheng_no_support:0});
  assert.equal(f.api.eventLogs().entries.length,0);
  assert.equal(f.a.maxHp,4);
  await new f.GameEvent('useSkill',{player:f.a,skill:'ycc_qinzheng',async content(){this.finished=true;}}).start();
  const rows=JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
  assert.equal(rows.length,1); assert.equal(rows[0].operation.id,'ycc_qinzheng');
  assert.equal(rows[0].rawSkill,'ycc_qinzheng'); assert.equal(rows[0].confirmation,'useSkill');
  assert.equal(f.api.eventLogs().samplingErrors,0);
});

const refreshFile=path.resolve(engineDir,'../../../character/refresh/skill.js');
test('native game.createTrigger scheduler preserves a public receipt for an unrelated deferred child', {skip:!available}, async()=>{
  const f=fixture(), trigger=new f.GameEvent('damageBegin4',{player:f.a,num:1});
  f.lib.skill.probe_guard={group:['probe_guard_status']};
  f.lib.skill.probe_guard_status={sourceSkill:'probe_guard',charlotte:true,forced:true,async content(){ f.a.probeActivated=true; }};
  f.lib.translate.probe_guard='守证'; f.lib.translate.probe_guard_info='公开规则';
  f.a.getSkills=()=>['probe_guard_status']; f.game.expandSkills=skills=>skills.slice();
  const scheduler=f.game.createTrigger('damageBegin4','probe_guard_status',f.a,trigger);
  assert.equal(scheduler.name,'trigger');
  await scheduler.start();
  assert.equal(f.a.probeActivated,true);
  const logCall=f.order.findIndex(row=>row?.logSkill==='probe_guard_status'&&row.event==='trigger');
  const childBegin=f.order.indexOf('probe_guard_statusBefore');
  assert.ok(logCall>=0&&logCall<childBegin);
  const rows=JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
  assert.equal(rows.length,1); assert.equal(rows[0].operation.id,'probe_guard');
  assert.equal(rows[0].rawSkill,'probe_guard_status'); assert.equal(rows[0].confirmation,'logSkill');
  assert.equal(f.api.eventLogs().samplingErrors,0);
});

test('native createTrigger logs before constructing the real Linglong rule-only child and its receipt is retained', {skip:!available||!fs.existsSync(refreshFile)}, async()=>{
  const f=fixture(),source=fs.readFileSync(refreshFile,'utf8');
  const owner=source.indexOf('\n\trelinglong: {');
  const start=source.indexOf('\n\t\t\tdirecthit: {',owner),end=source.indexOf('\n\t\t},',start);
  assert.ok(owner>=0&&start>owner&&end>start);
  const directHit=[]; directHit.addArray=cards=>directHit.push(...cards);
  const trigger={card:{name:'sha'},directHit}; f.context.trigger=trigger;
  const skill=vm.runInContext(`({${source.slice(start,end)}}).directhit`,f.context);
  f.lib.skill.relinglong={group:['relinglong_directhit']}; f.lib.skill.relinglong_directhit=skill;
  f.lib.translate.relinglong='玲珑'; f.lib.translate.relinglong_info='公开技能';
  f.a.getSkills=()=>['relinglong'];
  f.game.expandSkills=skills=>[...skills,...skills.flatMap(name=>f.lib.skill[name]?.group||[])];
  const event=f.game.createTrigger('useCard','relinglong_directhit',f.a,trigger);
  await event.start();
  assert.equal(directHit.length,f.game.players.length);
  const logCall=f.order.findIndex(row=>row?.logSkill==='relinglong_directhit');
  const childBegin=f.order.indexOf('relinglong_directhitBefore');
  assert.ok(logCall>=0&&logCall<childBegin);
  const rows=JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
  assert.equal(rows.length,1); assert.equal(rows[0].operation.id,'relinglong');
  assert.equal(rows[0].rawSkill,'relinglong_directhit'); assert.equal(rows[0].confirmation,'logSkill');
  assert.equal(f.api.eventLogs().samplingErrors,0);
});

for(const timing of ['before-receipt','after-receipt','child-before-begin']) {
  for(const notrigger of [undefined,'notrigger']) {
    test(`native cancel ${timing} (${notrigger||'normal'}) cannot cache or consume public confirmation`,{skip:!available},()=>{
      const f=fixture();
      f.lib.skill.public_rule={group:'rule_child'}; f.lib.skill.rule_child={forced:true};
      f.lib.translate.public_rule='公开规则';
      const journal=createEventJournal({game:f.game,lib:f.lib,get:f.get,_status:f._status,playerId:p=>p.name,canonicalSkill:raw=>raw==='rule_child'?'public_rule':raw});
      const wrapper=new f.GameEvent('trigger',{player:f.a,skill:'rule_child'});
      const child=new f.GameEvent('rule_child',{player:f.a,parent:wrapper});
      journal.begin(wrapper);
      if(timing==='before-receipt') wrapper.cancel(undefined,undefined,notrigger);
      journal.confirmSkill({player:f.a,skill:'rule_child',event:wrapper});
      if(timing==='after-receipt') wrapper.cancel(undefined,undefined,notrigger);
      if(timing==='child-before-begin') child.cancel(undefined,undefined,notrigger);
      const cancelled=timing==='child-before-begin'?child:wrapper;
      assert.equal(cancelled.finished,true);
      assert.equal(cancelled._cancelled,notrigger?undefined:true);
      journal.begin(child);
      assert.deepEqual(journal.logs().entries,[]);
    });
  }
}

for (const [armor, damage, loss, absorbed] of [[2, 1, 0, 1], [2, 3, 1, 2], [0, 1, 1, 0]]) {
  test(`native changeHp/changeHujia and event loop commit damage ${damage} against armor ${armor}`, { skip: !available }, async () => {
    const f = fixture(); f.b.hujia = armor; f.b.update();
    const initial = f.api.eventLogs();
    f.api.commitFeedback({ epoch: f.api.logs().epoch, to: 0, eventEpoch: initial.epoch, eventTo: initial.to });
    const parent = new f.GameEvent('damage', { player: f.b, source: f.a, num: damage, nature: 'fire' });
    const hp = new f.GameEvent('changeHp', { player: f.b, parent, num: -damage });
    await hp.start();
    const updates = f.order.filter(x => typeof x === 'object' && x.update === 'changeHp');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].receipt, true);
    assert.equal(updates[0].hp, 4 - loss);
    assert.equal(updates[0].armor, armor); // Native child has been queued, not applied yet.
    const rows = JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
    assert.equal(rows.length, absorbed ? 2 : 1);
    assert.deepEqual({ ...rows[0].changes[0], source: null }, { kind: 'damage', damageId: 'jd1', amount: damage, hpLoss: loss, armorAbsorbed: absorbed ? null : 0, source: null, nature: 'fire' });
    if (absorbed) assert.deepEqual(rows[1].changes, [{ kind: 'damageArmor', damageId: 'jd1', amount: absorbed }]);
    assert.equal(rows[0].changes[0].source.name, 'a');
    assert.equal(f.b.hujia, armor - absorbed);
    if (absorbed) assert.ok(f.order.indexOf('changeHujiaAfter') < f.order.indexOf('changeHpAfter'));
    assert.equal(f.api.eventLogs().samplingErrors, 0);
  });
}

test('native judge steps plus native loop expose only final result after judgeFixing and After', { skip: !available }, async () => {
  const f = fixture();
  const initial = { physical: true, name: 'sha', suit: 'club', number: 1 };
  const changed = { physical: true, name: 'shan', suit: 'heart', number: 2 };
  const fixed = { physical: true, name: 'sha', suit: 'spade', number: 7 };
  const final = { physical: true, name: 'shan', suit: 'diamond', number: 9 };
  const event = new f.GameEvent('judge', {
    player: f.b, directresult: initial, judgestr: '', judge: () => 1,
    position: f.ui.discardPile, dialog: { close() {} },
    async onTrigger(name) {
      if (name === 'judge') f.b.judging[0] = changed;
      if (name === 'judgeFixing') { assert.equal(this.result.card, changed); await Promise.resolve(); this.result.card = fixed; }
      if (name === 'judgeAfter') { assert.equal(this.result.card, fixed); this.result.card = final; }
      assert.equal(f.api.eventLogs().entries.filter(x => x.operation?.kind === 'judgment').length, 0);
    },
  });
  await event.start();
  const rows = JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor.system, true);
  assert.deepEqual(rows[0].operation.card, { name: 'shan', label: '闪', suit: 'diamond', number: 9 });
  assert.equal(rows[0].targets[0].name, 'b');
  assert.ok(f.order.indexOf('judge') < f.order.indexOf('judgeFixing'));
  assert.ok(f.order.indexOf('judgeFixing') < f.order.indexOf('judgeAfter'));
  assert.equal(f.api.eventLogs().samplingErrors, 0);
});

test('native draw and exact gain receipt emit one draw movement with frozen turn and phase context', { skip: !available }, async () => {
  const f = fixture(), cards = [
    { physical: true, name: 'sha', suit: 'spade', number: 7, willBeDestroyed: () => false },
    { physical: true, name: 'shan', suit: 'heart', number: 9, willBeDestroyed: () => false },
  ];
  f.get.cards = num => cards.slice(0, num);
  f.game.roundNumber = 4;
  const turn = new f.GameEvent('phase', { player: f.a });
  const phase = new f.GameEvent('phaseDraw', { player: f.a, parent: turn });
  const draw = new f.GameEvent('draw', { player: f.a, parent: phase, num: 2, gaintag: [] });
  await draw.start();
  f.game.roundNumber = 5;
  const log = JSON.parse(JSON.stringify(f.api.eventLogs()));
  const rows = log.entries.filter(row => row.kind === 'movement');
  assert.equal(rows.length, 1, JSON.stringify(log));
  assert.deepEqual({ action: rows[0].action, actor: rows[0].actor.name, count: rows[0].count }, { action: 'draw', actor: 'a', count: 2 });
  assert.deepEqual(rows[0].cards.map(card => card.name), ['sha', 'shan']);
  assert.equal(rows[0].context.round, 4);
  assert.equal(rows[0].context.turn.actor.name, 'a');
  assert.equal(rows[0].context.phase.name, 'phaseDraw');
  assert.equal(log.entries.filter(row => row.action === 'gain').length, 0);
  assert.equal(log.entries.some(row => JSON.stringify(row).includes('handCount')), false);
  assert.equal(log.samplingErrors, 0);
});

test('native discard plus exact lose receipt emits actual discard once and keeps public faces', { skip: !available }, async () => {
  const f = fixture(), card = { physical: true, name: 'shan', suit: 'heart', number: 9 };
  const cards = [card];
  cards.removeArray = values => { for (const value of values) { const index = cards.indexOf(value); if (index >= 0) cards.splice(index, 1); } };
  cards.addArray = values => cards.push(...values);
  f.game.movementReceipt = true;
  const phase = new f.GameEvent('phaseDiscard', { player: f.b, parent: new f.GameEvent('phase', { player: f.b }) });
  await new f.GameEvent('discard', { player: f.b, parent: phase, cards, position: f.ui.discardPile }).start();
  const rows = JSON.parse(JSON.stringify(f.api.eventLogs())).entries.filter(row => row.kind === 'movement');
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.deepEqual({ action: rows[0].action, actor: rows[0].actor.name, from: rows[0].from.name, to: rows[0].to, count: rows[0].count }, { action: 'discard', actor: 'b', from: 'b', to: null, count: 1 });
  assert.deepEqual(rows[0].cards, [{ name: 'shan', label: '闪', suit: 'heart', number: 9 }]);
  assert.equal(rows[0].context.phase.name, 'phaseDiscard');
  assert.equal(f.game.getGlobalHistory().cardMove.length, 1);
  assert.equal(f.api.eventLogs().samplingErrors, 0);
});

test('exact native gain receipt partitions known transfer sources and never exposes a private opponent gain', { skip: !available }, async () => {
  const f = fixture(), transferred = { physical: true, name: 'shan', suit: 'heart', number: 9, willBeDestroyed: () => false, addKnower() {} }, unknown = { physical: true, name: 'sha', suit: 'spade', number: 7, willBeDestroyed: () => false };
  const phase = new f.GameEvent('phaseUse', { player: f.a, parent: new f.GameEvent('phase', { player: f.a }) });
  const gain = new f.GameEvent('gain', { player: f.b, parent: phase, cards: [transferred, unknown], losing_map: { [f.a.playerid]: [[transferred], [transferred], []] } });
  gain.setContent(f.content.gainReceipt);
  await gain.start();
  const rows = JSON.parse(JSON.stringify(f.api.eventLogs())).entries.filter(row => row.kind === 'movement');
  assert.deepEqual(rows.map(row => [row.action, row.actor.name, row.from?.name || null, row.to?.name || null, row.count, row.cards.length]), [
    ['transfer', 'a', 'a', 'b', 1, 1], ['gain', 'b', null, 'b', 1, 0],
  ]);
  assert.deepEqual(rows[0].cards, [{ name: 'shan', label: '闪', suit: 'heart', number: 9 }]);
  assert.equal(rows[0].context.phase.name, 'phaseUse');
  assert.equal(f.api.eventLogs().samplingErrors, 0);
});

test('native wugu ordering receipt reveals its public pool and every visible gain without exposing an unrelated gain', { skip: !available || !fs.existsSync(standardCardFile) }, async () => {
  const wuguRule = between(fs.readFileSync(standardCardFile, 'utf8'), '\t\t\twugu: {', '\t\t\twuxie: {');
  assert.match(wuguRule, /game\.cardsGotoOrdering\(cards\)\.relatedEvent = event\.getParent\(\)/);
  assert.match(wuguRule, /target\.gain\(card, "visible"\)/);
  const f = fixture(), c = new f.lib.element.Player('c'), d = new f.lib.element.Player('d');
  f.game.players.push(c, d); f.game.playerMap[c.playerid] = c; f.game.playerMap[d.playerid] = d;
  const cards = [
    { physical: true, name: 'sha', suit: 'spade', number: 7 },
    { physical: true, name: 'shan', suit: 'heart', number: 9 },
    { physical: true, name: 'tao', suit: 'diamond', number: 3 },
    { physical: true, name: 'jiu', suit: 'club', number: 5 },
  ];
  for (const card of cards) Object.assign(card, { willBeDestroyed: () => false, fix() {} });
  const turn = new f.GameEvent('phase', { player: f.a });
  const phase = new f.GameEvent('phaseUse', { player: f.a, parent: turn });
  const use = new f.GameEvent('useCard', { player: f.a, parent: phase, card: { name: 'wugu' }, targets: [f.a, f.b, c, d], async content() { this.finished = true; } });
  await use.start();
  f.get.position = () => 'o';
  const ordering = new f.GameEvent('cardsGotoOrdering', { parent: new f.GameEvent('wugu', { player: f.a, card: use.card, parent: use }), relatedEvent: use, cards });
  use.noOrdering = true;
  ordering.setContent(f.content.cardsGotoOrdering);
  await ordering.start();
  for (const [target, card] of [[f.a, cards[0]], [f.b, cards[1]], [c, cards[2]], [d, cards[3]]]) {
    const resolution = new f.GameEvent('wugu', { player: f.a, target, card: use.card, parent: use });
    const gain = new f.GameEvent('gain', { player: target, parent: resolution, cards: [card], animate: 'visible', gaintag: [] });
    gain.gaintag.addArray = values => gain.gaintag.push(...(values || []));
    gain.setContent(f.content.gainReceipt);
    await gain.start();
  }
  const unrelated = { physical: true, name: 'sha', suit: 'diamond', number: 12, willBeDestroyed: () => false };
  const hidden = new f.GameEvent('gain', { player: f.b, parent: phase, cards: [unrelated], gaintag: [] });
  hidden.gaintag.addArray = values => hidden.gaintag.push(...(values || []));
  hidden.setContent(f.content.gainReceipt);
  await hidden.start();
  const rows = JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
  const shown = rows.filter(row => row.operation?.kind === 'showCards');
  assert.equal(shown.length, 1, JSON.stringify(rows));
  assert.equal(shown[0].actor.name, 'a');
  assert.deepEqual(shown[0].operation.cards.map(card => card.name), ['sha', 'shan', 'tao', 'jiu']);
  const gains = rows.filter(row => row.kind === 'movement' && row.action === 'gain');
  assert.deepEqual(gains.map(row => [row.actor.name, row.cards.map(card => card.name)]), [
    ['a', ['sha']], ['b', ['shan']], ['c', ['tao']], ['d', ['jiu']], ['b', []],
  ]);
  assert.equal(rows.filter(row => row.kind === 'movement' && row.action === 'gain' && row.cards.length === 1).length, 4);
  assert.equal(f.api.eventLogs().samplingErrors, 0);
});

test('installed recasting rule enters the native useSkill path as one public 重铸 activation', { skip: !available || !fs.existsSync(skillFile) }, async () => {
  const source = fs.readFileSync(skillFile, 'utf8');
  const rule = between(source, '  _recasting: {', '  _lianhuan: {');
  assert.match(rule, /enable: "phaseUse"/);
  assert.match(rule, /player\.recast\(event\.cards/);
  const f = fixture(), event = new f.GameEvent('useSkill', { player: f.a, skill: '_recasting', cards: [], targets: [] });
  await event.start();
  const rows = JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.deepEqual({ kind: rows[0].operation.kind, id: rows[0].operation.id, label: rows[0].operation.label, confirmation: rows[0].confirmation }, { kind: 'skill', id: '_recasting', label: '重铸', confirmation: 'useSkill' });
  assert.equal(f.api.eventLogs().samplingErrors, 0);
});

test('installed self-xiegong branch explicit logSkill yields distinct 军赏 activation in the enclosing native event', { skip: !available || !fs.existsSync(huojingFile) }, async () => {
  const source = fs.readFileSync(huojingFile, 'utf8');
  const branch = between(source, '    async function resolveXiegongFailure(owner, commander) {', '    function matchingTransferredCards(moveEvent, owner, commander) {');
  assert.match(branch, /owner\.logSkill\("nihil_junshang"\)/);
  assert.match(branch, /await owner\.draw\(1\)/);
  const f = fixture(), event = new f.GameEvent('nihil_xiegong', { player: f.a });
  event.setContent(async () => { f.a.logSkill('nihil_junshang'); });
  await event.start();
  const rows = JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
  assert.deepEqual(rows.map(row => [row.operation?.id, row.confirmation]), [['nihil_xiegong', 'event'], ['nihil_junshang', 'logSkill']]);
  assert.equal(f.api.eventLogs().samplingErrors, 0);
});
