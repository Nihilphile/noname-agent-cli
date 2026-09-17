'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const store = require('../src/game-log-store.cjs'), recorder = require('../src/game-log-recorder.cjs');
const { run } = require('../src/game-log-worker.cjs');
const { read, write, identity } = require('../src/runtime-monitor.cjs');
const { readJournalSnapshot } = require('../src/page.cjs');
const { render } = require('../bin/noname.cjs');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-game-log-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const actor = { id: 'fp1', name: 'a', label: '甲' };
function log(epoch, seqs, to = seqs.at(-1) || 0) {
  return { source: 'eventflow', epoch, to, from: seqs[0] ?? to + 1, players: [actor], entries: seqs.map(seq => ({ seq, kind: 'operation', actor, operation: { kind: 'card', name: 'sha', label: '杀' }, targets: [], context: { round: seq <= 2 ? 1 : 2 } })), coverage: 'experimental_partial' };
}
function evidence(dir, output, time = '2026-09-18T00:00:00Z') { fs.appendFileSync(path.join(dir, 'evidence.jsonl'), JSON.stringify({ time, command: 'observe', output }) + '\n'); }

test('offline recovery merges evidence snapshots and durable batches by epoch/seq, preserves games and gaps', async t => {
  const dir = temp(t);
  evidence(dir, { state: 'running', mode: 'identity', experimentalLog: log('one', [1, 2, 4]) });
  evidence(dir, { state: { state: 'over', result: { outcome: 'win' }, experimentalLog: log('one', [2, 4, 6]) } });
  store.append(dir, log('one', [3, 4], 6), { state: 'over' }, '2026-09-18T00:00:01Z');
  store.append(dir, log('two', [1]), { state: 'running' }, '2026-09-18T01:00:00Z');
  const archive = await store.load(dir), first = store.select(archive, { game: store.gameId('one') });
  assert.equal(archive.games.length, 2);
  assert.deepEqual(first.log.entries.map(e => e.seq), [1, 2, 3, 4, 6]);
  assert.deepEqual(first.game.gaps, [{ from: 5, to: 5 }]);
  assert.equal(first.game.endObserved, true); assert.equal(first.game.result.outcome, 'win');
  assert.equal(store.select(archive).game.epoch, 'two');
  assert.match(store.format(first), /缺失事件：5/);
  const slice = store.select(archive, { game: 'one', from: 2, to: 4, round: 2 });
  assert.deepEqual(slice.log.entries.map(e => e.seq), [3, 4]);
  assert.equal(slice.log.players[0].label, '甲');
  assert.match(render(first, false), /实验战报/); assert.doesNotMatch(render(first, false), /"operation"/);
  assert.equal(JSON.parse(render(first, true)).log.entries.length, 5);
});

test('truncated evidence and interrupted archive tails are reported, later batches remain readable', async t => {
  const dir = temp(t);
  evidence(dir, { experimentalLog: log('one', [3, 4], 8) });
  fs.appendFileSync(path.join(dir, 'evidence.jsonl'), '{"output":');
  fs.writeFileSync(store.archiveFile(dir), '{"version":');
  store.append(dir, log('one', [6], 8));
  const value = store.select(await store.load(dir));
  assert.deepEqual(value.game.gaps, [{ from: 1, to: 2 }, { from: 5, to: 5 }, { from: 7, to: 8 }]);
  assert.equal(value.warnings.length, 2);
  assert.equal(value.game.startVerified, false); assert.equal(value.game.endObserved, false);
});

test('more than 2000 events remain available offline and empty ranges do not change archive coverage', async t => {
  const dir = temp(t);
  for (let i = 0; i < 3; i++) store.append(dir, log('long', Array.from({ length: 1000 }, (_, j) => i * 1000 + j + 1)));
  const archive = await store.load(dir), value = store.select(archive, { round: 20 });
  assert.equal(archive.games[0].count, 3000); assert.equal(value.log.entries.length, 0);
  assert.deepEqual(value.game.gaps, []); assert.equal(value.log.truncated, false);
  assert.match(store.format(value), /无新增事件/);
  assert.equal(store.select(archive, { game: '../../other' }).code, 'game_log_unavailable');
});

