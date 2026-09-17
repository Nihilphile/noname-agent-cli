'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Execute the production CLI and plan interpreter, with in-memory game and
// notification boundaries. No browser, filesystem state or host message is used.
function fixture({ bindingError, acknowledgeError, enableError, enabled = true } = {}) {
  const filename = path.resolve(__dirname, '../bin/noname.cjs');
  const originalRequire = createRequire(filename);
  const realDisplayConfig = originalRequire('../src/display-config.cjs');
  const events = [], emitted = [], acts = [], acks = [], enables = [], commits = [];
  const env = { exitCode: 0 };
  let locked = false, clicks = 0, cursor = 0, note = { enabled }, started = false;
  const game = { evidenceDirectory: 'memory', startedAt: 'fixture' };
  const binding = { schema: 1, host: 'codex-desktop', thread_id: '01a07d0a-a58a-7c00-bae4-8d8bf281d178' };
  const log = () => ({ epoch: 'game', from: cursor + 1, to: clicks + 1, entries: Array.from({ length: clicks + 1 }, (_, i) => ({ seq: i + 1, text: `log ${i + 1}` })).filter(row => row.seq > cursor) });
  const options = () => clicks === 0 ? [{ id: 'c1', kind: 'card', label: '杀' }] : clicks === 1 ? [{ id: 'p2', kind: 'target', player: 'p2', label: '对手' }] : [{ id: 'ok', kind: 'confirm', label: '确定' }];
  const snapshot = () => ({ state: clicks >= 3 ? 'running' : 'choice', revision: `game:${clicks}`, mode: 'doudizhu',
    log: log(), choice: clicks >= 3 ? null : { id: 'choice1', event: 'chooseToUse', prompt: '选择', constraints: {},
      context: { certainty: 'known', skill: null, actor: 'p1', sourceAction: null }, options: options() } });
  const cdp = { close() { events.push('close'); } };
  const session = {
    sessionDir: () => 'memory',
    async withLock(_name, work) { assert.equal(locked, false); locked = true; events.push('lock'); try { return await work(); } finally { locked = false; events.push('unlock'); } },
    async status() { events.push('session_status'); return { running: started }; },
    async start() { assert.equal(locked, true); events.push('start'); started = true; },
    async connect() { events.push('connect'); return { cdp, state: game }; },
    async stop() { events.push('stop'); started = false; return { ok: true }; },
    read() { return game; },
    async appendEvidence(_name, row) { events.push(`evidence:${row.command}`); },
  };
  const page = {
    async observe() { events.push('observe'); return snapshot(); },
    async act(_cdp, request) {
      assert.equal(locked, true); assert.equal(request.at, `game:${clicks}`);
      const action = options().find(o => o.id === request.id); assert.ok(action);
      events.push('act'); acts.push(request); clicks++;
      return { ok: true, action, state: snapshot() };
    },
    async effects() { return { epoch: 'game', actions: [] }; },
    async logs() { return log(); },
    async commitLogs(_cdp, value) { assert.equal(locked, true); events.push('commit'); cursor = value.to; commits.push(value); },
  };
  const notifications = {
    status() { events.push('notify_status'); return { enabled: note.enabled, status: note.enabled ? 'armed' : 'disabled' }; },
    read() { return note; },
    enable(dir, bound, state, snap, presentation) {
      assert.equal(locked, true); events.push('enable');
      if (enableError) throw Error(enableError);
      enables.push({ dir, bound, state, snap, presentation }); note = { enabled: true };
    },
    disable(_dir, reason) { assert.equal(locked, true); events.push(`disable:${reason || 'disabled'}`); note = { enabled: false }; return { enabled: false, status: reason || 'disabled' }; },
    acknowledge(dir, state, snap) {
      assert.equal(locked, true); events.push('acknowledge');
      if (acknowledgeError) throw Error(acknowledgeError);
      acks.push({ dir, state, snap });
    },
    ensureWorker(dir, name, client) { assert.equal(locked, true); events.push('ensureWorker'); return { enabled: note.enabled, status: 'armed', dir, name, client }; },
  };
  const adapter = { async resolveBinding(options) { events.push('resolveBinding'); if (bindingError) throw Object.assign(Error(bindingError), { code: 'invalid_delivery_target' }); return { ...binding, requested: options }; } };
  const fakeFs = { existsSync() { return false; }, writeFileSync() { events.push('writeIntent'); }, readFileSync() { throw Error('Unexpected filesystem read'); } };
  const requireFixture = name => {
    if (name === 'node:fs') return fakeFs;
    if (['../src/session.cjs', '../src/native-session.cjs'].includes(name)) return session;
    if (['../src/setup.cjs', '../src/native-setup.cjs'].includes(name)) return { async prepare() { events.push('prepare'); return { ok: true }; } };
    if (name === '../src/page.cjs') return page;
    if (name === '../src/notification.cjs') return notifications;
    if (name === '../src/codex-delivery.cjs') return adapter;
    if (name === '../src/display-config.cjs') return { ...realDisplayConfig, read: () => ({ logs: 'compact', state: 'auto' }) };
    return originalRequire(name);
  };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: requireFixture, process: env, Buffer, setTimeout, clearTimeout,
    console: { log(value) { events.push('print'); emitted.push(JSON.parse(value)); } } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { main: argv => module.exports.main([...argv, '--json']), events, emitted, acts, acks, enables, commits, process: env };
}

