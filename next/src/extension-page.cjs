'use strict';
// Serialized into the game's page. Use the same ArrayBuffer importer as its menu.
async function importInPage({game, lib, _status}, o) {
  if (_status.reloading || _status.importingExtension) throw Error('An import or reload is already in progress.');
  const before = [...lib.config.extensions];
  const original = {createDir:game.promises.createDir, writeFile:game.promises.writeFile};
  let completed = false;
  delete game.importedPack;
  let descriptor;
  Object.defineProperty(game,'importedPack',{configurable:true,get:()=>descriptor,set:value=>{
    if (o.name && value?.name !== o.name) throw Error('Extension name changed between validation and native import.');
    descriptor=value;
  }});
  if (o.token) {
    game.promises.createDir = async directory => {
      const response = await fetch('/__oneshot/extension-mkdir?path='+encodeURIComponent(directory.replaceAll('\\','/')),{method:'POST',headers:{'x-oneshot-token':o.token}});
      if (!response.ok) throw Error(await response.text());
    };
    game.promises.writeFile = async (bytes, dir, filename) => {
      const response = await fetch('/__oneshot/extension-write?path=' + encodeURIComponent((dir + filename).replaceAll('\\','/')), {method:'POST', headers:{'x-oneshot-token':o.token}, body:bytes});
      if (!response.ok) throw Error(await response.text());
    };
  }
  try {
    const bytes = Uint8Array.from(atob(o.base64), c => c.charCodeAt(0));
    const result = await game.importExtension(bytes.buffer, () => { completed = true; });
    if (result === false || !completed) throw Error('Native ZIP import did not complete: ' + (globalThis.__oneshotDiagnostics || []).slice(-3).map(d=>d.message).join('\n'));
    const names = lib.config.extensions.filter(name => !before.includes(name));
    const name = o.name || (names.length === 1 ? names[0] : null);
    if (!name || !lib.config.extensions.includes(name) || lib.config[`extension_${name}_enable`] !== true) throw Error('Native import did not register/enable the expected extension.');
    return {name, completed:true};
  } finally {
    delete game.importedPack;
    game.promises.createDir = original.createDir; game.promises.writeFile = original.writeFile;
  }
}
async function persistConfig({lib, _status}, name) {
  if (_status.reloading) throw Error('Reload interrupted extension persistence.');
  const values = {extensions:lib.config.extensions, [`extension_${name}_enable`]:lib.config[`extension_${name}_enable`]};
  if (!values.extensions.includes(name) || values[`extension_${name}_enable`] !== true) throw Error('Extension registration is missing.');
  if (!lib.db) {
    const saved = JSON.parse(localStorage.getItem(lib.configprefix + 'config') || '{}');
    if (!saved.extensions?.includes(name) || saved[`extension_${name}_enable`] !== true) throw Error('Extension persistence readback failed.');
    return {persisted:true, backend:'localStorage'};
  }
  await new Promise((resolve, reject) => {
    const tx = lib.db.transaction(['config'], 'readwrite');
    tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(Error('Extension config transaction failed.'));
    for (const [key,value] of Object.entries(values)) tx.objectStore('config').put(value,key);
  });
  await new Promise((resolve, reject) => {
    const tx = lib.db.transaction(['config'], 'readonly'); let valid = true;
    tx.oncomplete = () => valid ? resolve() : reject(Error('Extension config readback failed.'));
    tx.onerror = tx.onabort = () => reject(Error('Extension config readback failed.'));
    for (const [key,value] of Object.entries(values)) { const r = tx.objectStore('config').get(key); r.onsuccess = () => { valid &&= JSON.stringify(r.result) === JSON.stringify(value); }; }
  });
  return {persisted:true, backend:'IndexedDB'};
}
function loaded({lib, game, ui, _status}, options) {
  const {name, marker, native = false} = typeof options === 'object' && options ? options : {name:options};
  if (marker && window.__extensionReloadMarker === marker) return {ready:false};
  const announcement = (ui.dialogs || []).find(d => d.isConnected && (d.textContent.includes(`${lib.version}更新内容`) || d.textContent.startsWith('扩展更新')));
  if (announcement && _status.event?.name === 'game') (ui.controls || []).find(n => n.isConnected && n.custom && n.firstChild?.textContent === '确定')?.firstChild.click();
  const diagnostics = [...(window.__oneshotDiagnostics || []), ...(window.__extensionLoadErrors || [])].filter(d => ['error','rejection','alert','console.error','console.log'].includes(d.type));
  return {ready:!!game.layout && (native ? !!ui.arena && !lib.init.start : !!_status.connectMode && !!ui.ipnode), loaded:!name || !!lib.extensionPack?.[name], name, enabled:!name || lib.config[`extension_${name}_enable`] === true, characterPacks:[...(lib.connectCharacterPack || [])], cardPacks:[...(lib.connectCardPack || [])], diagnostics};
}
module.exports = {importInPage, persistConfig, loaded};
