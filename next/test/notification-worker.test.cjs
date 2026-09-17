'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const notifications = require('../src/notification.cjs');

const running = { state: 'running', revision: 'epoch:1' };
const choice = id => ({ state: 'choice', revision: `epoch:${id}`, choice: {
  id: 'reused-event', decisionId: id, event: 'chooseToUse', options: [{ id: 'c1', kind: 'card', label: '杀' }],
} });
function fixture(t, hooks = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-notify-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { startedAt: 'test', browserWs: 'ws://mock', pid: 123 };
  notifications.enable(dir, { thread_id: 'receiver' }, state, running);
  notifications.write(dir, { ...notifications.read(dir), workerPid: process.pid });
  const calls = { connect: 0, close: 0, observe: 0, submit: 0, lock: 0, sleeps: [], evidence: [] };
  const f = { dir, state, calls };
  const cdp = { close() { calls.close++; } };
  const session = {
    sessionDir: () => dir, read: () => state,
    connect: async () => { calls.connect++; return { cdp }; },
    withLock: async (name, fn) => { calls.lock++; if (hooks.lock) await hooks.lock(f); return fn(); },
    appendEvidence: (name, record) => calls.evidence.push(record),
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/notify-worker.cjs'), 'utf8');
  const mockRequire = name => {
    if (name === './notification.cjs') return notifications;
    if (name === './native-session.cjs' || name === './session.cjs') return session;
    if (name === './page.cjs') return { observe: async () => { calls.observe++; return hooks.observe ? hooks.observe(f) : choice('new'); } };
    if (name === './codex-delivery.cjs') return { submit: async (...args) => {
      calls.submit++;
      return hooks.submit ? hooks.submit(f, ...args) : { state: 'accepted', outcome: 'queue_accepted' };
    } };
    throw Error('Unexpected require: ' + name);
  };
  const module = { exports: {} };
  let clock = 1000;
  vm.runInNewContext(source, {
    module, require: mockRequire, process: { pid: process.pid }, console,
    Date: class extends Date { static now() { return clock; } },
    setTimeout(callback, ms) {
      calls.sleeps.push(ms);
      clock += ms;
      // Keep tests bounded even if an ownership/stop regression loops forever.
      if (calls.sleeps.length > 200) throw Error('Worker failed to stop');
      if (hooks.sleep) hooks.sleep(f, ms);
      else if (notifications.read(dir)?.enabled) notifications.disable(dir, 'test_complete');
      queueMicrotask(callback);
    },
  }, { filename: 'notify-worker.cjs' });
  f.run = token => module.exports.run('game', 'native', token);
  return f;
}

test('worker discards a snapshot that overlaps completed CLI feedback', async t => {
  const f = fixture(t, { observe(f) {
    notifications.acknowledge(f.dir, f.state, choice('already-returned'));
    return choice('stale-before-act');
  } });
  await f.run();
  assert.equal(f.calls.submit, 0);
  assert.equal(f.calls.close, 1);
});

test('worker does not publish a plan intermediate choice while operation lock is held', async t => {
  const f = fixture(t, {
    observe: f => f.calls.observe === 1 ? choice('plan-intermediate') : choice('plan-result'),
    lock(f) { if (f.calls.lock === 1) throw Object.assign(Error('plan owns operation lock'), { code: 'operation_busy' }); },
    sleep(f) {
      if (f.calls.observe === 1) notifications.acknowledge(f.dir, f.state, choice('plan-result'));
      else notifications.disable(f.dir, 'test_complete');
    },
  });
  await f.run();
  assert.equal(f.calls.observe, 2);
  assert.equal(f.calls.connect, 1, 'polling must reuse its renderer connection');
  assert.equal(f.calls.submit, 0);
});

test('ownership change during observation prevents old worker delivery', async t => {
  const f = fixture(t, { observe(f) {
    notifications.write(f.dir, { ...notifications.read(f.dir), workerPid: process.pid + 1 });
    return choice('new');
  } });
  await f.run();
  assert.equal(f.calls.submit, 0);
});

test('receipt persistence retries the lock without re-submitting and respects off', async t => {
  const f = fixture(t, {
    lock(f) { if (f.calls.lock === 2) throw Object.assign(Error('act owns operation lock'), { code: 'operation_busy' }); },
    submit(f) { notifications.disable(f.dir, 'disabled'); return { state: 'accepted', receipt: 'one-message' }; },
    sleep() {},
  });
  await f.run();
  assert.equal(f.calls.submit, 1);
  assert.equal(f.calls.lock, 3);
  assert.equal(notifications.read(f.dir).enabled, false);
  assert.equal(notifications.read(f.dir).last.receipt, 'one-message');
  assert.equal(f.calls.evidence.length, 1);
});

test('repeated renderer failures send one bounded fault and stop', async t => {
  const f = fixture(t, {
    observe() { throw Error('renderer disconnected'); },
    sleep() {},
  });
  await f.run();
  assert.equal(f.calls.observe, 3);
  assert.equal(f.calls.connect, 3);
  assert.equal(f.calls.submit, 1);
  assert.equal(notifications.read(f.dir).reason, 'runtime_fault');
});

test('a replaced game session is rejected after observation and before submit', async t => {
  const f = fixture(t, { observe(f) { f.state.browserWs = 'ws://another-process'; return choice('wrong-game'); } });
  await f.run();
  assert.equal(f.calls.submit, 0);
  assert.equal(notifications.read(f.dir).reason, 'session_changed');
});

test('worker waits for its PID publication after matching token is published before spawn', async t => {
  const token = 'worker-start-token';
  const f = fixture(t, { sleep(f) {
    const state = notifications.read(f.dir);
    if (state.workerPid === null) {
      assert.equal(f.calls.connect, 0, 'unpublished worker must not touch the client');
      assert.equal(f.calls.submit, 0);
      notifications.write(f.dir, { ...state, workerPid: process.pid });
    } else notifications.disable(f.dir, 'test_complete');
  } });
  notifications.write(f.dir, { ...notifications.read(f.dir), workerPid: null, workerToken: token });
  await f.run(token);
  assert.ok(f.calls.sleeps.length >= 1, 'startup must wait instead of exiting before PID publication');
  assert.equal(f.calls.observe, 1);
  assert.equal(f.calls.submit, 1);
});

test('unpublished PID handshake has a finite three-second deadline', async t => {
  const token = 'never-published';
  const f = fixture(t, { sleep() {} });
  notifications.write(f.dir, { ...notifications.read(f.dir), workerPid: null, workerToken: token });
  await f.run(token);
  const elapsed = f.calls.sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.ok(elapsed >= 3000 && elapsed <= 3500, `unexpected startup wait: ${elapsed} ms`);
  assert.equal(f.calls.connect, 0);
  assert.equal(f.calls.submit, 0);
});

test('an old worker token exits immediately even before a new PID is published', async t => {
  const f = fixture(t);
  notifications.write(f.dir, { ...notifications.read(f.dir), workerPid: null, workerToken: 'replacement' });
  await f.run('obsolete');
  assert.equal(f.calls.sleeps.length, 0);
  assert.equal(f.calls.connect, 0);
  assert.equal(f.calls.submit, 0);
});

test('token changes during observation prevent delivery despite unchanged PID', async t => {
  const f = fixture(t, { observe(f) {
    notifications.write(f.dir, { ...notifications.read(f.dir), workerToken: 'replacement' });
    return choice('new');
  } });
  notifications.write(f.dir, { ...notifications.read(f.dir), workerToken: 'original' });
  await f.run('original');
  assert.equal(f.calls.observe, 1);
  assert.equal(f.calls.submit, 0);
});
