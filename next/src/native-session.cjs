'use strict';
// Native-client lifecycle. No source/profile deletion and no browser-profile overrides.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { connectCDP } = require('./transport.cjs');
const { PAGE_HELPER, ENTRY_READY_EXPRESSION, bootstrapMain } = require('./native-bootstrap.cjs');
const installation = require('./installation.cjs');
const STATE_ROOT = path.resolve(__dirname, '..', 'state-native');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const problem = (code, message, details) => Object.assign(new Error(message), { code, details });
async function installNativePageHelper(cdp, session, { applyCurrent = true } = {}) {
  cdp.onEvent(event => {
    if (event.method !== 'Page.javascriptDialogOpening') return;
    const dialog = event.params;
    appendEvidence(session, { type: 'page.dialog', dialogType: dialog.type, message: dialog.message, automatic: dialog.type === 'alert' });
    if (dialog.type === 'alert') cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  // Register before navigating or enabling other renderer domains. This also
  // covers the index entry's service-worker-triggered self reloads.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPER });
  if (applyCurrent) await cdp.evaluate(PAGE_HELPER);
  await cdp.send('Page.enable');
}
function sessionDir(session = 'default') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(session) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(session)) throw problem('invalid_session', 'Invalid session name.');
  return path.join(STATE_ROOT, session);
}
function read(session = 'default') {
  try { return JSON.parse(fs.readFileSync(path.join(sessionDir(session), 'session.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function write(state) {
  const dir = sessionDir(state.session); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(file + '.tmp', file);
  return state;
}
function update(session, patch) {
  const state = read(session); if (!state) throw problem('session_absent', `No native session ${session}.`);
  return write({ ...state, ...patch, session: state.session });
}
function appendEvidence(session, record) {
  const dir = sessionDir(session); fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'evidence.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n');
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : null; }
}
function lockFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = { pid: process.pid, nonce: crypto.randomUUID() };
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx' });
      return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).nonce === owner.nonce) fs.unlinkSync(file); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let old; try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw problem('lock_unreadable', 'Native operation lock is unreadable.'); }
      if (alive(old.pid) !== false) throw problem('operation_busy', 'Another native-client operation is running.');
      fs.unlinkSync(file);
    }
  }
  throw problem('operation_busy', 'Could not acquire native-client lock.');
}
async function withLock(session, action) {
  const unlock = lockFile(path.join(sessionDir(session), 'operation.lock'));
  try { return await action(); } finally { unlock(); }
}
async function processes() {
  if (process.platform !== 'win32') throw problem('unsupported_platform', 'Native Electron lifecycle currently requires Windows.');
  const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Where-Object { $_.Name -match "noname|无名杀|electron" } | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress';
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 12000, encoding: 'utf8' });
  if (!stdout.trim()) return [];
  const result = JSON.parse(stdout); return Array.isArray(result) ? result : [result];
}
function matchingProcesses(rows, executable) {
  return rows.filter(row => row.ExecutablePath && path.resolve(row.ExecutablePath).toLowerCase() === path.resolve(executable).toLowerCase() && !/(?:^|\s)--type=/.test(row.CommandLine || ''));
}
function debugPort(row) {
  const value = /(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)/.exec(row.CommandLine || '')?.[1];
  return value && Number(value) > 0 && Number(value) < 65536 ? Number(value) : null;
}
function portBusy(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = value => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setTimeout(1000); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(true));
  });
}
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json();
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
function gamePage(pages) {
  return pages.find(p => p.type === 'page' && /^https?:\/\/(localhost|127\.0\.0\.1):8089\/index\.html(?:[?#]|$)/.test(p.url)) ||
    pages.find(p => p.type === 'page' && /^https?:\/\/(localhost|127\.0\.0\.1):8089\/(?:app\.html)?(?:[?#]|$)/.test(p.url));
}
async function waitFor(fn, ms, label) {
  const until = Date.now() + ms; let last;
  while (Date.now() < until) { try { const result = await fn(); if (result) return result; } catch (e) { last = e; } await sleep(200); }
  throw problem('native_timeout', `${label}${last ? ': ' + last.message : ''}`);
}
function createNativeSession(deps = {}) {
  const listProcesses = deps.processes || processes, fetchJSON = deps.json || json, dial = deps.connectCDP || connectCDP;
  const busy = deps.portBusy || portBusy, launch = deps.spawn || spawn;
  const bootstrap = deps.bootstrapMain || bootstrapMain;
  async function endpoint(state) {
    if (!state?.cdpPort || !state.browserWs) return false;
    try { return (await fetchJSON(`http://127.0.0.1:${state.cdpPort}/json/version`)).webSocketDebuggerUrl === state.browserWs; } catch { return false; }
  }
  async function doctor({ source, executable } = {}) {
    const explicitSource=source;
    source = installation.source(source); executable = installation.resolveExecutable(source, executable || (!explicitSource && installation.defaults().executable));
    const missing = [executable, path.join(source, 'noname.js')].filter(p => !fs.existsSync(p));
    const found = matchingProcesses(await listProcesses(), executable);
    return { ok: !missing.length && Number(process.versions.node.split('.')[0]) >= 22, runtime: 'native', source, executable, browser: executable, profile: path.join(source, 'Home', 'UserData'), missing, processes: found.map(p => ({ pid: p.ProcessId, cdpPort: debugPort(p) })), sourceAccess: 'read-only', storage: STATE_ROOT, errors: missing.map(p => `Missing ${p}`) };
  }
  async function status(session = 'default') {
    const state = read(session); if (!state) return { session, runtime: 'native', status: 'absent', running: false };
    if (state.cleanupComplete) return { ...state, running: false, cleanupRequired: false };
    const running = await endpoint(state);
    return { ...state, running, browserRunning: running, cleanupRequired: true, status: running ? 'running' : 'disconnected' };
  }
  async function connect(session = 'default') {
    const state = read(session);
    if (!state || state.cleanupComplete || !(await endpoint(state))) throw problem('native_disconnected', 'The recorded native-client connection is unavailable; run status.');
    const pages = await fetchJSON(`http://127.0.0.1:${state.cdpPort}/json/list`);
    const target = gamePage(pages);
    if (!target) throw problem('game_page_missing', 'Native client has no recognized local game page.');
    const cdp = await dial(target.webSocketDebuggerUrl);
    try { await installNativePageHelper(cdp, session); } catch (error) { cdp.close(); throw error; }
    return { cdp, state: { ...state, pageId: target.id, url: target.url } };
  }
  async function start({ session = 'default', source, executable, port = 9222, attach = false } = {}) {
    sessionDir(session);
    if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw problem('invalid_port', 'CDP port must be 1–65535.');
    port = Number(port);
    const unlock = lockFile(path.join(STATE_ROOT, 'native-installation.lock'));
    let state;
    try {
      const prior = await status(session);
      if (prior.running) return { ...prior, reused: true };
      // Recover only a launch we recorded, with the same PID, executable, port,
      // and creation time. Never reinterpret an unrelated existing client as owned.
      if (prior.status === 'disconnected' && prior.ownership === 'owned' && !prior.browserWs && prior.error) {
        const candidate = matchingProcesses(await listProcesses(), prior.executable).find(p => p.ProcessId === prior.pid && debugPort(p) === prior.cdpPort);
        const created = candidate && (/\/Date\((\d+)/.exec(String(candidate.CreationDate))?.[1] || Date.parse(candidate.CreationDate));
        const delta = Number(created) - Date.parse(prior.startedAt);
        if (candidate && Number.isFinite(delta) && delta >= -1000 && delta < 15000) {
          const info = await fetchJSON(`http://127.0.0.1:${prior.cdpPort}/json/version`);
          const target = gamePage(await fetchJSON(`http://127.0.0.1:${prior.cdpPort}/json/list`));
          if (info.webSocketDebuggerUrl && target) {
            const recovered = update(session, { browserWs: info.webSocketDebuggerUrl, pageId: target.id, url: target.url, status: 'running', error: null });
            appendEvidence(session, { type: 'native.launch.recovered', pid: prior.pid, ownership: 'owned', creationTimeVerified: true });
            return { ...recovered, recovered: true };
          }
        }
      }
      if (prior.cleanupRequired) throw problem('cleanup_required', 'Stop this native session before starting it again.');
      const check = await doctor({ source, executable });
      if (!check.ok) throw problem('native_prerequisite', check.errors.join('; '));
      const found = matchingProcesses(await listProcesses(), check.executable);
      if (found.length > 1) throw problem('multiple_native_clients', 'Multiple matching native clients exist; cannot establish ownership.');
      const existing = found[0];
      if (existing && !debugPort(existing)) throw problem('requires_debug_restart', 'The original client is already running without a CDP port. Close/restart it with --remote-debugging-port=9222 before attaching; this command does not close it.', { pid: existing.ProcessId });
      if (attach && !existing) throw problem('native_client_absent', 'No matching original client is running to attach to.');
      if (existing) port = debugPort(existing);
      // No two tool sessions may concurrently own/drive the same original profile.
      for (const entry of fs.readdirSync(STATE_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === session) continue;
        const other = read(entry.name);
        if (other && !other.cleanupComplete && path.resolve(other.executable).toLowerCase() === check.executable.toLowerCase()) throw problem('native_session_in_use', `Original client is already reserved by session ${entry.name}. Stop that session first.`);
      }
      const dir = sessionDir(session); fs.mkdirSync(dir, { recursive: true });
      state = { session, runtime: 'native', source: check.source, executable: check.executable, browser: check.executable, profile: check.profile, ownership: existing ? 'attached' : 'owned', pid: existing?.ProcessId, cdpPort: port, evidenceDirectory: dir, startedAt: new Date().toISOString(), status: 'starting', cleanupComplete: false };
      if (!existing) {
        if (await busy(8089)) throw problem('native_http_port_in_use', 'Port 8089 is in use. The original client cannot safely start another server.');
        if (await busy(port)) throw problem('cdp_port_in_use', `CDP port ${port} is already in use.`);
        const log = fs.openSync(path.join(dir, 'native-client.log'), 'a');
        let child;
        state.inspectorPort = await (deps.freePort || freePort)();
        try { child = launch(check.executable, [`--inspect-brk=127.0.0.1:${state.inspectorPort}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: path.dirname(check.executable), detached: true, windowsHide: false, stdio: ['ignore', log, log] }); }
        finally { fs.closeSync(log); }
        child.on('error', error => appendEvidence(session, { type: 'native.spawn.error', message: error.message })); child.unref();
        state.pid = child.pid; write(state);
        const boot = await bootstrap({ port: state.inspectorPort, connectCDP: dial, fetchJSON });
        state.bootstrap = boot; write(state);
        appendEvidence(session, { type: 'native.bootstrap', ...boot, sourceFilesChanged: false });
      }
      const info = await waitFor(() => fetchJSON(`http://127.0.0.1:${port}/json/version`), 30000, 'Native client CDP did not become ready');
      // Verify the port belongs to the original executable, not an unrelated browser.
      const owners = matchingProcesses(await listProcesses(), check.executable).filter(p => debugPort(p) === port);
      if (owners.length !== 1 || owners[0].ProcessId !== state.pid) throw problem('native_ownership_unverified', 'CDP process ownership could not be verified. Client left open.');
      state.browserWs = info.webSocketDebuggerUrl;
      if (!state.browserWs) throw problem('native_endpoint_invalid', 'Native client did not expose its browser endpoint.');
      write(state);
      const page = await waitFor(async () => gamePage(await fetchJSON(`http://127.0.0.1:${port}/json/list`)), 30000, 'Native client game page did not become ready');
      if (!existing) {
        const cdp = await dial(page.webSocketDebuggerUrl);
        try {
          await installNativePageHelper(cdp, session, { applyCurrent: false });
          // Guard in the same evaluation as import, so a navigation cannot
          // replace the document between a readiness check and module loading.
          await waitFor(() => cdp.evaluate(`(async()=>{if(!(${ENTRY_READY_EXPRESSION}))return false;try{const {lib,game}=await import("/noname.js");return !!(lib.config?.mode_config&&game.promises?.saveConfig)}catch{return false}})()`), 60000, 'Native index document/import map or game configuration did not load');
          appendEvidence(session, { type: 'native.document.ready', parserComplete: true, importMapVerified: true, url: page.url });
          appendEvidence(session, { type: 'native.entry', url: page.url, sourceFilesChanged: false });
        } finally { cdp.close(); }
      }
      state.pageId = page.id; state.url = page.url; state.status = 'running'; write(state);
      appendEvidence(session, { type: 'session.start', ownership: state.ownership, pid: state.pid, url: state.url, profile: state.profile });
      return state;
    } catch (error) {
      if (state?.pid) { state.status = 'startup_failed'; state.error = error.message; write(state); appendEvidence(session, { type: 'session.failure', code: error.code, message: error.message }); }
      throw error;
    } finally { unlock(); }
  }
  async function stop(session = 'default') {
    const unlock = lockFile(path.join(STATE_ROOT, 'native-installation.lock'));
    try {
      const state = read(session); if (!state) return { session, status: 'absent', running: false, ok: true };
      if (state.cleanupComplete) return { ...state, ok: true, running: false };
      if (state.ownership === 'attached') {
        state.status = 'detached'; state.cleanupComplete = true;
      } else if (state.ownership === 'owned') {
        if (await endpoint(state)) {
          let cdp;
          try { cdp = await dial(state.browserWs); await cdp.send('Browser.close'); } catch (error) { appendEvidence(session, { type: 'native.close.response', message: error.message }); } finally { cdp?.close(); }
          try { await waitFor(async () => !(await endpoint(state)) && !matchingProcesses(await listProcesses(), state.executable).some(p => p.ProcessId === state.pid), 10000, 'Original client exit is unconfirmed'); } catch {}
        }
        const remaining = matchingProcesses(await listProcesses(), state.executable).some(p => p.ProcessId === state.pid);
        state.cleanupComplete = !remaining && !(await endpoint(state));
        state.status = state.cleanupComplete ? 'stopped' : 'cleanup_incomplete';
      } else throw problem('invalid_ownership', 'Refusing to stop an unrecognized native session.');
      state.stoppedAt = new Date().toISOString(); write(state);
      appendEvidence(session, { type: 'session.stop', ownership: state.ownership, cleanupComplete: state.cleanupComplete, profilePreserved: true });
      return { ...state, ok: state.cleanupComplete, running: state.cleanupComplete ? false : null, profilePreserved: true, ...(!state.cleanupComplete ? { code: 'cleanup_incomplete', message: 'Original client exit is unconfirmed. No process was force-killed and no profile was removed.' } : {}) };
    } finally { unlock(); }
  }
  return { doctor, start, connect, status, stop, read, update, withLock, appendEvidence, sessionDir };
}
module.exports = { ...require('./runtime-monitor.cjs').lifecycle(createNativeSession(), 'native'), createNativeSession, matchingProcesses, debugPort, gamePage, PAGE_HELPER, installNativePageHelper };
Object.defineProperty(module.exports,'DEFAULT_SOURCE',{enumerable:true,get:()=>installation.defaults().source || ''});
Object.defineProperty(module.exports,'DEFAULT_EXE',{enumerable:true,get:()=>{const saved=installation.defaults();return saved.executable || (saved.source ? installation.resolveExecutable(saved.source) : '');}});
