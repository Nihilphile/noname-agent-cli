'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { read, write, identity } = require('./runtime-monitor.cjs');
const store = require('./game-log-store.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const controlFile = dir => path.join(dir, 'game-log-recorder.json');
const workerFile = (dir, token) => path.join(dir, 'game-log-recorder-' + token + '.json');
function status(dir) {
  const c = read(controlFile(dir)); if (!c) return { kind: 'watch', enabled: false, status: 'disabled' };
  const w = read(workerFile(dir, c.token)), running = alive(c.pid);
  return { kind: 'watch', enabled: !!c.enabled, status: !running ? c.enabled ? 'unavailable' : 'stopped' : !c.enabled ? w?.status === 'stopped' ? 'stopped' : 'stopping' : !w ? 'starting' : Date.now() - Date.parse(w.heartbeat) > 15000 ? 'unresponsive' : w.status,
    workerPid: c.pid, heartbeat: w?.heartbeat || null, game: w?.game || null, to: w?.to ?? null, error: w?.error || null };
}
function locked(dir, body) {
  fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'game-log-recorder.lock');
  if (fs.existsSync(file)) { if (alive(read(file)?.pid)) throw Error('战报记录器正在更新，请重试。'); fs.unlinkSync(file); }
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); return body(); }
  finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
async function enable(api, name, client) {
  const dir = api.sessionDir(name), state = api.read(name);
  if (!state || state.cleanupComplete || state.status !== 'running') throw Error('请先连接游戏，再开启观战记录。');
  locked(dir, () => {
    const old = read(controlFile(dir));
    if (old?.enabled && old.identity === identity(state) && alive(old.pid)) return;
    const token = crypto.randomUUID(), control = { enabled: true, token, identity: identity(state), session: name, client, pid: null };
    write(controlFile(dir), control);
    const log = fs.openSync(path.join(dir, 'game-log-recorder.log'), 'a'); let child;
    try { child = spawn(process.execPath, [path.join(__dirname, 'game-log-worker.cjs'), name, client, token], { detached: true, windowsHide: true, stdio: ['ignore', log, log] }); }
    finally { fs.closeSync(log); }
    child.on('error', () => {}); child.unref(); write(controlFile(dir), { ...control, pid: child.pid || null });
  });
  const until = Date.now() + 5000;
  while (Date.now() < until) { const value = status(dir); if (['recording', 'degraded', 'unavailable', 'stopped'].includes(value.status)) return value; await sleep(100); }
  return status(dir);
}
async function disable(dir) {
  const token = locked(dir, () => { const c = read(controlFile(dir)); if (c) write(controlFile(dir), { ...c, enabled: false }); return c?.token; });
  // Let the owning worker flush once before the caller closes the client.
  const until = Date.now() + 5000;
  while (token && Date.now() < until) { const s = status(dir); if (s.status === 'stopped' || read(controlFile(dir))?.token !== token) return s; await sleep(100); }
  return status(dir);
}
// A private cursor never acknowledges logs on behalf of play/act. Advance it
// only after the append succeeds; crashes can replay a batch, readers dedupe it.
function createCollector(dir, { append = store.append, cursor = null } = {}) {
  let checkpoint = cursor, previous = null;
  return {
    get cursor() { return checkpoint; },
    accept(snapshot) {
      const { log, meta } = snapshot || {};
      if (log?.source !== 'eventflow' || !log.epoch || !Number.isSafeInteger(log.to)) throw Error('实验日志尚未就绪。');
      const signature = JSON.stringify([log.epoch, log.to, meta, log.players, log.samplingErrors]);
      if (signature !== previous || log.entries.length) append(dir, log, meta);
      checkpoint = { epoch: log.epoch, to: log.to }; previous = signature;
      return checkpoint;
    },
  };
}
function format(value) { return `观战记录 ${value.status}${value.game ? ' | ' + value.game + ' | 已存至 ' + value.to : ''}${value.error ? '\n' + value.error : ''}\nlogs --all 查看整局实验战报；logs games 查看历史对局。`; }
module.exports = { enable, disable, status, controlFile, workerFile, createCollector, format };
