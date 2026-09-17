'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const reports=require('../src/extension-reports.cjs');
test('reports persist source coordinates and collapse repeated channels',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noname-reports-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const message='Error: fixture boom\n    at Object.precontent (http://127.0.0.1:1234/extension/Test/extension.js:4:18)';
  const error=Object.assign(Error('failed'),{code:'extension_load_error',reportPhase:'reload',diagnostics:[{type:'alert',message},{type:'console.error',message}]});
  const saved=reports.save({zip:'fixture.zip',name:'Test',target:'room',sha256:'abc'},error,root);
  const report=reports.read(saved.reportId,root);
  assert.equal(report.events.length,1);assert.equal(report.events[0].occurrences,2);assert.equal(report.events[0].hook,'precontent');
  assert.deepEqual(report.events[0].source,{file:'extension/Test/extension.js',line:4,column:18});
  assert.equal(reports.list(root)[0].reportId,saved.reportId);assert.throws(()=>reports.read('../escape',root),/Invalid/);
});
test('missing runtime locations remain unknown rather than invented',()=>{
  const result=reports.normalize([{type:'error',message:'SyntaxError: Unexpected token'}],'');
  assert.equal(result[0].source,null);
});
test('capture retains asynchronous error stacks and bounds the buffer without serializing state objects',()=>{
  const callbacks={},window={addEventListener:(name,fn)=>callbacks[name]=fn},console={log(){},error(){}};
  vm.runInNewContext(`(${reports.installCapture.toString()})();`,{window,console});
  callbacks.error({message:'Uncaught Error: timer',error:{stack:'Error: timer\n at timer (http://localhost/extension/Test/runtime.js:7:2)'},filename:'http://localhost/extension/Test/runtime.js',lineno:7,colno:2});
  assert.equal(window.__extensionLoadErrors[0].line,7);
  callbacks.unhandledrejection({reason:{message:'promise',stack:'Error: promise'}});
  assert.equal(window.__extensionLoadErrors[1].type,'rejection');
  console.error({hiddenHand:['private']});assert.equal(window.__extensionLoadErrors[2].message,'[object]');
  assert.doesNotThrow(()=>console.error({get stack(){throw Error('getter');}}));
  for(let i=0;i<200;i++)console.error('Error: '+i);assert.equal(window.__extensionLoadErrors.length,100);
});
test('protocol diagnostics survive a loading dialog and only disposable clients cancel it',async()=>{
  const {reloadAndVerify}=require('../src/extensions.cjs');
  for(const native of [false,true]){
    let listener;const sends=[];
    const cdp={onEvent(fn){listener=fn;return()=>{listener=null;};},async send(method,params){
      sends.push({method,params});
      if(method==='Page.addScriptToEvaluateOnNewDocument')return {identifier:'capture'};
      if(method==='Page.reload'){
        listener({method:'Runtime.consoleAPICalled',params:{type:'error',args:[{subtype:'error',description:'SyntaxError: fixture syntax'}]}});
        listener({method:'Page.javascriptDialogOpening',params:{type:'confirm',message:'扩展加载失败，是否移除？'}});
      }
      return {};
    },async evaluate(expression){return expression.startsWith('window.')?true:{ready:true,loaded:true,enabled:true,diagnostics:[]};}};
    await assert.rejects(reloadAndVerify(cdp,'Test',native),error=>error.diagnostics.some(d=>d.message.includes('fixture syntax')));
    assert.equal(sends.some(s=>s.method==='Page.handleJavaScriptDialog'&&s.params.accept===false),!native);
    assert.equal(listener,null);
  }
});
