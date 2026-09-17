'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ browser = 'unavailable', browserAlive = true, server = 'unavailable', serverAlive = false, missingPid = false } = {}) {
  const filename = path.resolve(__dirname, '../src/session.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const operations = [], files = new Map();
  const state = { session: 'mock-cleanup', pid: missingPid ? undefined : 101, serverPid: 202, cdpPort: 9991, httpPort: 9992, token: 'owned-token', browserWs: 'ws://127.0.0.1:9991/devtools/browser/owned', status: 'running', evidenceDirectory: 'mock-evidence' };
  const stateFile = path.resolve(__dirname, '../state/mock-cleanup/session.json');
  files.set(stateFile, JSON.stringify(state));
  const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const fakeFS = {
    mkdirSync() {},
    readFileSync(file) { if (!files.has(file)) throw enoent(); return files.get(file); },
    writeFileSync(file, value, options) { if (options?.flag === 'wx' && files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); files.set(file, value); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(file) { files.delete(file); },
    appendFileSync(file, value) { operations.push({ type: 'evidence', record: JSON.parse(value) }); },
    rmSync(file) { operations.push({ type: 'remove', file }); },
  };
  const fakeProcess = { ...process, kill(pid, signal) {
    operations.push({ type: 'pid-check', pid, signal });
    assert.equal(signal, 0, 'persisted PIDs must never be killed');
    const alive = pid === 101 ? browserAlive : pid === 202 ? serverAlive : pid === process.pid;
    if (alive === 'unknown') throw Object.assign(new Error('denied'), { code: 'EPERM' });
    if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  } };
  const fetch = async (url, options = {}) => {
    operations.push({ type: 'fetch', url, method: options.method || 'GET' });
    if (url.endsWith('/json/version')) {
      if (browser === 'unavailable') throw new Error('connection refused');
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: browser === 'owned' ? state.browserWs : 'ws://another-browser' }) };
    }
    if (url.endsWith('/health')) {
      if (server === 'unavailable') throw new Error('connection refused');
      return { ok: true, json: async () => ({ pid: server === 'owned' ? 202 : 303 }) };
    }
    if (url.endsWith('/stop')) {
      assert.equal(server, 'owned', 'never stop an unverified server');
      server = 'unavailable'; serverAlive = false;
      return { ok: true };
    }
    throw new Error('Unexpected request');
  };
  const connectCDP = async url => {
    assert.equal(browser, 'owned', 'never connect to another browser');
    assert.equal(url, state.browserWs);
    return { async send(method) { operations.push({ type: 'cdp', method }); browser = 'unavailable'; browserAlive = false; }, close() {} };
  };
  const module = { exports: {} };
  vm.runInNewContext(source + '\nmodule.exports.testShutdown = shutdown;', {
    module, exports: module.exports, __dirname: path.dirname(filename), process: fakeProcess,
    require: name => name === 'node:fs' ? fakeFS : name === './transport.cjs' ? { connectCDP } : name === './installation.cjs' ? {source:v=>v || 'test-game'} : name === './runtime-monitor.cjs' ? { lifecycle: api => api } : require(name),
    fetch, AbortSignal, Date, setTimeout,
  });
  return { api: module.exports, state, operations, saved: () => JSON.parse(files.get(stateFile)), exited() { browserAlive = false; browser = 'unavailable'; } };
}

test('unreachable live browser retains profile, reports incomplete, and blocks start', async () => {
  const f = fixture();
  const stopped = await f.api.stop('mock-cleanup');
  assert.equal(stopped.ok, false);
  assert.equal(stopped.status, 'cleanup_incomplete');
  assert.equal(stopped.running, null);
  assert.equal(f.saved().cleanupComplete, false);
  assert.equal(f.operations.some(x => x.type === 'remove' || x.type === 'cdp'), false);
  const status = await f.api.status('mock-cleanup');
  assert.equal(status.cleanupRequired, true);
  assert.equal(status.resourceState.browserProcessAlive, true);
  await assert.rejects(f.api.start({ session: 'mock-cleanup' }), /cleanup is incomplete/);
  await assert.rejects(f.api.connect('mock-cleanup'), /cleanup is incomplete/);
});

test('unreachable exited processes permit profile cleanup and report stopped', async () => {
  const f = fixture({ browserAlive: false });
  const result = await f.api.stop('mock-cleanup');
  assert.equal(result.ok, true); assert.equal(result.status, 'stopped');
  assert.equal(f.operations.filter(x => x.type === 'remove').length, 1);
  assert.equal((await f.api.status('mock-cleanup')).cleanupRequired, false);
});

test('replaced endpoints receive no close command and live PIDs retain profile', async () => {
  const f = fixture({ browser: 'different', server: 'different', serverAlive: true });
  const result = await f.api.stop('mock-cleanup');
  assert.equal(result.code, 'cleanup_incomplete');
  assert.equal(result.resourceState.browserEndpoint, 'different');
  assert.equal(f.operations.some(x => x.type === 'cdp' || x.type === 'remove' || x.method === 'POST'), false);
});

test('replaced endpoint is untouched when original processes are confirmed exited', async () => {
  const f = fixture({ browser: 'different', browserAlive: false });
  assert.equal((await f.api.stop('mock-cleanup')).ok, true);
  assert.equal(f.operations.some(x => x.type === 'cdp' || x.method === 'POST'), false);
});

test('normal cleanup closes only verified browser and token-authenticated server', async () => {
  const f = fixture({ browser: 'owned', server: 'owned', serverAlive: true });
  const result = await f.api.stop('mock-cleanup');
  assert.equal(result.ok, true);
  assert.equal(f.operations.filter(x => x.type === 'cdp' && x.method === 'Browser.close').length, 1);
  assert.equal(f.operations.filter(x => x.method === 'POST').length, 1);
  assert.equal(f.operations.filter(x => x.type === 'remove').length, 1);
});

test('unknown PID state and missing PID cannot authorize deletion', async () => {
  for (const input of [{ browserAlive: 'unknown' }, { missingPid: true }]) {
    const f = fixture(input);
    assert.equal((await f.api.stop('mock-cleanup')).ok, false);
    assert.equal(f.operations.some(x => x.type === 'remove'), false);
  }
});

test('cleanup can be retried after isolated process exits', async () => {
  const f = fixture();
  assert.equal((await f.api.stop('mock-cleanup')).ok, false);
  f.exited();
  assert.equal((await f.api.stop('mock-cleanup')).ok, true);
  assert.equal(f.saved().cleanupWarning, undefined);
});

test('startup fallback may terminate its own live ChildProcess handle', async () => {
  const f = fixture();
  let killed = false;
  const child = { pid: 101, exitCode: null, signalCode: null, kill() { killed = true; f.exited(); return true; } };
  assert.equal(await f.api.testShutdown(f.state, { browser: child }), true);
  assert.equal(killed, true);
  assert.equal(f.operations.filter(x => x.type === 'remove').length, 1);
});

test('already exited child handle never authorizes a PID-reuse kill', async () => {
  const f = fixture();
  const child = { pid: 101, exitCode: 0, signalCode: null, kill() { assert.fail('must not kill exited handle'); } };
  assert.equal(await f.api.testShutdown(f.state, { browser: child }), false);
});
