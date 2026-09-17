'use strict';
// A separate process owns this CDP subscription after the command exits. It
// observes protocol events only; it does not evaluate code or answer dialogs.
const crypto=require('node:crypto');
const reports=require('./extension-reports.cjs'),monitor=require('./runtime-monitor.cjs');
const {connectCDP}=require('./transport.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function protocolEntry(event){
  const p=event.params || {};let message,filename,line,column,stack;
  if(event.method==='Runtime.exceptionThrown'){
    const e=p.exceptionDetails || {};message=e.exception?.description || e.text;filename=e.url;
    line=Number.isInteger(e.lineNumber)?e.lineNumber+1:null;column=Number.isInteger(e.columnNumber)?e.columnNumber+1:null;stack=e.stackTrace;
  }else if(event.method==='Runtime.consoleAPICalled'){
    message=(p.args || []).map(a=>a.subtype==='error'?a.description:typeof a.value==='string'?a.value:'').filter(Boolean).join(' ');
    if(p.type!=='error'&&!/加载.*扩展.*错误|Game alert:.*(?:Error|错误|出错)/s.test(message))return null;
    stack=p.stackTrace;
  }else if(event.method==='Page.javascriptDialogOpening'){
    message=p.message;if(!/Error|错误|出错/.test(message))return null;filename=p.url;
  }else return null;
  if(!message)return null;
  const frames=(stack?.callFrames || []).slice(0,30).map(f=>`    at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber+1}:${f.columnNumber+1})`).join('\n');
  return {type:event.method==='Runtime.consoleAPICalled'?'console.'+p.type:event.method,message:String(message).slice(0,16000),stack:(message+'\n'+frames).slice(0,16000),filename,line,column};
}
function capture(event,context,seen,root){
  const entry=protocolEntry(event);if(!entry)return null;
  // CDP replays console/exception history on reconnect. Timestamp + contents
  // distinguish replay from a new occurrence of the same skill failure.
  const eventKey=crypto.createHash('sha256').update(JSON.stringify([context.client,context.session,context.sessionStartedAt,event.method,event.params?.timestamp ?? crypto.randomUUID(),entry])).digest('hex');
  if(seen.has(eventKey))return null;
  const source=reports.normalize([entry],'')[0].source;
  const name=source?.file.match(/^extension\/([^/]+)\//)?.[1] || null;
  const error=Object.assign(Error(entry.message),{code:'game_runtime_error',diagnostics:[entry]});
  const result=reports.save({...context,operation:'extension_runtime',phase:'runtime',name,origin:name?'extension':'unknown',eventKey,
    occurredAt:Number.isFinite(event.params?.timestamp)?new Date(event.params.timestamp).toISOString():new Date().toISOString()},error,root);
  seen.add(eventKey);return result;
}
async function run(name,client,token){
  if(!['native','isolated'].includes(client)||! /^[0-9a-f-]{36}$/.test(token))throw Error('Invalid monitor worker arguments');
  const api=require(client==='native'?'./native-session.cjs':'./session.cjs'),dir=api.sessionDir(name);
  const file=monitor.workerFile(dir,token),initial=api.read(name),id=monitor.identity(initial),seen=new Set();
  const context={session:name,client,sessionStartedAt:initial.startedAt,target:initial.room?'room':client,room:initial.room?{id:initial.room.id,role:initial.room.role}:null};
  // Durable reports themselves are the replay checkpoint, including after a
  // worker crash between writing a report and updating its health status.
  for(const row of reports.list()){if(row.session!==name||row.client!==client)continue;const r=reports.read(row.reportId);if(r.sessionStartedAt===initial.startedAt&&r.eventKey)seen.add(r.eventKey);}
  let cdp,lastReportId=null;
  const health=(status,error=null)=>monitor.write(file,{status,error,heartbeat:new Date().toISOString(),lastReportId});
  const current=()=>{const c=monitor.read(monitor.controlFile(dir)),s=api.read(name);return c?.enabled&&c.token===token&&s?.status==='running'&&!s.cleanupComplete&&monitor.identity(s)===id;};
  const json=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('CDP endpoint unavailable');return r.json();};
  try{while(current()){
    try{
      health('connecting');const s=api.read(name),base=`http://127.0.0.1:${s.cdpPort || s.port}`;
      if((await json(base+'/json/version')).webSocketDebuggerUrl!==s.browserWs)throw Error('Session endpoint ownership changed');
      const page=(await json(base+'/json/list')).find(p=>p.type==='page'&&p.id===s.pageId);
      if(!page)throw Error('Recorded game page is unavailable');
      cdp=await connectCDP(page.webSocketDebuggerUrl,{timeout:3000});
      let captureError=null;
      cdp.onEvent(event=>{try{if(!current())return;const r=capture(event,context,seen);if(r)lastReportId=r.reportId;}catch(error){captureError=error;}});
      await cdp.send('Runtime.enable');await cdp.send('Page.enable');
      while(current()){
        if(captureError)throw captureError;
        await cdp.send('Page.getFrameTree');health('armed');await sleep(500);
      }
    }catch(error){health('degraded',error.message);if(current())await sleep(1000);}
    finally{cdp?.close();cdp=null;}
  }}finally{cdp?.close();health('stopped');}
}
if(require.main===module)run(...process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={protocolEntry,capture,run};
