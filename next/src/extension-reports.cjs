'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../state/_extension-reports');
const bounded=value=>String(value || '').slice(0,16000);
// Runs before the reloaded page evaluates extension modules. It records errors,
// not player state or arbitrary console objects.
function installCapture() {
  window.__extensionLoadErrors=[];
  const record=value=>{window.__extensionLoadErrors.push(value);if(window.__extensionLoadErrors.length>100)window.__extensionLoadErrors.shift();};
  window.addEventListener('error',event=>record({type:'error',message:String(event.message),stack:event.error?.stack,filename:event.filename,line:event.lineno,column:event.colno}));
  window.addEventListener('unhandledrejection',event=>record({type:'rejection',message:String(event.reason?.message || event.reason),stack:event.reason?.stack}));
  for(const key of ['error','log']){
    const original=console[key];
    console[key]=function(...args){
      const message=args.map(x=>{try{return typeof x==='string'?x:x?.stack?String(x.stack):x?.message?String(x.message):'[object]';}catch{return '[object]';}}).join(' ');
      if(key==='error'||/加载.*扩展.*错误/.test(message))record({type:'console.'+key,message});
      return original.apply(this,args);
    };
  }
}
function location(entry, text) {
  const matches=[...text.matchAll(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/g)];
  const match=matches.find(m=>m[1].includes('/extension/')) || matches[0];
  const url=match?.[1]?.includes('/extension/') ? match[1] : entry.filename || match?.[1];
  if(!url)return null;
  let file=url;try{file=decodeURIComponent(new URL(url).pathname).replace(/^\//,'');}catch{}
  const fromStack=url===match?.[1];
  return {file,line:Number(fromStack ? match?.[2] : entry.line) || null,column:Number(fromStack ? match?.[3] : entry.column) || null};
}
function normalize(entries, fallback) {
  const groups=new Map();
  for(const entry of (entries.length ? entries : [{type:'operation',message:fallback}]).slice(0,100)) {
    const text=bounded(entry.stack || entry.message), message=text.match(/(?:\w*Error|DOMException):[^\n]+/)?.[0] || bounded(entry.message).split('\n')[0];
    const source=location(entry,text), key=JSON.stringify([message,source]);
    const old=groups.get(key);
    if(old){old.occurrences++;if(!old.channels.includes(entry.type))old.channels.push(entry.type);continue;}
    groups.set(key,{message,source,stack:text,channels:[entry.type || 'unknown'],occurrences:1,hook:/\bprecontent\b/.test(text)?'precontent':/\bcontent\b/.test(text)?'content':null});
  }
  return [...groups.values()];
}
function save(context, error, root=ROOT) {
  const reportId=crypto.randomUUID();
  const report={schema:1,reportId,createdAt:new Date().toISOString(),operation:context.operation || 'extension_import',target:context.target,name:error.extensionName || context.name || null,zip:context.zip ? path.resolve(context.zip) : null,sha256:error.archiveSha256 || context.sha256 || null,phase:error.reportPhase || context.phase || 'import',code:error.code || 'extension_import_failed',message:bounded(error.message),observationSeconds:context.observationSeconds || 0,events:normalize(error.diagnostics || [],error.stack || error.message)};
  if(context.session)Object.assign(report,{session:context.session,client:context.client,sessionStartedAt:context.sessionStartedAt,room:context.room || null,origin:context.origin || 'unknown',eventKey:context.eventKey,occurredAt:context.occurredAt});
  fs.mkdirSync(root,{recursive:true});const filename=path.join(root,reportId+'.json');
  const temp=filename+'.tmp';fs.writeFileSync(temp,JSON.stringify(report,null,2)+'\n',{flag:'wx'});fs.renameSync(temp,filename);
  return {reportId,reportFile:filename};
}
function read(id,root=ROOT) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw Error('Invalid extension report ID.');
  return JSON.parse(fs.readFileSync(path.join(root,id+'.json'),'utf8'));
}
function list(root=ROOT) {
  if(!fs.existsSync(root))return [];
  return fs.readdirSync(root).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f)).map(f=>read(f.slice(0,-5),root)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(({reportId,createdAt,name,target,phase,code,session,client})=>({reportId,createdAt,name,target,phase,code,session,client}));
}
module.exports={save,read,list,normalize,installCapture,ROOT};
