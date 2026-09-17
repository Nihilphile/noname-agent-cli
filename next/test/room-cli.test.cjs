'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function fixture(role = 'guest') {
  const filename = path.resolve(__dirname, '../bin/noname.cjs'), real = createRequire(filename);
  const calls = [], output = [];
  const room = { id: 'table', role, controller: 'agent' };
  const result = { ok: true, room: 'table', mode: 'doudizhu', state: 'lobby', members: [] };
  const requireMock = name => {
    if (name === '../src/session.cjs') return { read: () => ({ room }), status: async name => { calls.push(['isolated-status', name]); return { running: true }; } };
    if (name === '../src/native-session.cjs') return { status: () => { throw Error('must not touch original client'); } };
    if (name === '../src/room.cjs') return {
      create: async (id, options) => { calls.push(['create', id, options]); return result; },
      leave: async (id, session) => { calls.push(['leave', id, session]); return result; },
    };
    if (name === '../src/display-config.cjs') return { read: () => ({}), resolve: () => ({}), project: value => value };
    if (name === '../src/display-feedback.cjs') return { prepare: () => ({ options: {}, commit() {} }) };
    return real(name);
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: requireMock, process: { exitCode: 0 }, Buffer, setTimeout, console: { log: x => output.push(x) } }, { filename });
  return { ...module.exports, calls, output };
}
test('room CLI forwards mode and deadline; default output is concise and JSON remains explicit', async () => {
  const f = fixture();
  await f.main(['room', 'create', 'table', '--mode', '2v2', '--host', 'agent', '--turn-seconds', '900']);
  assert.equal(f.calls[0][2].timeout, '900'); assert.equal(f.calls[0][2].mode, '2v2');
  assert.match(f.output[0], /^房间 table/);
  await f.main(['room', 'create', 'table', '--json']); assert.equal(JSON.parse(f.output[1]).room, 'table');
});
test('room sessions automatically route to isolated client and stop delegates to room ownership', async () => {
  const f = fixture();
  await f.main(['status', '--session', 'a', '--json']);
  await f.main(['stop', '--session', 'a', '--json']);
  assert.deepEqual(f.calls, [['isolated-status', 'a'], ['leave', 'table', 'a']]);
});
test('room CLI blocks native routing and individual restart before touching a client', async () => {
  const f = fixture();
  await assert.rejects(f.main(['observe', '--session', 'a', '--client', 'native']), /独立客户端/);
  await assert.rejects(f.main(['restart', '--session', 'a']), /room close/);
  assert.equal(f.calls.length, 0);
});
