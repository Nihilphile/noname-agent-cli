'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const session = require('./session.cjs');
const setup = require('./room-setup.cjs');
const page = require('./extension-page.cjs');
const files = require('./extension-files.cjs');
const reports = require('./extension-reports.cjs');
const ROOT = path.resolve(__dirname, '../state/_extensions');
const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
const catalogPath = () => path.join(ROOT, 'catalog.json');
function catalog() { return fs.existsSync(catalogPath()) ? JSON.parse(fs.readFileSync(catalogPath(), 'utf8')) : []; }
function snapshot() {
  return catalog().map(entry => {
    const root = path.join(ROOT, 'versions', entry.sha256, 'extension', entry.name);
    files.verifyFiles(root, entry.files);
    return {...entry, root};
  });
}
function list() { return {ok:true, target:'room', extensions:catalog().map(({name,sha256,characterPacks,cardPacks}) => ({name,sha256,characterPacks,cardPacks}))}; }
function removeStage(dir) {
  const parent = path.join(ROOT, 'staging');
  if (path.dirname(path.resolve(dir)) !== parent) throw Error('Invalid staging directory.');
  fs.rmSync(dir, {recursive:true, force:true});
}
async function job(cdp, fn, value) {
  const key = '__extensionJob_' + crypto.randomBytes(8).toString('hex');
  await cdp.evaluate(`(()=>{window[${JSON.stringify(key)}]={};(async()=>(${fn.toString()})(await import('/noname.js'),${JSON.stringify(value)}))().then(value=>{window[${JSON.stringify(key)}]={ready:true,value}},error=>{window[${JSON.stringify(key)}]={ready:true,error:String(error.stack||error)}});return true;})()`);
  const result = await setup.poll(cdp, (_, key) => window[key] || {}, key, 'extension operation (do not retry while running)', 120000);
  await cdp.evaluate(`delete window[${JSON.stringify(key)}]`);
  if (result.error) throw Error(result.error);
  return result.value;
}
async function reloadAndVerify(cdp, name, native = false, observationSeconds = 0) {
  const marker = crypto.randomUUID();
  let phase='reload';
  const protocol=[];
  const collect=value=>{protocol.push(value);if(protocol.length>100)protocol.shift();};
  const unsubscribe=cdp.onEvent(event=>{
    if(event.method==='Runtime.exceptionThrown'){
      const d=event.params.exceptionDetails;
      collect({type:'exception',message:d.exception?.description || d.text,stack:d.exception?.description,filename:d.url,line:d.lineNumber==null?null:d.lineNumber+1,column:d.columnNumber==null?null:d.columnNumber+1});
    }
    if(event.method==='Runtime.consoleAPICalled'){
      const p=event.params,message=(p.args || []).map(a=>a.value ?? (a.subtype==='error'?a.description:'[object]')).join(' ');
      if(p.type==='error'||/加载.*扩展.*错误/.test(message))collect({type:'console.'+p.type,message});
    }
    if(event.method==='Page.javascriptDialogOpening'){
      collect({type:'dialog',message:event.params.message});
      // Only the disposable installer may automatically cancel a confirmation.
      // This unblocks diagnostics without accepting a removal/reset prompt.
      if(!native && event.params.type==='confirm')cdp.send('Page.handleJavaScriptDialog',{accept:false}).catch(()=>{});
    }
  });
  await cdp.send('Runtime.enable');
  const observer = await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`(${reports.installCapture.toString()})();`});
  try {
    await cdp.evaluate(`window.__extensionReloadMarker=${JSON.stringify(marker)}`);
    protocol.length=0;
    await cdp.send('Page.reload',{ignoreCache:true});
    let result = await setup.poll(cdp,page.loaded,{name,marker,native},'extension reload verification');
    if (!result.loaded || !result.enabled) fail('extension_not_loaded','ZIP imported but its extension entry did not load after restart.');
    const errorsOf=value=>[...value.diagnostics,...protocol].filter(d => !['alert','dialog'].includes(d.type) || /错误|失败|error/i.test(d.message));
    if(!errorsOf(result).length && observationSeconds){
      phase='observe';
      await new Promise(resolve=>setTimeout(resolve,observationSeconds*1000));
      result=await setup.evaluate(cdp,page.loaded,{name,marker,native});
      if(!result.ready || !result.loaded || !result.enabled)throw Object.assign(Error('Extension observation was interrupted by a reload or configuration change.'),{code:'extension_observation_interrupted'});
    }
    const errors = errorsOf(result);
    if (errors.length) throw Object.assign(Error(`Extension ${name} reported ${errors.length} diagnostic entries during ${phase}.`),{code:'extension_load_error',diagnostics:errors,reportPhase:phase,extensionName:name});
    return result;
  } catch(error) {
    error.extensionName ||= name;
    error.reportPhase ||= phase;
    if(protocol.length && !error.diagnostics)error.diagnostics=[...protocol];
    throw error;
  } finally { unsubscribe();await cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:observer.identifier}).catch(()=>{}); }
}
async function installNative(cdp, archive, name, destination, reload = false, observationSeconds = 0) {
  await job(cdp,page.importInPage,{base64:archive.bytes.toString('base64'),name});
  files.verifyFiles(destination,archive.files);
  await job(cdp,page.persistConfig,name);
  if (reload) await reloadAndVerify(cdp,name,true,observationSeconds);
  return {installed:true,persisted:true,loaded:reload,restartRequired:!reload};
}
async function stage(archive, source, options = {}) {
  const dir = path.join(ROOT, 'staging', crypto.randomUUID()); fs.mkdirSync(dir, {recursive:true});
  const name = 'ext-' + crypto.randomBytes(8).toString('hex');
  let cdp, success = false, phase='startup', extensionName=archive.name;
  try {
    const state = await session.start({session:name, source, browser:options.browser, ...(options.native ? {roomHost:{wsPort:0}} : {}), extensionOnly:true, importRoot:dir, importFiles:archive.files});
    ({cdp} = await session.connect(name));
    await setup.prepare(cdp, {extensions:[], nickname:'扩展验证'});
    const baseline = await setup.evaluate(cdp, page.loaded, null);
    phase='import';
    const imported = await job(cdp, page.importInPage, {base64:archive.bytes.toString('base64'), name:archive.name, token:state.token});
    extensionName=imported.name;
    if (!files.validName(imported.name)) fail('invalid_extension_name', 'Native importer returned an unsafe extension name.');
    phase='files';
    files.verifyFiles(path.join(dir, 'extension', imported.name), archive.files);
    phase='persist';
    await job(cdp, page.persistConfig, imported.name);
    phase='reload';
    const loaded = await reloadAndVerify(cdp,imported.name,false,options.observationSeconds || 0);
    const characterPacks = loaded.characterPacks.filter(p => !baseline.characterPacks.includes(p));
    const cardPacks = loaded.cardPacks.filter(p => !baseline.cardPacks.includes(p));
    for (const [option, result, available] of [['character-packs',characterPacks,loaded.characterPacks], ['card-packs',cardPacks,loaded.cardPacks]]) {
      for (const id of (options[option] || '').split(',').filter(Boolean)) {
        if (!available.includes(id)) fail('pack_not_loaded', `Requested ${option} pack was not loaded: ${id}`);
        if (!result.includes(id)) result.push(id);
      }
    }
    const entry = {name:imported.name, sha256:archive.sha256, files:archive.files, characterPacks, cardPacks, importedAt:new Date().toISOString(), verification:{nativeImport:true, files:true, persisted:true, reloaded:true}};
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(entry, null, 2));
    success = true;
    return {dir, entry};
  } catch(error) {
    error.reportPhase ||= phase;error.extensionName ||= extensionName;error.archiveSha256=archive.sha256;
    if(cdp && !error.diagnostics)try{error.diagnostics=await cdp.evaluate('[...(window.__oneshotDiagnostics||[]),...(window.__extensionLoadErrors||[])]');}catch{}
    throw error;
  } finally {
    cdp?.close();
    const stopped = await session.stop(name);
    if (stopped.cleanupComplete === false) { success = false; fail('import_cleanup_incomplete', `Installer ${name} could not stop; staging retained at ${dir}.`); }
    if (!success) removeStage(dir);
  }
}
async function importRoom(filename, options = {}) {
  return session.withLock('extension-library', async () => {
    const source = path.resolve(options.source || session.DEFAULT_SOURCE);
    const archive = files.inspectZip(filename, source);
    const prior = catalog();
    const existing = archive.name && prior.find(e => e.name.toLowerCase() === archive.name.toLowerCase());
    if (existing && !options.replace) fail('extension_exists', `${existing.name} already exists; use --replace to replace it for new rooms.`);
    const prepared = await stage(archive, source, options);
    try {
      const old = prior.find(e => e.name.toLowerCase() === prepared.entry.name.toLowerCase());
      if (old && !options.replace) fail('extension_exists', `${old.name} already exists; use --replace.`);
      const destination = path.join(ROOT, 'versions', archive.sha256);
      fs.mkdirSync(path.dirname(destination), {recursive:true});
      if (!fs.existsSync(destination)) fs.renameSync(prepared.dir, destination);
      else files.verifyFiles(path.join(destination, 'extension', prepared.entry.name), archive.files);
      const next = [...prior.filter(e => e !== old), prepared.entry];
      fs.writeFileSync(catalogPath()+'.tmp', JSON.stringify(next,null,2)); fs.renameSync(catalogPath()+'.tmp',catalogPath());
      return {ok:true, target:'room', name:prepared.entry.name, sha256:archive.sha256, characterPacks:prepared.entry.characterPacks, cardPacks:prepared.entry.cardPacks, loaded:true, appliesTo:'new_rooms', replaced:!!old};
    } finally { if (fs.existsSync(prepared.dir)) removeStage(prepared.dir); }
  });
}
async function importNative(filename, options = {}, native = require('./native-session.cjs')) {
  const name = options.session || 'default';
  if (session.read(name)?.room) fail('room_session_target','This session belongs to a room; use --target room or a different native session name.');
  return native.withLock(name, async () => {
    // Use the bound installation, never a different --source while attached.
    let state = native.read(name);
    const source = path.resolve(options.source || state?.source || session.DEFAULT_SOURCE);
    if (state?.source && path.resolve(state.source) !== source) fail('source_mismatch', '--source does not match the native session.');
    const archive = files.inspectZip(filename, source);
    const prepared = await stage(archive, source, {...options,native:true});
    let cdp, backup;
    try {
      if (!(await native.status(name)).running) await native.start({...options, session:name, source});
      ({cdp,state} = await native.connect(name));
      await setup.poll(cdp,({lib,game})=>({ready:!!game.layout && !!lib.config?.extensions}),null,'native import configuration');
      const ext = prepared.entry.name;
      const current = await setup.evaluate(cdp, ({lib}, name) => ({exists:lib.config.extensions.includes(name), config:Object.fromEntries(Object.entries(lib.config).filter(([key]) => key === 'extensions' || key.startsWith('extension_'+name+'_')))}), ext);
      const destination = path.join(source, 'extension', ext);
      const sourceRoot = fs.realpathSync(source);
      const parent = fs.realpathSync(path.dirname(destination));
      if (path.relative(sourceRoot, parent).startsWith('..') || (fs.existsSync(destination) && fs.realpathSync(destination) !== destination)) fail('unsafe_extension_destination', 'Extension destination uses a symlink or points outside the installation.');
      const exists = current.exists || fs.existsSync(destination);
      if (exists && !options.replace) fail('extension_exists', `${ext} is installed; use --replace to invoke native replacement.`);
      backup = path.join(ROOT, 'backups', crypto.randomUUID()); fs.mkdirSync(backup,{recursive:true});
      fs.writeFileSync(path.join(backup,'config.json'),JSON.stringify({source,name:ext,...current},null,2));
      if (fs.existsSync(destination)) fs.cpSync(destination,path.join(backup,'files'),{recursive:true});
      const installed = await installNative(cdp,archive,ext,destination,!!options.reload,options.observationSeconds || 0);
      const result = {ok:true,target:'native',name:ext,...installed,replaced:exists,backup};
      native.appendEvidence(name,{command:'extension_import',sha256:archive.sha256,...result});
      return result;
    } catch(error) {
      if (backup) { error.message += ` Native import may be partial; backup: ${backup}. Do not blindly retry.`; error.code ||= 'extension_import_partial'; }
      throw error;
    } finally { cdp?.close(); removeStage(prepared.dir); }
  });
}
async function reportedImport(filename, options = {}) {
  const observationSeconds=Number(options['observe-seconds'] || 0);
  if(!Number.isInteger(observationSeconds)||observationSeconds<0||observationSeconds>30)throw Error('--observe-seconds must be an integer from 0 to 30.');
  const context={zip:filename,target:options.target,observationSeconds,phase:'preflight'};
  try {
    const archive=files.inspectZip(filename);context.name=archive.name;context.sha256=archive.sha256;context.phase='import';
    return await (options.target==='native'?importNative:importRoom)(filename,{...options,observationSeconds});
  } catch(error) {
    try{error.details={...error.details,...reports.save(context,error)};}catch(reportError){error.details={...error.details,reportWriteError:reportError.message};}
    throw error;
  }
}
module.exports = {importRoom, importNative, reportedImport, installNative, reloadAndVerify, list, snapshot, stage, job, ROOT};
