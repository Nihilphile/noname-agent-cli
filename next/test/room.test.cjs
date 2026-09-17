'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function fixture({ failHost = false, extensionEntries = [] } = {}) {
  const filename = path.resolve(__dirname, '../src/room.cjs'), real = createRequire(filename);
  const files = new Map(), states = new Map(), launches = [], stopped = [], locks = new Set();
  const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
  let playing = false;
  const session = {
    DEFAULT_SOURCE: path.resolve('test-game'),
    sessionDir(name) { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw Error('invalid session'); return path.resolve('test-state', name); },
    read: name => clone(states.get(name)),
    update(name, patch) { states.set(name, { ...states.get(name), ...clone(patch) }); },
    async withLock(name, fn) { assert.equal(locks.has(name), false); locks.add(name); try { return await fn(); } finally { locks.delete(name); } },
    async start(o) { launches.push(clone(o)); states.set(o.session, { room: clone(o.room), cleanupComplete: false }); return states.get(o.session); },
    async connect(name) { return { cdp: { name, close() {} } }; },
    async stop(name) { assert.ok(locks.has(name), 'ownership check and cleanup must share the session lock'); stopped.push(name); states.get(name).cleanupComplete = true; return { ok: true }; },
  };
  const setup = {
    async prepare() {}, async host() { if (failHost) throw Error('host failure'); },
    async join(cdp) { return { onlineID: `id-${cdp.name}` }; },
    async status(cdp) { return { connected: !states.get(cdp.name).cleanupComplete, waiting: !playing, peers: [...states.entries()].filter(([,s]) => !s.cleanupComplete).map(([name,s]) => ({ id: s.room.role === 'host' ? '1' : `id-${name}` })) }; },
    async start() { playing = true; }, async poll() { return { ready: true, playerId: 'host-native-seat' }; },
  };
  const fakeFs = { existsSync: f => files.has(f), readFileSync: f => files.get(f), writeFileSync: (f,s) => files.set(f,String(s)), mkdirSync() {}, renameSync(a,b) { files.set(b,files.get(a)); files.delete(a); } };
  const requireMock = name => {
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:net') return { createServer() { return { once() {}, listen(_p,_h,cb) { cb(); }, address: () => ({ port: 12345 }), close: cb => cb() }; } };
    if (name === './session.cjs') return session;
    if (name === './room-setup.cjs') return setup;
    if (name === './native-session.cjs') return { read: () => null };
    if (name === './notification.cjs') return { disable() {} };
    if (name === './extensions.cjs') return {snapshot:()=>clone(extensionEntries)};
    if (name === './extension-files.cjs') return {verifyFiles(){}};
    return real(name);
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename,'utf8'), { require: requireMock, module, __dirname: path.dirname(filename) }, { filename });
  return { api: module.exports, states, launches, stopped, setup };
}
test('room lifecycle binds three independent seats and refuses early start and host leave', async () => {
  const f = fixture();
  await f.api.create('table', { session: 'human' });
  assert.equal(f.launches[0].visible, true);
  await assert.rejects(f.api.start('table'), { code: 'room_not_ready' });
  await f.api.join('table', { session: 'a' }); await f.api.join('table', { session: 'b' });
  await assert.rejects(f.api.join('table', { session: 'c' }), { code: 'room_full' });
  const started = await f.api.start('table');
  assert.equal(started.state, 'playing');
  assert.equal(new Set(started.members.map(m => m.playerId)).size, 3);
  await assert.rejects(f.api.leave('table', 'human'), { code: 'host_leave_requires_close' });
  assert.equal(f.stopped.length, 0);
  await f.api.leave('table', 'a'); assert.deepEqual(f.stopped, ['a']);
  const closed = await f.api.close('table'); assert.equal(closed.state, 'closed');
  assert.deepEqual(f.stopped, ['a', 'b', 'human']);
  await f.api.close('table'); assert.equal(f.stopped.length, 3);
});
test('failed host setup retains owned metadata so explicit close cleans up the failed launch', async () => {
  const f = fixture({ failHost: true });
  await assert.rejects(f.api.create('broken'), /host failure/);
  assert.equal(f.api.read('broken').state, 'failed');
  assert.equal((await f.api.close('broken')).state, 'closed');
  assert.deepEqual(f.stopped, ['broken-host']);
});
test('room cleanup never closes a session rebound to a different room generation', async () => {
  const f = fixture(); await f.api.create('original', { host: 'agent' });
  f.states.get('original-host').room.epoch = 'another-generation';
  const result = await f.api.close('original');
  assert.equal(result.ok, false); assert.equal(result.state, 'cleanup_incomplete'); assert.equal(f.stopped.length, 0);
});
test('room creation validates mode and timeout before launching', async () => {
  const f = fixture();
  await assert.rejects(f.api.create('bad', { mode: 'unknown' }), { code: 'unsupported_room_mode' });
  await assert.rejects(f.api.create('bad', { timeout: 0 }), { code: 'invalid_room_timeout' });
  assert.equal(f.launches.length, 0);
});
test('room page imports wait for parser completion and an actual import map', async () => {
  const { evaluate } = require('../src/room-setup.cjs');
  for (const document of [{ readyState: 'loading', querySelectorAll: () => [] }, { readyState: 'complete', querySelectorAll: () => [] }]) {
    const cdp = { evaluate: source => vm.runInNewContext(source, { document }) };
    await assert.rejects(evaluate(cdp, () => true), /room_page_loading/);
  }
});

test('room freezes extension versions for later joiners even after the library changes', async () => {
  const extensionEntries = [{name:'Pack',sha256:'v1',root:'version-one',files:[],characterPacks:['other_id'],cardPacks:[]}];
  const f = fixture({extensionEntries});
  await f.api.create('frozen',{host:'agent'});
  extensionEntries[0].sha256='v2';extensionEntries[0].root='version-two';
  await f.api.join('frozen',{session:'late'});
  assert.equal(f.launches[0].extensionBundle[0].sha256,'v1');
  assert.equal(f.launches[1].extensionBundle[0].sha256,'v1');
  await f.api.close('frozen');
  await f.api.create('fresh',{host:'agent'});
  assert.equal(f.launches[2].extensionBundle[0].sha256,'v2');
});