test('invalid notification destination prevents game start and any click', async () => {
  const f = fixture({ bindingError: 'bad UUID' });
  await assert.rejects(f.main(['start', '--mode', 'doudizhu', '--character', 'any_general', '--notify', 'codex-desktop', '--notify-thread', 'bad']), /bad UUID/);
  assert.ok(f.events.includes('resolveBinding'));
  for (const event of ['start', 'prepare', 'connect', 'act', 'enable']) assert.equal(f.events.includes(event), false);
  assert.equal(f.acts.length, 0); assert.equal(f.commits.length, 0);
});

test('notify on returns existing decision, pins passed destination and never consumes logs', async () => {
  const f = fixture({ enabled: false });
  await f.main(['notify', 'on', '--thread', 'chosen-thread', '--desktop-executable', 'C:\\desktop\\codex.exe']);
  assert.equal(f.enables.length, 1);
  assert.equal(f.enables[0].bound.requested.threadId, 'chosen-thread');
  assert.equal(f.enables[0].bound.requested.executablePath, 'C:\\desktop\\codex.exe');
  assert.equal(f.enables[0].snap.revision, 'game:0');
  assert.equal(f.emitted[0].state.choice.id, 'choice1');
  assert.equal(f.emitted[0].notification.enabled, true);
  assert.equal(f.acts.length, 0); assert.equal(f.commits.length, 0);
  assert.ok(f.events.indexOf('enable') < f.events.indexOf('ensureWorker'));
  assert.ok(f.events.indexOf('ensureWorker') < f.events.indexOf('unlock'));
  await f.main(['logs']);
  assert.deepEqual(f.emitted.at(-1).entries.map(r => r.seq), [1]);
});

test('notify status and off operate without connecting, starting game or resolving destination', async () => {
  const f = fixture();
  await f.main(['notify', 'status']);
  assert.equal(f.emitted[0].enabled, true);
  await f.main(['notify', 'off']);
  await f.main(['notify', 'status']);
  assert.equal(f.emitted.at(-1).enabled, false);
  for (const event of ['connect', 'resolveBinding', 'ensureWorker', 'act', 'start']) assert.equal(f.events.includes(event), false);
  assert.equal(f.commits.length, 0);
});
test('notify on and start persist explicit detailed notification preference, default remains brief', async () => {
  for (const detailed of [false,true]) {
    for (const args of [['notify','on'],['start','--mode','2v2','--character','any_general','--notify','codex-desktop']]) {
      const f=fixture({enabled:false});
      await f.main([...args,...(detailed?['--detail']:[])]);
      assert.equal(f.enables[0].presentation.detail,detailed);
    }
  }
});

