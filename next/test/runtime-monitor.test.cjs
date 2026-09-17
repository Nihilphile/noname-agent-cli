'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {capture,protocolEntry}=require('../src/runtime-error-worker.cjs');
const reports=require('../src/extension-reports.cjs'),monitor=require('../src/runtime-monitor.cjs');
const context={session:'test',client:'isolated',sessionStartedAt:'2026-09-17T00:00:00Z',target:'room',room:{id:'room',role:'host'}};
const event=(timestamp=1000)=>({method:'Runtime.consoleAPICalled',params:{type:'error',timestamp,args:[{subtype:'error',description:'Error: skill broke\n    at Object.content (http://localhost/extension/Nihilphile/module/guanyu.js:269:11)'}],stackTrace:{callFrames:[{url:'http://localhost/noname/library/element/gameEvent.js',lineNumber:235,columnNumber:20,functionName:'loop'}]}}});
test('engine-caught skill errors persist independently of page evaluation, with session and extension source',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-error-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const seen=new Set(),saved=capture(event(),context,seen,root),r=reports.read(saved.reportId,root);
  assert.equal(r.operation,'extension_runtime');assert.equal(r.phase,'runtime');assert.equal(r.name,'Nihilphile');assert.equal(r.session,'test');
  assert.deepEqual(r.events[0].source,{file:'extension/Nihilphile/module/guanyu.js',line:269,column:11});assert.equal(r.zip,null);
  assert.equal(capture(event(),context,seen,root),null);
  assert.ok(capture(event(2000),context,seen,root),'same error at a later time is a new occurrence');
  const restartedSeen=new Set([r.eventKey]);assert.equal(capture(event(),context,restartedSeen,root),null);
});
test('protocol capture preserves unhandled errors but never expands arbitrary remote objects',()=>{
  const e=protocolEntry({method:'Runtime.exceptionThrown',params:{exceptionDetails:{exception:{description:'Uncaught (in promise) Error: rejection'},url:'http://localhost/extension/Test/a.js',lineNumber:3,columnNumber:4}}});
  assert.equal(e.line,4);assert.match(e.message,/rejection/);
  assert.equal(protocolEntry({method:'Runtime.consoleAPICalled',params:{type:'log',args:[{value:'ordinary'}]}}),null);
  assert.equal(protocolEntry({method:'Runtime.consoleAPICalled',params:{type:'error',args:[{type:'object',description:'private state',objectId:'secret'}]}}),null);
  assert.equal(protocolEntry({method:'Page.javascriptDialogOpening',params:{message:'是否继续？'}}),null);
});
test('monitor health reports dead, stale and degraded workers accurately',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'monitor-health-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  monitor.write(monitor.controlFile(dir),{enabled:true,token:'test',pid:process.pid});
  monitor.write(monitor.workerFile(dir,'test'),{status:'armed',heartbeat:'2000-01-01T00:00:00Z'});
  assert.equal(monitor.status(dir).status,'unresponsive');
  monitor.write(monitor.workerFile(dir,'test'),{status:'degraded',heartbeat:new Date().toISOString(),error:'disconnected'});
  assert.equal(monitor.status(dir).status,'degraded');assert.equal(monitor.disable(dir).status,'disabled');
});
test('disposable ZIP installer lifecycle never creates a continuous monitor',async()=>{
  const api={async start(){return {status:'running'};},sessionDir(){throw Error('must not access monitor');}};
  assert.deepEqual(await monitor.lifecycle(api,'isolated').start({extensionOnly:true}),{status:'running'});
});