test('collector advances only after durable writes and records terminal state even with no new events', async t => {
  const dir = temp(t); let fail = true;
  const collector = recorder.createCollector(dir, { append(...args) { if (fail) throw Error('disk full'); store.append(...args); } });
  assert.throws(() => collector.accept({ log: log('x', [1]), meta: { state: 'running' } }), /disk full/);
  assert.equal(collector.cursor, null);
  fail = false; collector.accept({ log: log('x', [1]), meta: { state: 'running' } });
  collector.accept({ log: log('x', [], 1), meta: { state: 'over' } });
  const size = fs.statSync(store.archiveFile(dir)).size;
  collector.accept({ log: log('x', [], 1), meta: { state: 'over' } });
  assert.equal(fs.statSync(store.archiveFile(dir)).size, size);
  assert.equal((await store.load(dir)).games[0].endObserved, true);
});

test('snapshot uses only public journal, does not commit feedback, and resets private cursor on reload', () => {
  const m = { game: { me: { name: 'me', getCards() { throw Error('must not read hands'); } }, roundNumber: 2 }, get: { mode: () => 'identity' }, _status: {} };
  let epoch = 'old';
  const api = { eventLogs(request) { assert.deepEqual(request, { since: 0 }); return log(epoch, [3, 4]); }, commitLogs() { throw Error('must not commit'); }, observe() { throw Error('must not read choice'); } };
  const a = readJournalSnapshot(m, api, { epoch: 'old', to: 3 }); assert.deepEqual(a.log.entries.map(e => e.seq), [4]); assert.equal(a.log.truncated, false);
  epoch = 'new'; const b = readJournalSnapshot(m, api, { epoch: 'old', to: 100 });
  assert.deepEqual(b.log.entries.map(e => e.seq), [3, 4]); assert.equal(b.log.truncated, true);
  assert.equal(b.meta.state, 'running'); m._status.over = true; assert.equal(readJournalSnapshot(m, api).meta.state, 'over');
});

test('worker keeps recording through player death and page reload, and flushes before disabling', async t => {
  const dir = temp(t), state = { status: 'running', pid: process.pid, startedAt: 'one', browserWs: 'ws://test', pageId: 'a' }, token = 'test';
  write(recorder.controlFile(dir), { enabled: true, token, identity: identity(state), pid: process.pid });
  let calls = 0, closed = 0;
  const requests = [];
  await run({ sessionDir: () => dir, read: () => state }, 'test', token, {
    dial: async () => ({ close() { closed++; } }),
    snapshot: async (_cdp, cursor) => { requests.push(cursor); calls++; return { log: log(calls <= 2 ? 'a' : 'b', [calls <= 2 ? calls : calls - 2]), meta: { state: calls === 4 ? 'over' : 'running' } }; },
    pause: async () => { if (calls === 3) write(recorder.controlFile(dir), { ...read(recorder.controlFile(dir)), enabled: false }); },
  });
  assert.equal(calls, 4); assert.equal(closed, 1); assert.equal(requests[1].to, 1);
  assert.equal(requests[3].epoch, 'b');
  const games = (await store.load(dir)).games;
  assert.equal(games.length, 2); assert.deepEqual(games.map(g => g.count), [2, 2]);
  assert.equal(games.find(g => g.epoch === 'b').endObserved, true);
  assert.equal(read(recorder.workerFile(dir, token)).status, 'stopped');
});

test('worker never writes a returned snapshot after session ownership changes', async t => {
  const dir = temp(t), state = { status: 'running', pid: process.pid, startedAt: 'one', browserWs: 'ws://test', pageId: 'a' }, token = 'test';
  write(recorder.controlFile(dir), { enabled: true, token, identity: identity(state), pid: process.pid });
  await run({ sessionDir: () => dir, read: () => state }, 'test', token, {
    dial: async () => ({ close() {} }), pause: async () => {},
    snapshot: async () => { state.startedAt = 'another'; return { log: log('x', [1]), meta: {} }; },
  });
  assert.equal(fs.existsSync(store.archiveFile(dir)), false);
});

