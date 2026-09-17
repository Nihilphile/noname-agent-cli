'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createNativeSession, sessionDir, matchingProcesses, debugPort, gamePage } = require('../src/native-session.cjs');
function fixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-native-test-'));
  const source = path.join(root, 'resources', 'app'); fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'noname.js'), '');
  const executable = path.join(root, '无名杀.exe'); fs.writeFileSync(executable, '');
  const profile = path.join(source, 'Home', 'UserData'); fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, 'keep'), 'user data');
  const session = 'native-test-' + label + '-' + process.pid;
  t.after(() => { fs.rmSync(sessionDir(session), { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, executable, session, profile };
}
test('native discovery recognizes Chinese executable, ignores renderer and selects actual game', () => {
  const exe = path.resolve('无名杀.exe');
  assert.equal(matchingProcesses([{ ExecutablePath: exe, CommandLine: '无名杀.exe --remote-debugging-port=9333' }, { ExecutablePath: exe, CommandLine: '无名杀.exe --type=renderer' }], exe).length, 1);
  assert.equal(debugPort({ CommandLine: '无名杀.exe --remote-debugging-port=9333' }), 9333);
  assert.equal(gamePage([{ type: 'page', url: 'http://localhost:8089/app.html', id: 'app' }, { type: 'page', url: 'http://localhost:8089/index.html', id: 'game' }]).id, 'game');
  assert.equal(gamePage([{ type: 'page', url: 'https://evil.invalid/index.html' }]), undefined);
});
test('existing original client without CDP is never restarted or closed', async t => {
  const f = fixture(t, 'no-cdp'); let launched = false;
  const service = createNativeSession({ processes: async () => [{ ProcessId: 90, ExecutablePath: f.executable, CommandLine: '无名杀.exe' }], spawn: () => { launched = true; } });
  await assert.rejects(service.start(f), e => e.code === 'requires_debug_restart');
  assert.equal(launched, false); assert.equal(fs.readFileSync(path.join(f.profile, 'keep'), 'utf8'), 'user data');
});
test('attached original client stop only detaches and preserves profile', async t => {
  const f = fixture(t, 'attach'); let closes = 0;
  const row = { ProcessId: 91, ExecutablePath: f.executable, CommandLine: '无名杀.exe --remote-debugging-port=9333' };
  const service = createNativeSession({ processes: async () => [row], json: async url => url.endsWith('/version') ? { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/existing' } : [{ id: 'g', type: 'page', url: 'http://localhost:8089/index.html', webSocketDebuggerUrl: 'ws://page' }], connectCDP: async () => ({ send: async () => { closes++; }, close() {} }) });
  const state = await service.start(f); assert.equal(state.ownership, 'attached');
  const result = await service.stop(f.session); assert.equal(result.status, 'detached'); assert.equal(closes, 0);
  assert.equal(fs.readFileSync(path.join(f.profile, 'keep'), 'utf8'), 'user data');
});
test('owned client close checks endpoint identity and never removes original data', async t => {
  const f = fixture(t, 'owned'); let launched = false, open = false, args;
  const row = { ProcessId: 92, ExecutablePath: f.executable, CommandLine: '无名杀.exe --remote-debugging-port=9333' };
  const service = createNativeSession({ processes: async () => open ? [row] : [], portBusy: async () => false, bootstrapMain: async () => ({ installed: true }),
    spawn: (exe, flags, options) => { launched = true; open = true; args = { exe, flags, options }; return { pid: 92, on() {}, unref() {} }; },
    json: async url => { if (!open) throw new Error('closed'); return url.endsWith('/version') ? { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/owned' } : [{ id: 'g', type: 'page', url: 'http://localhost:8089/index.html', webSocketDebuggerUrl: 'ws://page' }]; },
    connectCDP: async () => ({ send: async method => { if (method === 'Browser.close') open = false; }, onEvent() {}, evaluate: async () => true, close() {} }) });
  const state = await service.start({ ...f, port: 9333 }); assert.equal(state.ownership, 'owned'); assert.equal(launched, true);
  assert.equal(args.flags.some(x => x.startsWith('--user-data-dir')), false); assert.equal(args.options.windowsHide, false);
  const result = await service.stop(f.session); assert.equal(result.ok, true); assert.equal(result.status, 'stopped');
  assert.equal(fs.readFileSync(path.join(f.profile, 'keep'), 'utf8'), 'user data');
});
test('occupied native HTTP port prevents launch', async t => {
  const f = fixture(t, 'busy'); let launched = false;
  const service = createNativeSession({ processes: async () => [], portBusy: async port => port === 8089, spawn: () => { launched = true; } });
  await assert.rejects(service.start(f), e => e.code === 'native_http_port_in_use'); assert.equal(launched, false);
});
test('changed browser UUID does not authorize closing another browser', async t => {
  const f = fixture(t, 'uuid'); let closeCalled = false;
  const service = createNativeSession({ processes: async () => [{ ProcessId: 93, ExecutablePath: f.executable, CommandLine: '无名杀.exe --remote-debugging-port=9333' }], json: async () => ({ webSocketDebuggerUrl: 'ws://different' }), connectCDP: async () => { closeCalled = true; } });
  fs.mkdirSync(sessionDir(f.session), { recursive: true }); fs.writeFileSync(path.join(sessionDir(f.session), 'session.json'), JSON.stringify({ ...f, pid: 93, ownership: 'owned', cdpPort: 9333, browserWs: 'ws://original', cleanupComplete: false }));
  const result = await service.stop(f.session); assert.equal(result.ok, false); assert.equal(closeCalled, false);
});
test('failed launch recovery verifies recorded PID and process creation time', async t => {
  const f = fixture(t, 'recover'); const now = Date.now();
  const row = { ProcessId: 94, ExecutablePath: f.executable, CommandLine: '无名杀.exe --remote-debugging-port=9333', CreationDate: `/Date(${now + 100})/` };
  const service = createNativeSession({ processes: async () => [row], json: async url => url.endsWith('/version') ? { webSocketDebuggerUrl: 'ws://recorded-child' } : [{ id: 'app', type: 'page', url: 'http://localhost:8089/app.html', webSocketDebuggerUrl: 'ws://page' }] });
  fs.mkdirSync(sessionDir(f.session), { recursive: true }); fs.writeFileSync(path.join(sessionDir(f.session), 'session.json'), JSON.stringify({ ...f, pid: 94, ownership: 'owned', cdpPort: 9333, startedAt: new Date(now).toISOString(), status: 'startup_failed', error: 'ownership check failed', cleanupComplete: false }));
  const recovered = await service.start(f); assert.equal(recovered.recovered, true); assert.equal(recovered.ownership, 'owned'); assert.equal(recovered.url, 'http://localhost:8089/app.html');
});
