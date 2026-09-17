'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Run the real CLI and real plan interpreter with an in-memory transport. No
// game process, user profile, real stdin, or session evidence directory is used.
function fixture({ input = '', failAt = null, afterPrint = null, firstOptions = null } = {}) {
  const filename = path.resolve(__dirname, '../bin/noname.cjs');
  const realRequire = createRequire(filename);
  const realDisplayConfig = realRequire('../src/display-config.cjs');
  const emitted = [], requests = [], commits = [], evidence = [], ordering = [];
  const rows = [{ seq: 1, text: '上次操作后对手行动' }];
  let committed = 0, clicks = 0, closes = 0, reads = 0, locked = false;
  const addLog = text => rows.push({ seq: rows.length + 1, text });
  const logs = ({ since = committed } = {}) => {
    const entries = rows.filter(row => row.seq > since).map(row => ({ ...row }));
    return { epoch: 'test-game', from: entries[0]?.seq ?? rows.length + 1, to: rows.length, entries, truncated: false };
  };
  const options = () => clicks === 0 ? firstOptions || [{ id: 'c1', kind: 'card', label: '杀' }] : clicks === 1 ? [{ id: 't1', player: 'p9', kind: 'target', label: '目标' }] : [{ id: 'ok', kind: 'confirm', label: '确定' }];
  const observe = () => ({
    state: clicks >= 3 ? 'running' : 'choice', revision: `rev:${clicks}`, mode: 'identity', round: 1, phase: 'phaseUse', actor: 'p1', victory: '取胜条件',
    me: { id: 'p1', label: '玩家', name: 'test', identity: { label: '反贼' }, hp: 3, maxHp: 3, armor: 0, hand: [], equipment: [], judgments: [], marks: [] }, players: [],
    choice: clicks >= 3 ? null : { id: 'e1', event: 'chooseToUse', prompt: '请选择', constraints: {}, context: { certainty: 'known', skill: null, actor: 'p1', sourceAction: null }, options: options() },
    log: logs(),
  });
  const cdp = { close() { closes++; }, async evaluate() { return []; } };
  const session = {
    async withLock(_name, body) { assert.equal(locked, false); locked = true; ordering.push('lock'); try { return await body(); } finally { locked = false; ordering.push('unlock'); } },
    async connect() { return { cdp, state: { evidenceDirectory: 'in-memory-only' } }; },
    async appendEvidence(_name, row) { evidence.push(row); ordering.push('evidence'); },
  };
  const page = {
    async observe() { return observe(); },
    async act(_cdp, request) {
      assert.equal(locked, true, 'all clicks must run under one session mutation lock');
      requests.push({ ...request }); ordering.push('click');
      if (failAt === requests.length) return { ok: false, code: 'option_unavailable', message: '目标已不可选', state: observe() };
      assert.equal(request.at, `rev:${clicks}`);
      const chosen = options().find(option => option.id === request.id);
      assert.ok(chosen, 'the real plan resolver must select a current visible option');
      clicks++; addLog(`点击${clicks}产生的战报`);
      return { ok: true, action: chosen, state: observe() };
    },
    async effects() { return { epoch: 'test-game', actions: [] }; },
    async logs(_cdp, request) { return logs(request); },
    async commitLogs(_cdp, cursor) {
      assert.equal(locked, true); ordering.push('commit'); commits.push({ ...cursor });
      assert.equal(cursor.epoch, 'test-game'); assert.ok(cursor.to >= committed && cursor.to <= rows.length);
      committed = cursor.to; return { ok: true };
    },
  };
  const fakeFs = { existsSync: () => false, readFileSync(fd, encoding) { assert.equal(fd, 0); assert.equal(encoding, 'utf8'); reads++; return input; } };
  const mockRequire = name => {
    if (name === 'node:fs') return fakeFs;
    if (name === '../src/native-session.cjs' || name === '../src/session.cjs') return session;
    if (name === '../src/native-setup.cjs' || name === '../src/setup.cjs') return {};
    if (name === '../src/page.cjs') return page;
    if (name === '../src/display-config.cjs') return { ...realDisplayConfig, read: () => ({ logs: 'compact', state: 'auto' }) };
    return realRequire(name);
  };
  const module = { exports: {} }, process = { exitCode: 0 };
  const context = vm.createContext({ module, exports: module.exports, require: mockRequire, process, Buffer, setTimeout, clearTimeout, console: { log(value) { emitted.push(value); ordering.push('print'); afterPrint?.({ addLog }); } } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { page, session, main: module.exports.main, emitted, requests, commits, evidence, ordering, process, addLog, logs, get closes() { return closes; }, get reads() { return reads; } };
}

test('stdin reads and validates the entire JSON including unused branches before clicking', async () => {
  const f = fixture({ input: JSON.stringify({ steps: [{ select: 'c1' }, { if: { action: 'lastCard', effect: 'damage', op: '>', value: 0 }, then: [], else: [{ arbitraryCode: 'must not run' }] }] }, null, 2) });
  await assert.rejects(f.main(['act', '--stdin', '--at', 'rev:0']), /不支持的动作字段/);
  assert.equal(f.reads, 1); assert.equal(f.requests.length, 0); assert.equal(f.commits.length, 0); assert.equal(f.closes, 1);
});

test('malformed trailing stdin JSON cannot execute a valid prefix', async () => {
  const f = fixture({ input: '{"steps":[{"select":"c1"}]} trailing junk' });
  await assert.rejects(f.main(['act', '--stdin', '--at', 'rev:0']));
  assert.equal(f.requests.length, 0); assert.equal(f.commits.length, 0);
});

test('state_hide affects emitted JSON only while action evidence and log cursor remain complete', async () => {
  const f = fixture();
  await f.main(['act', 'c1', '--at', 'rev:0', '--state_hide', '--json']);
  const output = JSON.parse(f.emitted[0]);
  assert.equal(output.state.me, undefined);
  assert.equal(output.state.presentation.state, 'hidden');
  assert.equal(output.state.choice.options[0].id, 't1');
  assert.equal(f.evidence.find(row => row.command === 'act').output.state.me.name, 'test');
  assert.equal(f.requests.length, 1);
  assert.equal(f.commits.length, 1);
  assert.equal(f.commits[0].to, output.state.log.to);
});

test('experimental act emits the event journal while committing both captured cursors and preserving native evidence', async () => {
  const f = fixture(), original = f.page.act;
  f.page.act = async (...args) => {
    const output = await original(...args);
    output.state.experimentalLog = { source: 'eventflow', epoch: 'journal-test', from: 1, to: 1, entries: [{ seq: 1, kind: 'state', player: {id:'p9'}, changes: [{kind:'hp',before:3,after:2}] }], coverage: 'experimental_partial' };
    return output;
  };
  await f.main(['act', 'c1', '--at', 'rev:0', '--log-mode', 'experimental', '--json']);
  const output = JSON.parse(f.emitted[0]);
  assert.equal(output.state.log.source, 'eventflow');
  assert.equal(output.state.experimentalLog, undefined);
  assert.equal(f.evidence.find(row => row.command === 'act').output.state.log.epoch, 'test-game');
  assert.equal(f.commits[0].epoch, 'test-game');
  assert.equal(f.commits[0].eventEpoch, 'journal-test');
  assert.equal(f.commits[0].eventTo, 1);
});

test('invalid experimental mode or conflicting display flags cannot click', async () => {
  for (const flags of [['--log-mode','unknown'],['--log-mode','experimental','--raw']]) {
    const f=fixture();
    await assert.rejects(f.main(['act','c1','--at','rev:0',...flags]), /log-mode/);
    assert.equal(f.requests.length,0);
  }
});

test('stdin rejects positional actions and single-action flags before any click', async () => {
  for (const args of [['c1'], ['--value', '2'], ['--to', 'g1'], ['--unselect']]) {
    const f = fixture({ input: '{"steps":[{"select":"c1"}]}' });
    await assert.rejects(f.main(['act', '--stdin', '--at', 'rev:0', ...args]));
    assert.equal(f.requests.length, 0); assert.equal(f.commits.length, 0); assert.equal(f.reads, 0);
  }
});

test('partial success default output identifies completed action and stopped step', async () => {
  const f = fixture({ input: 'c1 > p9 > confirm', failAt: 2 });
  await f.main(['act', '--stdin', '--at', 'rev:0']);
  const output = f.emitted.at(-1);
  assert.match(output, /组合停止 option_unavailable/);
  assert.match(output, /steps\[0\]: 杀/);
  assert.match(output, /停止于 steps\[1\]/);
  assert.match(output, /目标已不可选/);
  assert.equal(f.requests.length, 2); assert.equal(f.process.exitCode, 1);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].to, 2);
});

