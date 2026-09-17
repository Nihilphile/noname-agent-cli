'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {expression}=require('../src/page.cjs');

test('page import does not poison the module graph before HTML parsing completes',async()=>{
  let imported=0;
  const script=new vm.Script(expression('observe'),{importModuleDynamically(){imported++;throw Error('unexpected import');}});
  await assert.rejects(script.runInNewContext({window:{},document:{readyState:'loading'}}),/page_loading/);
  assert.equal(imported,0);
});
test('native page import waits for the actual vue import map in the same evaluation',async()=>{
  let imported=0;
  const script=new vm.Script(expression('observe'),{importModuleDynamically(){imported++;throw Error('unexpected import');}});
  await assert.rejects(script.runInNewContext({window:{__oneshotNativeDialogInstalled:true},document:{readyState:'interactive',querySelectorAll:()=>[]},location:{href:'http://localhost:8089/index.html'},URL}),/entry_not_ready/);
  assert.equal(imported,0);
});
