'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const n = require('../src/notification.cjs');
const binding = { thread_id: '01a0a6f7-069e-73f3-8eb8-2a1020ea856d' };
const session = { startedAt: '2026-09-16', browserWs: 'ws://test', pid: 555 };
const choice = (decisionId = 'd1', revision = 'epoch:1') => ({ state: 'choice', revision, choice: { id: 'same-event', decisionId,
  event: 'chooseToUse', context: { actor: 'p1' }, options: [{ id: 'c1', label: '杀', kind: 'card' }] },
  log: { epoch: 'log', from: 13, to: 15, entries: [13,14,15].map(seq=>({seq,text:'公开记录'+seq})) } });
const running = { state: 'running', revision: 'epoch:2' };
function fixture(t, initial = running, presentation = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-notify-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const sent = [];
  n.enable(dir,binding,session,initial,presentation);
  const submit = async (b,m) => { sent.push({ b,m }); return { state:'accepted',outcome:'queue_accepted',receipt:'r'+sent.length }; };
  const args = { session, sessionName:'play', client:'native', submit };
  return { dir,sent,args, tick:snapshot=>n.tick(dir,{...args,snapshot}) };
}
test('new decision sends once; option/revision/log changes do not spam',async t=>{
  const f=fixture(t); await f.tick(choice()); await f.tick(choice('d1','epoch:999'));
  assert.equal(f.sent.length,1); assert.equal(n.read(f.dir).last.state,'accepted');
});
test('same event re-enters same step without sampled running but new generation wakes',async t=>{
  const f=fixture(t); await f.tick(choice()); await f.tick(choice('d2','epoch:3')); assert.equal(f.sent.length,2);
});
test('empty option set waits for actual actionable options',async t=>{
  const f=fixture(t), empty=choice(); empty.choice.options=[]; await f.tick(empty); assert.equal(f.sent.length,0);
  await f.tick(choice()); assert.equal(f.sent.length,1);
});
test('feedback suppresses the returned choice; running re-arms even same event',async t=>{
  const f=fixture(t,choice()); await f.tick(choice()); assert.equal(f.sent.length,0);
  n.acknowledge(f.dir,session,running); await f.tick(choice()); assert.equal(f.sent.length,1);
});
test('snapshot overlapping completed act/plan is discarded by feedback token',async t=>{
  const f=fixture(t), feedback=n.read(f.dir).feedback;
  n.acknowledge(f.dir,session,choice('new','epoch:4'));
  await n.tick(f.dir,{...f.args,snapshot:choice('old'),feedback}); assert.equal(f.sent.length,0);
});
test('notification is player-view and does not mutate snapshot or consume its logs',async t=>{
  const f=fixture(t,running,{detail:true}), s=choice(), before=JSON.stringify(s); await f.tick(s);
  assert.equal(JSON.stringify(s),before); assert.match(f.sent[0].m,/\[13-15\]/);
  assert.match(f.sent[0].m,/不是指令/); assert.match(f.sent[0].m,/observe/);
});
test('brief subscription defaults to a bounded prompt without scene, session or revision',async t=>{
  const f=fixture(t), s=choice(); s.me={label:'关羽',hp:4}; s.choice.prompt='是否发动断义？'+'长'.repeat(300);
  await f.tick(s);
  const text=f.sent[0].m;
  assert.match(text,/关羽需要决策/); assert.match(text,/当前提示：是否发动断义/);
  assert.doesNotMatch(text,/"snapshot"|"session"|"revision"|epoch:1/);
  assert.match(text,/…\n\[13-15\]/); assert.match(text,/公开记录13/); assert.ok(text.length<750);
  assert.equal(n.status(f.dir).detail,false);
  assert.equal(n.read(f.dir).last.revision,'epoch:1','ledger still retains revision');
  assert.equal(n.read(f.dir).last.snapshot.me.hp,4,'ledger retains public snapshot');
});
test('detail preference persists across action feedback and removes only notification routing fields',async t=>{
  const f=fixture(t,running,{detail:true});
  n.acknowledge(f.dir,session,running); n.beginOperation(f.dir);
  await f.tick(choice());
  assert.equal(n.read(f.dir).detail,true); assert.equal(n.status(f.dir).detail,true);
  const text=f.sent[0].m;
  assert.match(text,/"snapshot"/); assert.match(text,/公开记录13/);
  assert.doesNotMatch(text,/"session"|"revision"|epoch:1|"notification"/);
  n.enable(f.dir,binding,session,running);
  assert.equal(n.read(f.dir).detail,false,'notify on without detail selects brief');
});
test('brief death and fault notifications do not invent a decision prompt',()=>{
  assert.match(n.messageFor({kind:'dead',snapshot:{me:{label:'关羽'}}},'private-session','native'),/关羽已死亡/);
  const text=n.messageFor({kind:'fault',error:'connection failed'},'private-session','native');
  assert.match(text,/连接需要检查/); assert.doesNotMatch(text,/当前提示|private-session|revision/);
});
test('detailed scene keeps only public card fields while logs remain independently visible',async t=>{
  const f=fixture(t,running,{detail:true}), s=choice();
  s.me={label:'关羽',hand:[{name:'sha',label:'杀',suit:'heart',number:7,storage:{secret:'no'}}],equipment:[{name:'bagua',label:'八卦阵'}],marks:[{name:'盾',count:2}]};
  s.players=[{label:'敌人',handCount:3,equipment:[],storage:{secret:'no'}}];
  await f.tick(s);
  const text=f.sent[0].m;
  assert.match(text,/八卦阵/); assert.match(text,/"handCount":3/); assert.match(text,/"suit":"heart"/); assert.match(text,/公开记录13/);
  assert.doesNotMatch(text,/storage|secret|"revision"|"session"/);
  assert.equal(n.read(f.dir).last.snapshot.players[0].hand,undefined);
});
test('long Chinese scene and log previews are bounded independently with explicit truncation',()=>{
  const s=choice(); s.me={label:'甲'};
  s.log.entries=Array.from({length:100},(_,i)=>({seq:i+1,text:'甲摸了两张牌'+'长'.repeat(400)})); s.log.from=1;s.log.to=100;
  s.choice.prompt='长'.repeat(1200); s.choice.options=Array.from({length:60},(_,i)=>({id:'c'+i,label:'长'.repeat(200)}));
  const snapshot=n.compactSnapshot(s,{detail:true});
  for(const detail of [false,true]) {
    const text=n.messageFor({kind:'choice',snapshot},'hidden-session','native',{detail});
    assert.ok(Buffer.byteLength(text)<16000); assert.match(text,/记录已截断/); assert.match(text,/100\]/);
    assert.doesNotMatch(text,/hidden-session|"revision"/);
  }
});
test('a huge translated character label cannot escape the complete notification size bound',()=>{
  const s=choice(); s.me={label:'长'.repeat(9000)};
  const snapshot=n.compactSnapshot(s,{detail:true});
  for(const detail of [false,true]) {
    const text=n.messageFor({kind:'choice',snapshot},'play','native',{detail});
    assert.ok(Buffer.byteLength(text)<16000); assert.match(text,/…需要决策/); assert.match(text,/公开记录13/);
  }
});
test('inflight is durable before send; crash recovery pauses without duplicate',async t=>{
  const f=fixture(t);
  const prepared=n.prepareTick(f.dir,{...f.args,snapshot:choice()}); assert.equal(prepared.item.state,'inflight');
  assert.equal(n.read(f.dir).last.state,'inflight'); await f.tick(choice());
  assert.equal(f.sent.length,0); assert.equal(n.read(f.dir).last.state,'uncertain'); assert.equal(n.read(f.dir).enabled,false);
});
test('timeout/uncertain never retries automatically',async t=>{
  const f=fixture(t); let calls=0;
  await n.tick(f.dir,{...f.args,snapshot:choice(),submit:async()=>{calls++;return{state:'uncertain',outcome:'timeout'};}});
  await f.tick(choice('d2')); assert.equal(calls,1); assert.equal(f.sent.length,0); assert.equal(n.status(f.dir).status,'delivery_uncertain');
});
test('off cannot revoke accepted message and inflight finish cannot re-enable',async t=>{
  const f=fixture(t), p=n.prepareTick(f.dir,{...f.args,snapshot:choice()}); n.disable(f.dir);
  n.finishTick(f.dir,p,{state:'accepted',receipt:'accepted-before-off'});
  assert.equal(n.read(f.dir).enabled,false); await f.tick(choice('d2')); assert.equal(f.sent.length,0);
});
test('new binding generation cannot be overwritten by old delivery completion',async t=>{
  const f=fixture(t), p=n.prepareTick(f.dir,{...f.args,snapshot:choice()}); n.disable(f.dir);
  n.enable(f.dir,{thread_id:'new-thread'},session,running);
  assert.equal(n.finishTick(f.dir,p,{state:'accepted'}),undefined); assert.equal(n.read(f.dir).binding.thread_id,'new-thread');
});
test('old game over delivery finishing after restart cannot disable the new game',t=>{
  const f=fixture(t), p=n.prepareTick(f.dir,{...f.args,snapshot:{state:'over',revision:'epoch:99'}});
  n.acknowledge(f.dir,session,choice('next','new-epoch:1'),{restart:true});
  n.finishTick(f.dir,p,{state:'accepted',receipt:'old-over'});
  assert.equal(n.read(f.dir).enabled,true); assert.equal(n.read(f.dir).last.state,'uncertain');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'notifications.jsonl'),'utf8')).superseded,true);
});
test('off/on fences old worker and inflight recovery cannot poison new binding',async t=>{
  const f=fixture(t); n.write(f.dir,{...n.read(f.dir),workerPid:process.pid});
  n.prepareTick(f.dir,{...f.args,snapshot:choice()}); n.disable(f.dir);
  n.enable(f.dir,binding,session,choice()); assert.equal(n.read(f.dir).workerPid,null);
  await f.tick(choice()); assert.equal(n.read(f.dir).enabled,true); assert.equal(f.sent.length,0);
});
test('re-enable the same destination tolerates normal Codex database growth',t=>{
  const f=fixture(t), b={...binding,profile:{path:'profile',database:{path:'db',dev:1,ino:2,size:100,mtimeMs:1}}};
  n.disable(f.dir); n.enable(f.dir,b,session,running);
  n.enable(f.dir,{...b,profile:{...b.profile,database:{...b.profile.database,size:200,mtimeMs:2}}},session,running);
  assert.equal(n.read(f.dir).enabled,true);
  assert.throws(()=>n.enable(f.dir,{...b,thread_id:'changed'},session,running),{code:'notification_already_bound'});
});
test('session replacement closes subscription rather than reading another game',async t=>{
  const f=fixture(t); await n.tick(f.dir,{...f.args,session:{...session,browserWs:'replacement'},snapshot:choice()});
  assert.equal(f.sent.length,0); assert.equal(n.status(f.dir).status,'session_changed');
});
test('death then game over notify once each, game over stops watcher',async t=>{
  const f=fixture(t); await f.tick({state:'dead',revision:'epoch:2'}); await f.tick({state:'dead',revision:'epoch:3'});
  await f.tick({state:'over',revision:'epoch:4'}); await f.tick({state:'over',revision:'epoch:5'});
  assert.equal(f.sent.length,2); assert.equal(n.status(f.dir).status,'game_over');
});
test('runtime fault sends bounded report and stops',async t=>{
  const f=fixture(t); await n.tick(f.dir,{...f.args,error:'Client disconnected'}); await n.tick(f.dir,{...f.args,error:'again'});
  assert.equal(f.sent.length,1); assert.equal(n.status(f.dir).status,'runtime_fault');
});
test('large snapshot output is bounded and omissions explicit',()=>{
  const s=choice(); s.choice.options=Array.from({length:100},(_,i)=>({id:'c'+i,label:'长'.repeat(400),kind:'card'}));
  const snapshot=n.compactSnapshot(s); assert.equal(snapshot.choice.options.length,40); assert.equal(snapshot.choice.omittedOptions,60);
  const m=n.messageFor({id:'n',kind:'choice',snapshot},'play','native',{detail:true}); assert.ok(Buffer.byteLength(m)<16000); assert.match(m,/truncated/);
});
test('corrupt ledger fails closed rather than resending everything',t=>{
  const f=fixture(t); fs.writeFileSync(path.join(f.dir,'notification.json'),'{bad');
  assert.throws(()=>n.read(f.dir),{code:'notification_state_invalid'});
});
