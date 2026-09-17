'use strict';
const contentProfiles = require('./content-profile.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const problem = (code, message) => Object.assign(new Error(message), { code });
const evaluate = (cdp, fn, value) => cdp.evaluate(`(async()=>{if(document.readyState==='loading'||!Array.from(document.querySelectorAll('script[type="importmap"]')).some(s=>{try{return !!JSON.parse(s.textContent).imports?.vue}catch{return false}}))throw Error('room_page_loading');const m=await import('/noname.js');return (${fn.toString()})(m,${JSON.stringify(value ?? null)});})()`);
async function poll(cdp, fn, value, label, timeout = 45000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { last = await evaluate(cdp, fn, value); if (last?.ready) return last; }
    catch (error) { last = { error: error.message }; }
    await sleep(150);
  }
  throw problem('room_timeout', `${label}: ${JSON.stringify(last)}`);
}
async function prepare(cdp, { mode = 'doudizhu', nickname, extensions = [], characterPacks = [], cardPacks = [], timeout = 600 } = {}) {
  if (!['doudizhu', '2v2'].includes(mode)) throw problem('unsupported_room_mode', 'Local rooms support doudizhu or 2v2.');
  const content = contentProfiles.resolve({ extensions, characterPacks, cardPacks });
  await poll(cdp, ({ lib, game }) => ({ ready: !!(lib.db && game.layout && lib.config?.mode_config && game.promises?.saveConfig) }), null, 'room configuration');
  await evaluate(cdp, async ({ lib, game }, o) => {
    const save = (key, value, mode) => game.promises.saveConfig(key, value, mode);
    for (const ext of o.extensions) {
      if (/[\\/:\x00-\x1f]/.test(ext) || !(await fetch(`/extension/${encodeURIComponent(ext)}/extension.js`, { method: 'HEAD' })).ok) throw Error(`Extension unavailable: ${ext}`);
    }
    await save('extension_auto_import', false);
    await save('extensions', o.extensions);
    for (const ext of o.extensions) await save(`extension_${ext}_enable`, true);
    await save('characters', [...new Set(['standard', ...o.characterPacks])]);
    await save('cards', [...new Set(['standard', 'extra', ...o.cardPacks])]);
    await save('mode', 'connect');
    await save('directstartmode', undefined);
    await save('show_splash', 'off');
    await save('new_tutorial', true);
    await save('auto_confirm', false);
    await save('connect_nickname', o.nickname);
    await save('read_clipboard', false, 'connect');
    const mode = o.mode === '2v2' ? 'versus' : o.mode;
    await save('connect_mode', mode);
    await save('connect_choose_timeout', String(o.timeout), mode);
    await save(o.mode === '2v2' ? 'connect_versus_mode' : 'connect_doudizhu_mode', o.mode === '2v2' ? '2v2' : 'normal', mode);
    await save('continue_name', undefined);
    await save('reconnect_info', undefined);
    localStorage.setItem(lib.configprefix + 'directstart', 'true');
  }, { mode, nickname, ...content, timeout });
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(300);
  const ready = await poll(cdp, ({ lib, game, ui, get, _status }) => {
    const announcement = (ui.dialogs || []).find(d => d.isConnected && (d.textContent.includes(`${lib.version}更新内容`) || d.textContent.startsWith('扩展更新')));
    if (announcement && _status.event?.name === 'game') {
      const control = (ui.controls || []).find(n => n.isConnected && n.custom && n.firstChild?.textContent === '确定');
      control?.firstChild.click();
    }
    return { ready: lib.config.mode === 'connect' && !!_status.connectMode && !!ui.ipnode, mode: lib.config.mode, event: _status.event?.name, node: !!lib.node };
  }, null, 'connect menu');
  await evaluate(cdp, ({lib}, o) => {
    for (const name of o.extensions) if (!lib.extensionPack?.[name]) throw Error(`Extension failed to load: ${name}`);
    for (const id of o.characterPacks) if (!lib.connectCharacterPack.includes(id)) throw Error(`Character pack failed to load: ${id}`);
    for (const id of o.cardPacks) if (!lib.connectCardPack.includes(id)) throw Error(`Card pack failed to load: ${id}`);
  }, content);
  await evaluate(cdp, require('./room-play.cjs').installRoomPlay);
  return ready;
}
async function host(cdp, { mode = 'doudizhu', timeout = 600, characterPacks = [], cardPacks = [] } = {}) {
  await evaluate(cdp, ({ lib, game }, o) => {
    const allowed = ['standard', ...o.characterPacks];
    lib.config.connect_characters = lib.connectCharacterPack.filter(p => !allowed.includes(p));
    lib.config.connect_cards = lib.connectCardPack.filter(p => !['standard', 'extra', ...o.cardPacks].includes(p));
    game.switchMode(o.mode === '2v2' ? 'versus' : o.mode);
  }, { mode, characterPacks, cardPacks });
  return poll(cdp, ({ lib, game, _status }, o) => {
    if (_status.waitingForPlayer && window.__nonameRoomServer) {
      lib.configOL.choose_timeout = String(o.timeout);
      game.ip = `127.0.0.1:${window.__nonameRoomServer.options.port}`;
    }
    return { ready: !!_status.waitingForPlayer && !!window.__nonameRoomServer?._server?.listening, players: game.connectPlayers?.filter(p => p.playerid).map(p => p.playerid), config: lib.configOL, address: window.__nonameRoomServer?._server?.address(), error: window.__nonameRoomServerError };
  }, { timeout }, 'room server');
}
async function join(cdp, address) {
  await evaluate(cdp, ({ game }, address) => { game.connect(address); }, address);
  return poll(cdp, ({ game, _status }) => ({ ready: !!game.onlineID && !!_status.waitingForPlayer, onlineID: game.onlineID, online: !!game.online, waiting: !!_status.waitingForPlayer }), null, 'room join');
}
async function start(cdp) {
  return evaluate(cdp, ({ ui, _status }) => {
    if (!_status.waitingForPlayer || !ui.connectStartButton) throw Error('Room is not waiting for players.');
    ui.connectStartButton.click(); return { ok: true };
  });
}
async function status(cdp) {
  return evaluate(cdp, ({ game, lib, get, _status }) => ({ mode: lib.configOL?.mode || lib.config.mode, online: !!game.online, connected: game.online ? game.ws?.readyState === 1 : !!window.__nonameRoomServer?._server?.listening, waiting: !!_status.waitingForPlayer && !lib.configOL?.gameStarted, started: !!lib.configOL?.gameStarted, onlineID: game.onlineID || null, me: game.me?.playerid || null, peers: game.connectPlayers?.filter(p => p.playerid).map(p => ({ id: p.playerid, name: p.nickname })), players: (game.players || []).map(p => ({ id: p.playerid, name: p.name, me: p === game.me })), event: _status.event?.name, choosing: !!_status.imchoosing, auto: !!_status.auto, error: window.__nonameRoomServerError || null }));
}
module.exports = { prepare, host, join, start, status, evaluate, poll };
