'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const installation=require('../src/installation.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noname-install-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const root=path.join(dir,'游戏 目录'),source=path.join(root,'resources/app');fs.mkdirSync(source,{recursive:true});for(const name of ['noname.js','index.html'])fs.writeFileSync(path.join(source,name),'fixture');fs.writeFileSync(path.join(root,'无名杀.exe'),'fixture');return {dir,root,source,file:path.join(dir,'installation.json')};}
test('installation accepts a moved game root with spaces and Chinese, persisted for another process',t=>{
  const f=fixture(t),saved=installation.save({source:f.root},f.file);
  assert.equal(saved.source,f.source);assert.equal(saved.executable,path.join(f.root,'无名杀.exe'));
  const {execFileSync}=require('node:child_process');
  const value=JSON.parse(execFileSync(process.execPath,['-e',"console.log(JSON.stringify(require(process.argv[1]).defaults(process.argv[2],{})))",require.resolve('../src/installation.cjs'),f.file],{encoding:'utf8'}));
  assert.equal(value.source,f.source);assert.equal(installation.normalize(f.source),f.source);
});
test('invalid replacement leaves the previous installation config intact',t=>{
  const f=fixture(t);installation.save({source:f.root},f.file);const before=fs.readFileSync(f.file,'utf8');
  assert.throws(()=>installation.save({source:path.join(f.dir,'absent')},f.file),e=>e.code==='installation_invalid');
  assert.throws(()=>installation.save({source:f.root,browser:path.join(f.dir,'missing.exe')},f.file),/浏览器/);
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
});
test('environment overrides saved source without rewriting local config',t=>{
  const f=fixture(t);installation.save({source:f.root},f.file);
  assert.equal(installation.defaults(f.file,{NONAME_SOURCE:'another-install'}).source,'another-install');
  assert.equal(installation.defaults(f.file,{NONAME_SOURCE:'another-install'}).executable,undefined);
  assert.equal(installation.defaults(f.file,{NONAME_SOURCE:'another-install',NONAME_EXECUTABLE:'custom.exe'}).executable,'custom.exe');
  assert.equal(installation.defaults(f.file,{}).source,f.source);
});
test('a fresh installation does not fall back to the author computer',t=>{
  const f=fixture(t);assert.deepEqual(installation.defaults(f.file,{}),{source:undefined,executable:undefined,browser:undefined});
  fs.writeFileSync(f.file,'broken');assert.throws(()=>installation.defaults(f.file,{}),e=>e.code==='installation_config_invalid');
});