test('act passes directly returned choice to acknowledgement and running result rearms worker', async () => {
  const f = fixture();
  for (const [id, revision] of [['c1', 'game:0'], ['p2', 'game:1'], ['ok', 'game:2']]) await f.main(['act', id, '--at', revision]);
  assert.equal(f.acks.length, 3);
  assert.deepEqual(f.acks.map(a => a.snap.state), ['choice', 'choice', 'running']);
  assert.deepEqual(f.acks.map(a => a.snap.revision), ['game:1', 'game:2', 'game:3']);
  assert.equal(f.events.filter(e => e === 'ensureWorker').length, 3);
  assert.equal(f.acts.length, 3); assert.equal(f.commits.length, 3);
});

test('entire plan executes under one lock and acknowledges only final feedback', async () => {
  const f = fixture();
  await f.main(['act', 'c1 > p2 > confirm', '--at', 'game:0']);
  assert.equal(f.acts.length, 3); assert.equal(f.acks.length, 1);
  assert.equal(f.acks[0].snap.state, 'running');
  assert.equal(f.events.filter(e => e === 'lock').length, 1);
  assert.equal(f.events.filter(e => e === 'ensureWorker').length, 1);
  assert.ok(f.events.lastIndexOf('act') < f.events.indexOf('acknowledge'));
  assert.ok(f.events.indexOf('ensureWorker') < f.events.indexOf('unlock'));
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.emitted[0].state.log.entries.map(r => r.seq), [1, 2, 3, 4]);
});

test('notification acknowledgement failure preserves successful action and log commit', async () => {
  const f = fixture({ acknowledgeError: 'notification store unavailable' });
  await f.main(['act', 'c1', '--at', 'game:0']);
  assert.equal(f.emitted[0].ok, true);
  assert.equal(f.emitted[0].notification.status, 'unavailable');
  assert.match(f.emitted[0].notification.error, /store unavailable/);
  assert.equal(f.process.exitCode, 0); assert.equal(f.acts.length, 1); assert.equal(f.commits.length, 1);
  assert.equal(f.events.includes('ensureWorker'), false);
});

test('start notification setup and restart feedback are under lock without log consumption', async () => {
  const f = fixture({ enabled: false });
  await f.main(['start', '--mode', 'doudizhu', '--character', 'arbitrary_general', '--notify', 'codex-desktop']);
  assert.ok(f.events.indexOf('resolveBinding') < f.events.indexOf('start'));
  assert.equal(f.enables.length, 1); assert.equal(f.acks.length, 0);
  assert.equal(f.enables[0].snap.revision, 'game:0'); assert.equal(f.commits.length, 0);
  await f.main(['restart', '--mode', '2v2', '--character', 'different_general']);
  assert.equal(f.enables.length, 1); assert.equal(f.acks.length, 1); assert.equal(f.commits.length, 0);
});

test('stop disables notification before observing or stopping the client', async () => {
  const f = fixture();
  await f.main(['stop']);
  assert.ok(f.events.indexOf('disable:stopped') < f.events.indexOf('connect'));
  assert.ok(f.events.indexOf('disable:stopped') < f.events.indexOf('stop'));
  assert.equal(f.acts.length, 0); assert.equal(f.commits.length, 0);
});

test('observe, wait and logs leave notification feedback and log cursor untouched', async () => {
  const f = fixture();
  for (const command of ['observe', 'wait', 'logs']) await f.main([command]);
  for (const result of f.emitted) assert.deepEqual((result.log || result).entries.map(r => r.seq), [1]);
  assert.equal(f.acks.length, 0); assert.equal(f.enables.length, 0); assert.equal(f.commits.length, 0);
  assert.equal(f.events.includes('ensureWorker'), false);
});
