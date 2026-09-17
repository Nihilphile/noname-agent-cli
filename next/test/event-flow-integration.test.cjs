'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installFlow } = require('../src/flow.cjs');
const { createEventJournal } = require('../src/event-journal.cjs');
const { formatExperimental } = require('../src/experimental-format.cjs');

function fixture() {
  class Player {
    constructor(name) { Object.assign(this, {name,playerid:`${name}-id`,hp:3,maxHp:3,hujia:0,dead:false,actionHistory:[{gain:[],lose:[]}]}); }
    getCards() { return []; }
    countCards() { return 2; }
    isDead() { return this.dead; }
    update() { return this; }
    logSkill(skill, targets) { this.lastLogSkill = [skill, targets]; return 'native-result'; }
    $throw(cards) { this.lastThrow = cards; return 'native-throw'; }
  }
  class GameEvent {
    constructor(name, props) { Object.assign(this,{name,finished:false},props); }
    async loop() { await this.run?.(); this.finished=true; }
    trigger() { return this; }
  }
  const a=new Player('a'),b=new Player('b');
  const deps={lib:{element:{Player,GameEvent},translate:{a:'甲',b:'乙',sha:'杀',shan:'闪',shield:'加盾',shield_info:'公开锁定技能'},skill:{shield:{forced:true,silent:true}}},game:{players:[a,b],dead:[],me:a,addCardKnower(cards,knower){this.knowledge=[cards,knower];return 'native-knowledge';}},get:{plainText:x=>x,itemtype:x=>x?.physical?'card':null},ui:{sidebar:{children:[]}},_status:{dying:[],globalHistory:[]}};
  const context=vm.createContext({window:{},deps});
  const api=vm.runInContext(`(${installFlow.toString()})(deps,(${createEventJournal.toString()}))`,context);
  return {a,b,deps,api,GameEvent};
}

test('real serialized flow hooks capture a passive skill without any native log and keep its target state inside the actor block', async()=>{
  const f=fixture();
  const event=new f.GameEvent('shield',{player:f.a,targets:[f.b],run(){f.deps._status.event=this;f.b.hujia++;f.b.update();}});
  await event.loop();
  assert.equal(f.api.logs().entries.length,0);
  const journal=JSON.parse(JSON.stringify(f.api.eventLogs()));
  assert.equal(journal.entries[0].operation.id,'shield');
  assert.equal(journal.entries[1].changes[0].kind,'armor');
  assert.match(formatExperimental(journal),/甲 \{ 加盾\[乙\]，乙（盾\+1） \}/);
  assert.equal(journal.samplingErrors,0);
});

test('terminal public state is sampled even if the engine never resolves the enclosing loop',()=>{
  const f=fixture();
  const card=new f.GameEvent('useCard',{player:f.a,card:{name:'sha'},targets:[f.b],run(){f.b.hp=0;f.b.dead=true;f.deps.game.dead.push(f.b);return new Promise(()=>{});}});
  card.loop();
  const rows=JSON.parse(JSON.stringify(f.api.eventLogs())).entries;
  assert.equal(rows[0].kind,'operation');
  assert.ok(rows.some(row=>row.changes?.some(change=>change.kind==='dead'&&change.after===true)));
  assert.equal(card.finished,false);
});

test('act feedback validates both independent cursors before consuming either and observation never consumes',async()=>{
  const f=fixture();
  await new f.GameEvent('useSkill',{skill:'shield',player:f.a,targets:[f.b]}).loop();
  f.deps.ui.sidebar.children.push({innerText:'原生独立日志'});
  const raw=f.api.logs(),experimental=f.api.eventLogs();
  assert.throws(()=>f.api.commitFeedback({epoch:raw.epoch,to:raw.to,eventEpoch:experimental.epoch,eventTo:999}),/invalid journal commit/);
  assert.equal(f.api.logs().entries.length,1);
  assert.equal(f.api.eventLogs().entries.length,1);
  f.api.commitFeedback({epoch:raw.epoch,to:raw.to,eventEpoch:experimental.epoch,eventTo:experimental.to});
  assert.equal(f.api.logs().entries.length,0);
  assert.equal(f.api.eventLogs().entries.length,0);
  f.b.hujia++;f.b.update();
  assert.equal(f.api.eventLogs().entries.length,1);
});

test('structured native logSkill hook confirms direct activation and late target, retaining native result', async()=>{
  const f=fixture(); f.deps.lib.skill.shield.direct=true;
  const event=new f.GameEvent('shield',{player:f.a,run(){
    f.deps._status.event=this;
    this.target=f.b;
    assert.equal(f.a.logSkill('shield',f.b),'native-result');
    f.b.hujia++; f.b.update();
  }});
  await event.loop();
  const log=JSON.parse(JSON.stringify(f.api.eventLogs()));
  assert.deepEqual(log.entries.map(x=>x.kind),['operation','targets','state']);
  assert.match(formatExperimental(log),/加盾\[乙\]，乙（盾\+1）/);
  assert.equal(log.samplingErrors,0);
});