test('one full JSON plan makes multiple native clicks but commits exactly its final returned log cursor once', async () => {
  const f = fixture({ input: JSON.stringify({ steps: [{ select: 'c1' }, { select: 'p9' }, { select: 'confirm' }] }, null, 2) });
  await f.main(['act', '--stdin', '--at', 'rev:0', '--json']);
  const result = JSON.parse(f.emitted.at(-1));
  assert.equal(result.ok, true); assert.equal(result.completed.length, 3);
  assert.equal(f.reads, 1); assert.equal(f.requests.length, 3);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].to, result.state.log.to);
  assert.equal(result.state.log.from, 1); assert.equal(result.state.log.to, 4);
  assert.deepEqual(result.state.log.entries.map(row => row.seq), [1, 2, 3, 4]);
  assert.equal(f.ordering.filter(x => x === 'lock').length, 1);
  assert.ok(f.ordering.indexOf('print') < f.ordering.indexOf('commit'));
  assert.ok(f.ordering.indexOf('commit') < f.ordering.indexOf('unlock'));
});

test('observe, wait and logs preview all new logs without consuming act cursor', async () => {
  const f = fixture();
  f.addLog('新的公共战报');
  for (const command of ['observe', 'wait', 'logs']) await f.main([command, '--json']);
  const outputs = f.emitted.map(text => JSON.parse(text));
  for (const out of outputs) assert.deepEqual((out.log || out).entries.map(row => row.seq), [1, 2]);
  assert.equal(f.commits.length, 0); assert.equal(f.requests.length, 0);
});

