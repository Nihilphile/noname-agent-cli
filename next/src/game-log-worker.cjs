'use strict';
const recorder = require('./game-log-recorder.cjs'), store = require('./game-log-store.cjs');
const { read, write, identity } = require('./runtime-monitor.cjs');
const page = require('./page.cjs');
const { connectCDP } = require('./transport.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
async function connect(state) {
  const base = `http://127.0.0.1:${state.cdpPort || state.port}`;
  const json = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (!r.ok) throw Error('CDP endpoint unavailable'); return r.json(); };
  if ((await json(base + '/json/version')).webSocketDebuggerUrl !== state.browserWs) throw Error('Session endpoint ownership changed');
  const target = (await json(base + '/json/list')).find(p => p.type === 'page' && p.id === state.pageId);
  if (!target) throw Error('Recorded game page is unavailable');
  return connectCDP(target.webSocketDebuggerUrl, { timeout: 2000 });
}
// Injectable transport and clock allow lifecycle tests without touching a profile.
async function run(api, name, token, { dial = connect, snapshot = page.journalSnapshot, pause = sleep } = {}) {
  const dir = api.sessionDir(name), initial = api.read(name);
  if (!initial) throw Error('Session absent');
  const owner = identity(initial), healthFile = recorder.workerFile(dir, token);
  const collector = recorder.createCollector(dir); let cdp, lastError = null;
  const valid = () => { const c = read(recorder.controlFile(dir)), s = api.read(name); return c?.token === token && c.identity === owner && s?.status === 'running' && !s.cleanupComplete && identity(s) === owner && alive(s.pid); };
  const active = () => valid() && read(recorder.controlFile(dir)).enabled;
  const health = status => write(healthFile, { status, heartbeat: new Date().toISOString(), error: lastError, game: collector.cursor ? store.gameId(collector.cursor.epoch) : null, to: collector.cursor?.to ?? null });
  const capture = async () => { const batch = await snapshot(cdp, collector.cursor || {}); if (!valid()) return; collector.accept(batch); lastError = null; health('recording'); };
  // Start from retained page history on each worker start. At most 2000 rows
  // replay; the archive identity removes duplicates and survives lost cursors.
  try {
    while (active()) {
      try { if (!cdp) { health('connecting'); cdp = await dial(api.read(name)); } await capture(); await pause(500); }
      catch (error) { lastError = error.message; health('degraded'); cdp?.close(); cdp = null; if (active()) await pause(1000); }
    }
    if (valid() && cdp) { try { await capture(); } catch (error) { lastError = '末次采集失败：' + error.message; } }
  } finally { cdp?.close(); health('stopped'); }
}
if (require.main === module) {
  const [name, client, token] = process.argv.slice(2);
  if (!['native', 'isolated'].includes(client) || !/^[0-9a-f-]{36}$/.test(token || '')) throw Error('Invalid recorder arguments');
  run(require(client === 'native' ? './native-session.cjs' : './session.cjs'), name, token).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { run, connect };