test('direct cancellation stays empty through serialized native loop hooks',async()=>{
  const f=fixture(); f.deps.lib.skill.shield.direct=true;
  const event=new f.GameEvent('shield',{player:f.a,async run(){
    this.target=f.b;
    const child=new f.GameEvent('chooseBool',{player:f.a,parent:this,result:{bool:false}});
    await child.loop();
  }});
  await event.loop();
  assert.equal(f.api.eventLogs().entries.length,0);
});

test('serialized native update and event completion fold actual damage HP and armor into one result', async()=>{
  const f=fixture(); f.b.hujia=2; f.b.update();
  const first=f.api.eventLogs(); f.api.commitFeedback({epoch:f.api.logs().epoch,to:0,eventEpoch:first.epoch,eventTo:first.to});
  const damage=new f.GameEvent('damage',{player:f.b,source:f.a,num:3,nature:'fire'});
  const hp=new f.GameEvent('changeHp',{player:f.b,parent:damage,num:-1,hujia:2,async run(){
    f.deps._status.event=this;
    f.deps._status.globalHistory.push({changeHp:[this]});
    f.b.hp--; f.b.update();
    const armor=new f.GameEvent('changeHujia',{player:f.b,parent:this,type:'damage',run(){f.deps._status.event=this;f.b.hujia-=2;f.b.update();}});
    await armor.loop(); f.deps._status.event=this;
  }});
  await hp.loop();
  const log=JSON.parse(JSON.stringify(f.api.eventLogs()));
  assert.equal(log.entries.length,2);
  assert.equal(log.entries[0].changes[0].hpLoss,1);
  assert.equal(log.entries[0].changes[0].armorAbsorbed,null);
  assert.deepEqual(log.entries[1].changes,[{kind:'damageArmor',damageId:log.entries[0].changes[0].damageId,amount:2}]);
  assert.match(formatExperimental(log),/受火伤-3｜来源甲｜hp-1｜盾吸收2/);
  assert.equal(log.samplingErrors,0);
});

test('public show boundary and real throw hooks expose only their explicit public payloads',async()=>{
  const f=fixture(), card={physical:true,name:'shan',suit:'heart',number:9};
  await new f.GameEvent('showCards',{player:f.a,cards:[card],run(){
    f.deps._status.event=this;
    assert.equal(f.deps.game.addCardKnower([card],'everyone'),'native-knowledge');
  }}).loop();
  await new f.GameEvent('useCard',{player:f.a,skill:'shield',card:{name:'sha'},cards:[card],targets:[f.b],run(){
    f.deps._status.event=this;
    assert.equal(f.a.$throw([card]),'native-throw');
  }}).loop();
  const log=JSON.parse(JSON.stringify(f.api.eventLogs()));
  assert.deepEqual(log.entries.map(e=>e.kind),['operation','operation','operation','materials']);
  assert.match(formatExperimental(log),/展示：闪【♥9】（1张）/);
  assert.match(formatExperimental(log),/加盾‹闪【♥9】›\[乙\]，杀/);
  assert.equal(log.samplingErrors,0);
});

test('judge final result from completed loop has system ownership, not the judged player',async()=>{
  const f=fixture();
  await new f.GameEvent('judge',{player:f.b,result:{card:{physical:true,name:'sha',suit:'spade',number:7}},run(){
    this.result.card={physical:true,name:'shan',suit:'heart',number:2};
  }}).loop();
  const log=JSON.parse(JSON.stringify(f.api.eventLogs()));
  assert.equal(log.entries[0].actor.system,true);
  assert.match(formatExperimental(log),/系统 \{ 判定\[乙\]：闪【♥2】 \}/);
  assert.doesNotMatch(formatExperimental(log),/杀|spade|判定·/);
});

test('serialized lifecycle hooks preserve native ancestry context and emit receipt-backed movement',async()=>{
  const f=fixture(); f.deps.game.roundNumber=3;
  const turn=new f.GameEvent('phase',{player:f.a});
  const phase=new f.GameEvent('phaseDraw',{player:f.a,parent:turn});
  const card={physical:true,name:'sha',suit:'spade',number:7};
  const draw=new f.GameEvent('draw',{player:f.a,parent:phase});
  const gain=new f.GameEvent('gain',{player:f.a,parent:draw,cards:[card],run(){f.a.actionHistory[0].gain.push(this);}});
  await gain.loop(); f.deps.game.roundNumber=4;
  const log=JSON.parse(JSON.stringify(f.api.eventLogs()));
  assert.equal(log.entries.length,1);
  assert.deepEqual({kind:log.entries[0].kind,action:log.entries[0].action,count:log.entries[0].count},{kind:'movement',action:'draw',count:1});
  assert.equal(log.entries[0].context.round,3);
  assert.equal(log.entries[0].context.turn.actor.name,'a');
  assert.equal(log.entries[0].context.phase.name,'phaseDraw');
  assert.equal(log.entries[0].operationId,null);
  assert.deepEqual(log.players.map(player=>player.name),['a','b']);
  assert.equal(log.samplingErrors,0);
});
