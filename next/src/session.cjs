'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { connectCDP } = require('./transport.cjs');

const installation = require('./installation.cjs');
const STATE_ROOT = path.resolve(__dirname, '..', 'state');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PAGE_HELPER = `
  if(!window.__oneshotDialogInstalled){
    window.__oneshotDialogInstalled=true;
    window.__oneshotDiagnostics=window.__oneshotDiagnostics||[];
    const record=(type,message)=>{window.__oneshotDiagnostics.push({type,message:String(message),at:Date.now()});if(window.__oneshotDiagnostics.length>100)window.__oneshotDiagnostics.shift();};
    const nativeConfirm=window.confirm.bind(window);
    window.alert=(message)=>{record('alert',message);console.warn('Game alert:',message);};
    window.confirm=(message)=>{if(String(message).includes('GPLv3')&&String(message).includes('无名杀')){record('confirm',String(message)+' [response=true]');return true;}record('confirm',message);return nativeConfirm(message);};
    window.addEventListener('error',event=>record('error',event.message));
    window.addEventListener('unhandledrejection',event=>record('rejection',event.reason?.stack||event.reason));
  }
`;
async function installPageHelper(cdp, session) {
  cdp.onEvent(event => {
    if (event.method === 'Page.javascriptDialogClosed') { cdp.dialog = null; return; }
    if (event.method !== 'Page.javascriptDialogOpening') return;
    const dialog = event.params;
    cdp.dialog = dialog;
    const accept = dialog.type === 'alert' || (dialog.type === 'confirm' && dialog.message.includes('GPLv3') && dialog.message.includes('无名杀'));
    appendEvidence(session, { type: 'page.dialog', dialogType: dialog.type, message: dialog.message, automatic: accept });
    if (accept) cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPER });
  if (!cdp.dialog) await cdp.evaluate(PAGE_HELPER);
}
function sessionDir(session = 'default') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(session) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(session)) throw new Error('Session name must be 1–64 letters, digits, underscores or hyphens, starting with a letter or digit; Windows reserved names are not allowed.');
  return path.join(STATE_ROOT, session);
}
function read(session = 'default') {
  const filename = path.join(sessionDir(session), 'session.json');
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Cannot read session state: ${error.message}`); }
}
function writeState(state) {
  const filename = path.join(sessionDir(state.session), 'session.json');
  const temporary = filename + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2)); fs.renameSync(temporary, filename);
}
function update(session, patch) {
  const state = read(session);
  if (!state) throw new Error(`Session ${session} does not exist.`);
  const updated = { ...state, ...patch, session: state.session };
  writeState(updated); return updated;
}
async function withLock(session, action) {
  const unlock = lock(session, 'operation.lock');
  try { return await action(); } finally { unlock(); }
}
function appendEvidence(session, record) {
  const dir = sessionDir(session); fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'evidence.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n');
}
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}
function lock(session, lockName = 'lifecycle.lock') {
  const dir = sessionDir(session); fs.mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, lockName);
  const owner = { pid: process.pid, nonce: crypto.randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(filename, JSON.stringify(owner), { flag: 'wx' }); return () => { try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).nonce === owner.nonce) fs.unlinkSync(filename); } catch {} }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let old; try { old = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('Session lifecycle lock is unreadable. Check that no start/stop command is running before removing lifecycle.lock.'); }
      if (isAlive(old.pid) !== false) throw new Error('Another start/stop command is running for this session. Retry when it completes.');
      fs.unlinkSync(filename);
    }
  }
  throw new Error('Could not acquire session lifecycle lock.');
}
function browserPath(explicit) {
  const candidates = [explicit, installation.defaults().browser,
    ...[process.env['ProgramFiles(x86)'],process.env.ProgramFiles].filter(Boolean).flatMap(root=>[path.join(root,'Microsoft/Edge/Application/msedge.exe'),path.join(root,'Google/Chrome/Application/chrome.exe')]),
    ...(process.env.LOCALAPPDATA?[path.join(process.env.LOCALAPPDATA,'Microsoft/Edge/Application/msedge.exe'),path.join(process.env.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe')]:[])].filter(Boolean);
  if (explicit) return fs.existsSync(explicit) ? path.resolve(explicit) : null;
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}
async function doctor({ source, browser } = {}) {
  const resolved = installation.source(source);
  const missing = ['index.html', 'noname.js', 'service-worker.js'].filter(file => !fs.existsSync(path.join(resolved, file)));
  const executable = browserPath(browser);
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8')).version; } catch {}
  let gameVersion = null;
  try { gameVersion = fs.readFileSync(path.join(resolved, 'game', 'update.js'), 'utf8').match(/version:\s*["']([^"']+)/)?.[1] || null; } catch {}
  return { ok: Number(process.versions.node.split('.')[0]) >= 22 && missing.length === 0 && Boolean(executable), node: process.version, source: resolved, version: gameVersion, packageVersion: version, browser: executable, missing, sourceAccess: 'read-only', storage: STATE_ROOT, errors: [...(missing.length ? [`Game source is missing ${missing.join(', ')}. Pass --source with the resources/app directory.`] : []), ...(!executable ? ['Edge or Chromium was not found. Pass --browser with its executable path.'] : [])] };
}
async function fetchJSON(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}
async function waitFor(action, timeout, description) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await action(); if (result) return result; } catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`${description}${last ? ': ' + last.message : ''}`);
}
async function ownedBrowser(state) {
  if (!state?.browserWs || !state.cdpPort) return false;
  try { const info = await fetchJSON(`http://127.0.0.1:${state.cdpPort}/json/version`); return info.webSocketDebuggerUrl === state.browserWs; } catch { return false; }
}
async function resources(state) {
  let browserEndpoint = 'unavailable', serverEndpoint = 'unavailable';
  if (state.browserWs && state.cdpPort) {
    try {
      const info = await fetchJSON(`http://127.0.0.1:${state.cdpPort}/json/version`);
      browserEndpoint = info.webSocketDebuggerUrl === state.browserWs ? 'owned' : 'different';
    } catch {}
  }
  if (state.httpPort && state.token) {
    try {
      const info = await fetchJSON(`http://127.0.0.1:${state.httpPort}/__oneshot/health`, { headers: { 'x-oneshot-token': state.token } });
      serverEndpoint = info.pid === state.serverPid ? 'owned' : 'different';
    } catch {}
  }
  // A failed probe is not proof of process exit. PID checks are used only to
  // retain resources conservatively, never to select a process to terminate.
  const browserProcessAlive = isAlive(state.pid), serverProcessAlive = isAlive(state.serverPid);
  return {
    browserEndpoint, serverEndpoint, browserProcessAlive, serverProcessAlive,
    browserExited: browserEndpoint !== 'owned' && (browserProcessAlive === false || state.browserLaunched === false),
    serverExited: serverEndpoint !== 'owned' && (serverProcessAlive === false || state.serverLaunched === false),
  };
}
async function status(session = 'default') {
  const state = read(session);
  if (!state) return { session, status: 'absent', running: false };
  if (state.cleanupComplete === true) return { ...state, running: false, browserRunning: false, serverRunning: false, cleanupRequired: false };
  const resourceState = await resources(state);
  const browserRunning = resourceState.browserEndpoint === 'owned';
  const serverRunning = resourceState.serverEndpoint === 'owned';
  return { ...state, running: browserRunning && serverRunning, browserRunning, serverRunning, resourceState, cleanupRequired: true, status: browserRunning && serverRunning ? 'running' : state.status === 'cleanup_incomplete' ? 'cleanup_incomplete' : 'disconnected', ...(!browserRunning || !serverRunning ? { recovery: 'Run stop to retry owned-resource cleanup. If its connection remains unavailable, close the isolated client and retry stop. Do not start again until cleanup completes.' } : {}) };
}
async function connect(session = 'default') {
  const state = read(session);
  if (state?.status === 'cleanup_incomplete') throw new Error(`Session ${session} cleanup is incomplete. Retry stop successfully before starting or restarting it.`);
  if (!state || !(await ownedBrowser(state))) throw new Error(`Session ${session} is not connected. Run status, then start or restart it.`);
  const pages = await fetchJSON(`http://127.0.0.1:${state.cdpPort}/json/list`);
  const target = pages.find(page => page.type === 'page' && page.url.startsWith(state.url)) || pages.find(page => page.type === 'page' && page.id === state.pageId);
  if (!target) throw new Error('The session game page was closed. Stop and start the session again.');
  const cdp = await connectCDP(target.webSocketDebuggerUrl);
  try {
    await installPageHelper(cdp, session);
    if (state.room) {
      const source = `window.__nonameRoomBinding=${JSON.stringify(state.room)};`;
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
      await cdp.evaluate(source);
    }
  } catch (error) { cdp.close(); throw error; }
  return { cdp, state };
}
async function shutdown(state, children = {}) {
  delete state.cleanupWarning;
  if (state.cleanupComplete === true) return true;
  const warnings = [];
  let found = await resources(state);
  let browserCloseRequested = false, serverCloseRequested = false;
  if (found.browserEndpoint === 'owned') {
    let cdp;
    try {
      cdp = await connectCDP(state.browserWs, { timeout: 3000 });
      browserCloseRequested = true;
      await cdp.send('Browser.close');
    } catch {} finally { cdp?.close(); }
  } else if (!found.browserExited && children.browser?.pid && children.browser.exitCode == null && children.browser.signalCode == null) {
    // Only a ChildProcess created by this still-running start invocation is
    // eligible for fallback termination. Persisted PIDs never authorize kill.
    try { browserCloseRequested = children.browser.kill(); } catch {}
  }
  if (found.serverEndpoint === 'owned') {
    try {
      const response = await fetch(`http://127.0.0.1:${state.httpPort}/__oneshot/stop`, { method: 'POST', headers: { 'x-oneshot-token': state.token }, signal: AbortSignal.timeout(2000) });
      serverCloseRequested = response.ok;
    } catch {}
  } else if (!found.serverExited && children.server?.pid && children.server.exitCode == null && children.server.signalCode == null) {
    try { serverCloseRequested = children.server.kill(); } catch {}
  }
  if (browserCloseRequested || serverCloseRequested) {
    try {
      await waitFor(async () => {
        found = await resources(state);
        return (!browserCloseRequested || found.browserExited) && (!serverCloseRequested || found.serverExited);
      }, 7000, 'Requested processes have not confirmed exit');
    } catch (error) { warnings.push(error.message); }
  }
  found = await resources(state);
  state.resourceState = found;
  if (!found.browserExited) warnings.push(`Isolated browser exit is unconfirmed (endpoint=${found.browserEndpoint}, processAlive=${found.browserProcessAlive}).`);
  if (!found.serverExited) warnings.push(`Owned server exit is unconfirmed (endpoint=${found.serverEndpoint}, processAlive=${found.serverProcessAlive}).`);
  if (warnings.length) {
    state.cleanupComplete = false;
    state.cleanupWarning = `Cleanup incomplete; profile retained. ${warnings.join(' ')} Retry stop after the isolated client exits or its connection recovers.`;
    return false;
  }
  // Profiles live exclusively below this tool's session directory. Never remove
  // a user-supplied path or any path read from an editable state file.
  const profile = path.join(sessionDir(state.session), 'profile');
  try {
    await waitFor(() => { fs.rmSync(profile, { recursive: true, force: true }); return true; }, 10000, 'Profile is still in use');
  } catch (error) { state.cleanupComplete = false; state.cleanupWarning = `Cleanup incomplete: profile cleanup failed: ${error.message}. Retry stop after the client exits.`; return false; }
  state.cleanupComplete = true;
  return true;
}
async function stop(session = 'default') {
  const unlock = lock(session);
  try {
    const state = read(session);
    if (!state) return { session, status: 'absent', running: false };
    const complete = await shutdown(state);
    state.status = complete ? 'stopped' : 'cleanup_incomplete';
    if (complete) state.stoppedAt = new Date().toISOString();
    writeState(state);
    appendEvidence(session, { type: 'session.stop', cleanupComplete: complete, cleanupWarning: state.cleanupWarning || null });
    return { session, ok: complete, status: state.status, running: complete ? false : null, cleanupComplete: complete, evidenceDirectory: state.evidenceDirectory, ...(!complete ? { code: 'cleanup_incomplete', message: state.cleanupWarning, cleanupWarning: state.cleanupWarning, resourceState: state.resourceState } : {}) };
  } finally { unlock(); }
}
async function start({ session = 'default', source, browser, visible = false, roomHost, room, contentProfile = {}, extensionBundle = [], extensionOnly = false, importRoot, importFiles } = {}) {
  source = installation.source(source);
  const unlock = lock(session); let state;
  const children = {};
  try {
    const previous = await status(session);
    if (previous.running) return { ...previous, reused: true };
    if (previous.status !== 'absent' && previous.cleanupRequired) throw new Error('Session cleanup is incomplete or unconfirmed. Run stop successfully before starting it again.');
    if (roomHost) browser = require('./room-runtime.cjs').prepareRuntime(source);
    const prerequisites = await doctor({ source, browser });
    if (!prerequisites.ok) throw new Error(prerequisites.errors.join(' ') || 'Node.js 22 or newer is required.');
    const dir = sessionDir(session); const profile = path.join(dir, 'profile');
    fs.mkdirSync(profile, { recursive: true });
    const readyFile = path.join(dir, 'server-ready.json');
    fs.rmSync(readyFile, { force: true });
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    const token = crypto.randomBytes(32).toString('hex');
    const serverOptions = path.join(dir, 'server-options.json');
    fs.writeFileSync(serverOptions, JSON.stringify({roomProfile:!!room, contentProfile, extensionBundle, extensionOnly, importRoot, importFiles}));
    const serverLog = fs.openSync(path.join(dir, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(__dirname, 'server.cjs'), prerequisites.source, readyFile, token, serverOptions], { detached: true, windowsHide: true, stdio: ['ignore', serverLog, serverLog] });
    children.server = server;
    server.on('error', () => {}); server.unref(); fs.closeSync(serverLog);
    state = { session, source: prerequisites.source, browser: prerequisites.browser, profile, token, serverPid: server.pid, serverLaunched: Boolean(server.pid), browserLaunched: false, evidenceDirectory: dir, startedAt: new Date().toISOString(), status: 'starting', cleanupComplete: false, ...(room ? { room } : {}) };
    writeState(state);
    const ready = await waitFor(() => JSON.parse(fs.readFileSync(readyFile, 'utf8')), 10000, 'Read-only game server failed to start; inspect server.log');
    state.httpPort = ready.port; state.url = `http://127.0.0.1:${ready.port}/`;
    writeState(state);
    const browserLog = fs.openSync(path.join(dir, 'browser.log'), 'a');
    const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-features=msEdgeSidebarV2', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required', '--window-size=1440,1000', ...(visible ? ['--app=about:blank'] : ['--headless=new', 'about:blank'])];
    const env = roomHost ? { ...process.env, NONAME_ROOM_HOST: JSON.stringify({ source: prerequisites.source, profile, visible, wsPort: roomHost.wsPort, extensionBundle, importRoot }) } : process.env;
    const client = spawn(prerequisites.browser, args, { detached: true, windowsHide: !visible, env, stdio: ['ignore', browserLog, browserLog] });
    children.browser = client;
    client.on('error', () => {}); client.unref(); fs.closeSync(browserLog); state.pid = client.pid; state.browserLaunched = Boolean(client.pid); writeState(state);
    const portInfo = await waitFor(() => { const lines = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/); return lines.length === 2 ? lines : null; }, 20000, 'Client failed to expose its connection; inspect browser.log');
    state.cdpPort = Number(portInfo[0]); state.browserWs = `ws://127.0.0.1:${state.cdpPort}${portInfo[1]}`; writeState(state);
    const page = await waitFor(async () => (await fetchJSON(`http://127.0.0.1:${state.cdpPort}/json/list`)).find(item => item.type === 'page'), 10000, 'Client has no page');
    state.pageId = page.id; writeState(state);
    const cdp = await connectCDP(page.webSocketDebuggerUrl);
    try {
      cdp.onEvent(event => {
        if (event.method === 'Runtime.exceptionThrown') appendEvidence(session, { type: 'startup.exception', message: String(event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || '').slice(0,4000) });
        if (event.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(event.params?.type)) appendEvidence(session, { type: 'startup.console', level: event.params.type, message: (event.params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0,4000) });
      });
      await cdp.send('Runtime.enable');
      await installPageHelper(cdp, session);
      await cdp.send('Page.navigate', { url: state.url });
      await waitFor(async () => cdp.evaluate('(async()=>{if(document.readyState==="loading" || !Array.from(document.querySelectorAll("script[type=importmap]")).some(s=>{try{return !!JSON.parse(s.textContent).imports?.vue}catch{return false}}))return false;try { const m=await import("/noname.js"); return !!(m.game&&m.lib?.config&&m.ui); }catch(e){return false;}})()'), 60000, 'Game configuration did not become available; inspect browser.log and run doctor');
    } finally { cdp.close(); }
    state.status = 'running'; writeState(state);
    appendEvidence(session, { type: 'session.start', source: state.source, browser: state.browser, url: state.url, version: prerequisites.version });
    return state;
  } catch (error) {
    if (state) {
      let complete = false;
      try { complete = await shutdown(state, children); }
      catch (cleanupError) { state.cleanupComplete = false; state.cleanupWarning = `Cleanup incomplete: ${cleanupError.message}. Retry stop.`; }
      state.status = complete ? 'failed' : 'cleanup_incomplete'; state.error = error.message; writeState(state);
      appendEvidence(session, { type: 'session.failure', error: error.message, cleanupComplete: complete, cleanupWarning: state.cleanupWarning || null });
      if (!complete) error.message += ` ${state.cleanupWarning}`;
    }
    throw error;
  } finally { unlock(); }
}

module.exports = require('./runtime-monitor.cjs').lifecycle({ doctor, start, connect, status, stop, read, update, withLock, appendEvidence, sessionDir }, 'isolated');
Object.defineProperty(module.exports,'DEFAULT_SOURCE',{enumerable:true,get:()=>installation.source()});