test('worker retries failed sampling without advancing cursor and reports failed final flush', async t => {
  const dir = temp(t), state = { status: 'running', pid: process.pid, startedAt: 'one', browserWs: 'ws://test', pageId: 'a' }, token = 'test';
  write(recorder.controlFile(dir), { enabled: true, token, identity: identity(state), pid: process.pid });
  let calls = 0, dials = 0;
  await run({ sessionDir: () => dir, read: () => state }, 'test', token, {
    dial: async () => { dials++; return { close() {} }; },
    snapshot: async (_cdp, cursor) => {
      calls++; if (calls === 1) throw Error('page reloading');
      if (calls === 3) throw Error('window closed');
      assert.deepEqual(cursor, {}); return { log: log('x', [1]), meta: { state: 'running' } };
    },
    pause: async () => { if (calls === 1) assert.equal(read(recorder.workerFile(dir, token)).status, 'degraded'); if (calls === 2) write(recorder.controlFile(dir), { ...read(recorder.controlFile(dir)), enabled: false }); },
  });
  assert.equal(dials, 2); assert.equal((await store.load(dir)).games[0].count, 1);
  assert.match(read(recorder.workerFile(dir, token)).error, /末次采集失败.*window closed/);
  assert.equal(recorder.status(dir).status, 'stopped');
});

function cli(dir) {
  const filename = path.resolve(__dirname, '../bin/noname.cjs'), realRequire = createRequire(filename), outputs = [];
  let started = 0, enabled = 0;
  const session = { sessionDir: () => dir, read: () => null, status: async () => ({ running: false }), withLock: async (_name, fn) => fn(), start: async options => { assert.equal(options.character, undefined); started++; }, connect() { throw Error('offline reads must not connect'); } };
  const module = { exports: {} }, process = { exitCode: 0 };
  const context = vm.createContext({ module, exports: module.exports, process, Buffer, setTimeout, clearTimeout, console: { log: x => outputs.push(x) }, require(name) {
    if (['../src/native-session.cjs', '../src/session.cjs'].includes(name)) return session;
    if (['../src/native-setup.cjs', '../src/setup.cjs'].includes(name)) return { prepare() { throw Error('watch must not prepare game'); } };
    if (name === '../src/game-log-recorder.cjs') return { ...recorder, enable: async () => { enabled++; return { kind: 'watch', enabled: true, status: 'recording' }; } };
    if (name === '../src/display-config.cjs') return { ...realRequire(name), read: () => ({ logs: 'compact', state: 'auto' }) };
    return realRequire(name);
  } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { main: module.exports.main, outputs, process, get started() { return started; }, get enabled() { return enabled; } };
}
test('CLI reads full experimental text offline by default, catalog and round filter, JSON only on request', async t => {
  const dir = temp(t); evidence(dir, { experimentalLog: log('x', [1, 2, 3]) }); const f = cli(dir);
  await f.main(['logs', '--all']); assert.match(f.outputs[0], /实验战报/); assert.doesNotMatch(f.outputs[0], /"entries"/);
  await f.main(['logs', 'games']); assert.match(f.outputs[1], /g-/);
  await f.main(['logs', '--game', store.gameId('x'), '--round', '2', '--json']); assert.equal(JSON.parse(f.outputs[2]).log.entries.length, 1);
  await assert.rejects(f.main(['logs', '--all', '--from', '5', '--to', '2']), /不能大于/);
  await assert.rejects(f.main(['logs', '--all', '--raw']), /实验模式/);
  await assert.rejects(f.main(['logs', 'games', '--round', '2']), /筛选条件/);
  assert.equal(f.started, 0);
});
test('watch opens human native client without setup, selecting generals, or clicking', async t => {
  const f = cli(temp(t)); await f.main(['watch', 'on']);
  assert.equal(f.started, 1); assert.equal(f.enabled, 1); assert.match(f.outputs[0], /观战记录 recording/);
  await assert.rejects(f.main(['watch', 'on', '--client', 'isolated']), /先创建房间/);
  assert.equal(f.started, 1);
});
