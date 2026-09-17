'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const identity=s=>crypto.createHash('sha256').update(JSON.stringify([s.startedAt,s.browserWs,s.pid,s.pageId])).digest('hex');
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function write(file,value){const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,file);}
const controlFile=dir=>path.join(dir,'runtime-monitor.json');
const workerFile=(dir,token)=>path.join(dir,'runtime-monitor-'+token+'.json');
function status(dir){
  const c=read(controlFile(dir));if(!c)return {enabled:false,status:'disabled'};
  const w=read(workerFile(dir,c.token)),workerAlive=alive(c.pid);
  return {enabled:c.enabled,status:!c.enabled?'disabled':!workerAlive?'unavailable':!w?'starting':Date.now()-Date.parse(w.heartbeat)>10000?'unresponsive':w.status,
    workerAlive,workerPid:c.pid,heartbeat:w?.heartbeat || null,lastReportId:w?.lastReportId || null,error:w?.error || null};
}
function locked(dir,fn){
  fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'runtime-monitor.lock');
  if(fs.existsSync(file)){const owner=read(file);if(alive(owner?.pid))throw Error('Runtime monitor is being updated; retry.');fs.unlinkSync(file);}
  const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));return fn();}finally{fs.closeSync(fd);fs.unlinkSync(file);}
}
function disable(dir){locked(dir,()=>{const c=read(controlFile(dir));if(c)write(controlFile(dir),{...c,enabled:false});});return status(dir);}
async function enable(api,name,client){
  const dir=api.sessionDir(name),s=api.read(name);
  if(!s||s.cleanupComplete||s.status!=='running')throw Error('Start a running session before enabling runtime monitoring.');
  const token=locked(dir,()=>{
    const old=read(controlFile(dir));
    if(old?.enabled&&old.identity===identity(s)&&alive(old.pid))return old.token;
    const token=crypto.randomUUID();
    write(controlFile(dir),{enabled:true,token,identity:identity(s),session:name,client,pid:null});
    const log=fs.openSync(path.join(dir,'runtime-monitor.log'),'a');let child;
    try{child=spawn(process.execPath,[path.join(__dirname,'runtime-error-worker.cjs'),name,client,token],{detached:true,windowsHide:true,stdio:['ignore',log,log]});}
    finally{fs.closeSync(log);}
    child.on('error',()=>{});child.unref();
    write(controlFile(dir),{enabled:true,token,identity:identity(s),session:name,client,pid:child.pid || null});return token;
  });
  const until=Date.now()+12000;
  while(Date.now()<until){const v=status(dir);if(v.status==='armed')return v;if(read(controlFile(dir))?.token!==token||!v.enabled)throw Error('Runtime monitor activation was superseded.');if(v.status==='unavailable')break;await sleep(100);}
  return status(dir);
}
function lifecycle(api,client){return {...api,
  async status(name='default'){return {...await api.status(name),errorMonitor:status(api.sessionDir(name))};},
  async start(options={}){const s=await api.start(options);if(options.extensionOnly)return s;
    try{return {...s,errorMonitor:await enable(api,options.session || 'default',client)};}
    catch(error){return {...s,errorMonitor:{enabled:false,status:'unavailable',error:error.message}};}
  },
  async stop(name='default'){const s=await api.stop(name);if(s.cleanupComplete||s.status==='absent')disable(api.sessionDir(name));return s;}
};}
module.exports={enable,disable,status,identity,read,write,controlFile,workerFile,lifecycle};
