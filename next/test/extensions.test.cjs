'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zip = require('./helpers/zip.cjs');
const {inspectZip,hash} = require('../src/extension-files.cjs');
const {createServer} = require('../src/server.cjs');
const {importInPage,persistConfig,loaded} = require('../src/extension-page.cjs');
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(),'noname-zip-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }
function archive(t, entries) { const filename = path.join(temp(t),'test.zip'); fs.writeFileSync(filename,zip(entries)); return filename; }
test('ZIP preflight accepts UTF-8 names, metadata and nested resources with exact hashes', t => {
  const f = archive(t,[['extension.js','export default {}'],['info.json',JSON.stringify({name:'测试扩展'})],['图像/a.txt','content'],['empty/','']]);
  const result = inspectZip(f);
  assert.equal(result.name,'测试扩展'); assert.equal(result.files.length,4); assert.equal(result.files[2].sha256,hash('content'));assert.deepEqual(result.files[3],{path:'empty',dir:true});
});
for (const bad of ['../escape','/absolute','a\\b','C:/evil','CON.txt','a/../b','a./b','a /b']) test(`ZIP refuses unsafe resource path ${bad}`, t => {
  assert.throws(()=>inspectZip(archive(t,[['extension.js','x'],[bad,'bad']])),/Unsafe/);
});
test('ZIP refuses duplicate case aliases, file/directory conflicts and wrapped entry points', t => {
  assert.throws(()=>inspectZip(archive(t,[['extension.js','x'],['EXTENSION.JS','y']])),/duplicate/);
  assert.throws(()=>inspectZip(archive(t,[['extension.js','x'],['a','x'],['a/b','x']])),/collision/);
  assert.throws(()=>inspectZip(archive(t,[['wrapped/extension.js','x']])),/root/);
  assert.throws(()=>inspectZip(archive(t,[['extension.js','x'],['info.json','{"name":"__proto__"}']])),/invalid extension name/);
});
test('ZIP refuses corrupt CRC and excessive declared expansion before native execution', t => {
  const root = temp(t), file = path.join(root,'bad.zip');
  const bytes = zip([['extension.js','test']]); const end = bytes.length-22, central = bytes.readUInt32LE(end+16);
  bytes.writeUInt32LE(0,central+16); fs.writeFileSync(file,bytes); assert.throws(()=>inspectZip(file),/CRC/);
  bytes.writeUInt32LE(129*1024*1024,central+24); fs.writeFileSync(file,bytes); assert.throws(()=>inspectZip(file),/limit/);
});
test('import callback and registration are required; fulfilled undefined is success, false is failure', async () => {
  const lib = {config:{extensions:[]}}, game = {promises:{},importedPack:{name:'stale'},async importExtension(bytes, done) { assert.equal(bytes.byteLength,3); assert.equal(this.importedPack,undefined); lib.config.extensions.push('new'); lib.config.extension_new_enable = true; done(); }};
  assert.deepEqual(await importInPage({lib,game,_status:{}},{base64:'YWJj'}),{name:'new',completed:true});
  game.importExtension = async () => false;
  await assert.rejects(importInPage({lib,game,_status:{}},{base64:'YWJj',name:'new'}),/did not complete/);
});
test('native import refuses a changed extension name before registration or file writes', async () => {
  let wrote=false;
  const game={promises:{},async importExtension(){this.importedPack={name:'unexpected'};wrote=true;}};
  await assert.rejects(importInPage({game,lib:{config:{extensions:[]}},_status:{}},{base64:'YWJj',name:'expected'}),/name changed/);
  assert.equal(wrote,false);assert.equal(Object.hasOwn(game,'importedPack'),false);
});
test('native import always restores the file adapter when a write fails', async () => {
  const createDir=async()=>{},writeFile=async()=>{};
  const game={promises:{createDir,writeFile},async importExtension(){throw Error('disk failure');}};
  await assert.rejects(importInPage({game,lib:{config:{extensions:[]}},_status:{}},{base64:'YWJj',token:'test'}),/disk failure/);
  assert.equal(game.promises.createDir,createDir);assert.equal(game.promises.writeFile,writeFile);
});
test('Electron import normalizes native Windows output paths for the scoped writer', async t => {
  let requested;
  t.mock.method(globalThis,'fetch',async url=>{requested=new URL(url,'http://localhost').searchParams.get('path');return {ok:true};});
  const lib={config:{extensions:[]}},game={promises:{},async importExtension(_bytes,done){await this.promises.writeFile(new Uint8Array(),'./','extension\\Name\\file.js');lib.config.extensions.push('Name');lib.config.extension_Name_enable=true;done();}};
  await importInPage({lib,game,_status:{}},{base64:'YWJj',token:'test'});
  assert.equal(requested,'./extension/Name/file.js');
});
test('reload verification cannot accept the old document', t => {
  const previous=globalThis.window;globalThis.window={__extensionReloadMarker:'old'};
  t.after(()=>{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;});
  assert.deepEqual(loaded({}, {name:'Test',marker:'old'}),{ready:false});
});
test('persistence rejects an aborted transaction without claiming success', async () => {
  const lib={config:{extensions:['new'],extension_new_enable:true},db:{transaction(){const tx={objectStore:()=>({put(){}})};queueMicrotask(()=>tx.onabort());return tx;}}};
  await assert.rejects(persistConfig({lib,_status:{}},'new'),/transaction failed/);
});
test('config persistence waits for transaction commit, then verifies readback', async () => {
  let committed = false, reads = 0;
  const stored = {}, lib = {config:{extensions:['new'],extension_new_enable:true}, db:{transaction(_names,mode) {
    const tx = {objectStore:()=>({put(value,key){stored[key]=value;},get(key){assert.equal(committed,true);reads++;const req={};queueMicrotask(()=>{req.result=stored[key];req.onsuccess();});return req;}})};
    setImmediate(()=>{ if(mode==='readwrite') committed=true; tx.oncomplete(); }); return tx;
  }}};
  const result = await persistConfig({lib,_status:{}},'new'); assert.equal(result.persisted,true);assert.equal(reads,2);
});
test('isolated import endpoint requires a token and validated exact content; source stays read-only', async t => {
  const root = temp(t), source = path.join(root,'source'), staging = path.join(root,'staging'); fs.mkdirSync(source);fs.mkdirSync(staging);fs.writeFileSync(path.join(source,'index.html'),'source');
  const data = Buffer.from('expected');
  const server = createServer({source,token:'secret',importRoot:staging,importFiles:[{path:'extension.js',bytes:data.length,sha256:hash(data)},{path:'empty',dir:true}]});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>{server.closeAllConnections();server.close();}); const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p,body,token='secret') => fetch(base+'/__oneshot/extension-write?path='+encodeURIComponent(p),{method:'POST',headers:{'x-oneshot-token':token},body});
  assert.equal((await post('extension/Test/extension.js',data,'bad')).status,403);
  assert.equal((await post('extension/Test/../index.html',data)).status,403);
  assert.equal((await post('extension/Test/extension.js','bad-data')).status,500);
  assert.equal((await post('extension/Test/extension.js','too-large')).status,413);
  assert.equal((await post('extension/Test/extension.js',data)).status,200);
  assert.equal(fs.readFileSync(path.join(staging,'extension/Test/extension.js'),'utf8'),'expected');
  assert.equal(fs.existsSync(path.join(source,'extension')),false);
  assert.equal((await fetch(base+'/__oneshot/extension-mkdir?path=extension/Test/empty/',{method:'POST',headers:{'x-oneshot-token':'secret'}})).status,200);
  assert.equal(fs.statSync(path.join(staging,'extension/Test/empty')).isDirectory(),true);
  assert.equal(await (await fetch(base+'/extension/Test/extension.js')).text(),'expected');
});
test('pinned extension shadows source files and preserves first-boot registration', async t => {
  const root = temp(t), source = path.join(root,'source'), overlay = path.join(root,'version');
  fs.mkdirSync(path.join(source,'extension/Test'),{recursive:true});fs.mkdirSync(path.join(source,'game'));fs.mkdirSync(overlay);
  fs.writeFileSync(path.join(source,'extension/Test/old.js'),'old');fs.writeFileSync(path.join(overlay,'extension.js'),'new');fs.writeFileSync(path.join(source,'game/config.json'),'{}');
  const server = createServer({source,token:'secret',roomProfile:true,extensionBundle:[{name:'Test',root:overlay,characterPacks:['different_id'],cardPacks:[]}]});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(base+'/extension/Test/extension.js')).text(),'new');
  assert.equal((await fetch(base+'/extension/Test/old.js')).status,404);
  const config=await (await fetch(base+'/game/config.json')).json();assert.equal(config.extension_Test_enable,true);assert.ok(config.characters.includes('different_id'));
});