test('logs generated after feedback snapshot remain available after commit', async () => {
  let inserted = false;
  const f = fixture({ input: 'c1 > p9 > confirm', afterPrint({ addLog }) { if (!inserted) { inserted = true; addLog('输出之后游戏继续结算'); } } });
  await f.main(['act', '--stdin', '--at', 'rev:0', '--json']);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].to, 4);
  await f.main(['logs', '--json']);
  const remaining = JSON.parse(f.emitted.at(-1));
  assert.equal(remaining.from, 5); assert.equal(remaining.to, 5);
  assert.deepEqual(remaining.entries.map(row => row.text), ['输出之后游戏继续结算']);
  assert.equal(f.commits.length, 1);
});

test('diagnose retains diagnostics even when the game module cannot be imported', async () => {
 const f=fixture(); f.page.observe=async()=>{throw Error('vue resolution failed');}; f.session.status=async()=>({running:true});
 await f.main(['diagnose','--json']); const value=JSON.parse(f.emitted.at(-1));
 assert.equal(value.state.state,'unavailable'); assert.match(value.state.error,/vue resolution/); assert.ok(Array.isArray(value.diagnostics)); assert.equal(f.commits.length,0);
});

test('2v2 isolated request is rejected before acquiring a session or launching a client', async () => {
  const f = fixture();
  await assert.rejects(f.main(['start', '--mode', '2v2', '--character', 'nihil_huojing', '--client', 'isolated']), /2v2.*原客户端/);
  assert.equal(f.ordering.length, 0); assert.equal(f.evidence.length, 0); assert.equal(f.requests.length, 0);
});


test('single skill selector uses the guarded plan resolver and actual visible option ID', async () => {
  const f = fixture({ firstOptions: [{ id: 's17', kind: 'skill', skill: 'tia_daowu_shan', label: '悼舞' }] });
  await f.main(['act', 'skill:tia_daowu_shan', '--at', 'rev:0', '--json']);
  const result = JSON.parse(f.emitted[0]); assert.equal(result.ok, true); assert.equal(result.completed.length, 1); assert.equal(f.requests[0].id, 's17'); assert.equal(f.commits.length, 1);
});
