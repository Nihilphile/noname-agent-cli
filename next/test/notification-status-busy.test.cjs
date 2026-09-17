'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notification = require('../src/notification.cjs');

test('long live operation explains stale heartbeat without manufacturing worker health', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-notify-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const heartbeat = new Date(Date.now() - 60000).toISOString();
  // Parent and current process are independently live for this local fixture.
  const state = { version: 1, enabled: true, binding: { thread_id: 'fixture' }, workerPid: process.ppid, heartbeat };
  notification.write(dir, state);
  const lock = path.join(dir, 'operation.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'operation' }));
  const busy = notification.status(dir);
  assert.equal(busy.status, 'operation_busy');
  assert.equal(busy.heartbeat, heartbeat);
  assert.equal(busy.workerHealth, 'unconfirmed_while_operation_locked');
  assert.deepEqual(busy.operation, { pid: process.pid });
  fs.unlinkSync(lock);
  assert.equal(notification.status(dir).status, 'worker_unresponsive');
  fs.writeFileSync(lock, JSON.stringify({ pid: 0, nonce: 'stale' }));
  assert.equal(notification.status(dir).status, 'worker_unresponsive');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, nonce: 'worker' }));
  assert.equal(notification.status(dir).status, 'worker_unresponsive');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'operation' }));
  notification.write(dir, { ...state, workerPid: 0 });
  assert.equal(notification.status(dir).status, 'worker_unavailable');
  notification.write(dir, { ...state, enabled: false, reason: 'disabled' });
  assert.equal(notification.status(dir).status, 'disabled');
});
