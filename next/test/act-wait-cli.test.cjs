'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Real CLI, plan interpreter and wait helper; no game, session files or host
// delivery. A fake observation clock makes the 60-second boundary deterministic.
function fixture({ actionSteps = 1, failAt, reads = ['choice'], commitResult = { ok: true } } = {}) {
  const filename = path.resolve(__dirname, '../bin/noname.cjs'), realRequire = createRequire(filename);
  const events = [], emitted = [], commits = [], acks = [], evidence = [], requests = [], planOptions = [], waitOptions = [];
  let locked = false, clicks = 0, clock = 0, readIndex = 0, consumed = 0;
  const rows = [{ seq: 1, text: '调用前未消费日志' }], eventRows = [{ seq: 1, kind: 'state', changes: [] }];
  const addLog = text => { rows.push({ seq: rows.length + 1, text }); eventRows.push({ seq: eventRows.length + 1, kind: 'state', changes: [] }); };
  const options = [{ id: 'c1', kind: 'card', label: '杀' }, { id: 'p2', kind: 'target', player: 'p2', label: '目标' }, { id: 'ok', kind: 'confirm', label: '确定' }];
  const snapshot = state => ({ state, revision: `game:${clicks + readIndex}`, phase: 'phaseUse', mode: 'identity',
    me: { id: 'p1', name: 'self', label: '自己', identity: {}, hand: [], equipment: [], judgments: [] }, players: [],
    choice: state === 'choice' ? { id: 'same', decisionId: 'd1', event: 'chooseToUse', constraints: {}, prompt: '请选择', context: { certainty: 'known', actor: 'p1', skill: null, sourceAction: null }, options } : null,
    log: { epoch: 'native', from: consumed + 1, to: rows.length, truncated: false, entries: rows.slice(consumed) },
    experimentalLog: { epoch: 'journal', source: 'eventflow', from: consumed + 1, to: eventRows.length, coverage: 'experimental_partial', truncated: false, entries: eventRows.slice(consumed) } });
  const session = {
    sessionDir: () => 'memory',
    async withLock(_name, work) { assert.equal(locked, false, 'no lock reentry'); locked = true; events.push('lock'); try { return await work(); } finally { locked = false; events.push('unlock'); } },
    async connect() { events.push('connect'); return { cdp: { close() { events.push('close'); } }, state: { evidenceDirectory: 'memory' } }; },
    async appendEvidence(_name, row) { evidence.push(row); },
  };
  const page = {
    async act(_cdp, request) {
      assert.equal(locked, true); events.push('act'); requests.push(request);
      if (failAt === requests.length) return { ok: false, code: 'option_unavailable', message: '已停止', state: snapshot('choice') };
      clicks++; addLog(`动作 ${clicks}`);
      return { ok: true, action: options.find(o => o.id === request.id || o.kind === request.id), state: snapshot(clicks >= actionSteps ? 'running' : 'choice') };
    },
    async actMany(cdp, request) {
      events.push('actMany'); const actions = []; let output;
      for (const id of request.ids) { output = await page.act(cdp, { id, at: `game:${clicks}` }); if (!output.ok) return { ...output, actions }; actions.push(output.action); }
      return { ok: true, actions, state: output.state };
    },
    async observe() {
      assert.equal(locked, true, 'wait and plan observations share the operation lock'); events.push('observe');
      if (clicks < actionSteps) return snapshot('choice');
      const next = reads[Math.min(readIndex++, reads.length - 1)];
      if (next instanceof Error) throw next;
      addLog(`等待 ${readIndex}`);
      return typeof next === 'function' ? next(snapshot('running')) : snapshot(next);
    },
    async effects() { return { epoch: 'native', actions: [] }; },
    async commitLogs(_cdp, cursor) { assert.equal(locked, true); events.push('commit'); commits.push(cursor); if (commitResult.ok !== false) consumed = cursor.to; return commitResult; },
  };
  const notifications = {
    beginOperation() { assert.equal(locked, true); events.push('begin'); },
    acknowledge(_dir, _session, state) { assert.equal(locked, true); events.push('ack'); acks.push(state); },
    read: () => ({ enabled: true }), ensureWorker: () => ({ enabled: true, status: 'armed' }),
    status() { events.push('notify-status'); assert.equal(locked, false); return { enabled: true, status: 'operation_busy' }; },
  };
  const env = { exitCode: 0 }, module = { exports: {} };
  const requireFixture = name => {
    if (name === 'node:fs') return { existsSync: () => false };
    if (['../src/native-session.cjs', '../src/session.cjs'].includes(name)) return session;
    if (['../src/native-setup.cjs', '../src/setup.cjs'].includes(name)) return {};
    if (name === '../src/page.cjs') return page;
    if (name === '../src/notification.cjs') return notifications;
    if (name === '../src/plan.cjs') { const real = realRequire(name); return { ...real, executePlan(plan, adapter, opts) { planOptions.push(opts); return real.executePlan(plan, adapter, opts); } }; }
    if (name === '../src/act-wait.cjs') { const real = realRequire(name); return { ...real, waitAfterAction(output, adapter, opts) { waitOptions.push(opts); return real.waitAfterAction(output, { ...adapter, now: () => clock, sleep: async ms => { assert.equal(locked, true); events.push('sleep'); clock += ms; } }, opts); } }; }
    return realRequire(name);
  };
  const context = vm.createContext({ module, exports: module.exports, require: requireFixture, process: env, Buffer, setTimeout, clearTimeout,
    console: { log(value) { events.push('print'); emitted.push(value); addLog('输出之后'); } } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { main: module.exports.main, events, emitted, commits, acks, evidence, requests, planOptions, waitOptions, env, rows };
}

test('single action waits once and acknowledges and commits the final snapshot under one lock', async () => {
  const f = fixture();
  await f.main(['act', 'c1', '--at', 'game:0', '--wait', '--json', '--state_hide']);
  const out = JSON.parse(f.emitted[0]);
  assert.equal(f.requests.length, 1); assert.equal(out.action.id, 'c1'); assert.equal(out.wait.status, 'ready');
  assert.equal(out.state.me, undefined); assert.equal(out.state.choice.options[0].id, 'c1');
  assert.equal(f.events.filter(e => e === 'lock').length, 1); assert.equal(f.events.filter(e => e === 'connect').length, 1);
  assert.equal(f.events.filter(e => e === 'begin').length, 1); assert.equal(f.events.filter(e => e === 'close').length, 1);
  assert.equal(f.acks.length, 1); assert.equal(f.acks[0].revision, out.state.revision);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].to, 3); assert.equal(f.commits[0].eventTo, 3);
  assert.equal(f.rows.length, 4, 'new log after printing is not committed');
  assert.deepEqual(out.state.log.entries.map(row => row.seq), [1, 2, 3]);
  assert.equal(f.evidence[0].output.state.me.name, 'self');
  assert.ok(f.events.indexOf('ack') > f.events.indexOf('observe')); assert.ok(f.events.indexOf('commit') > f.events.indexOf('print'));
  assert.ok(f.events.indexOf('unlock') > f.events.indexOf('commit'));
});

test('existing choice returns immediately and legacy act does not gain wait metadata', async () => {
  for (const waiting of [false, true]) {
    const f = fixture({ actionSteps: 3 });
    await f.main(['act', 'c1', '--at', 'game:0', '--json', ...(waiting ? ['--wait'] : [])]);
    const out = JSON.parse(f.emitted[0]);
    assert.equal(out.wait?.status, waiting ? 'ready' : undefined); assert.equal(f.events.includes('observe'), false);
    assert.equal(f.events.includes('sleep'), false); assert.equal(f.requests.length, 1);
  }
});

test('actMany and real plan both append read-only wait without discarding completed actions', async () => {
  for (const args of [['c1', 'p2', 'confirm'], ['c1 > p2 > confirm']]) {
    const f = fixture({ actionSteps: 3, reads: ['dead'] });
    await f.main(['act', ...args, '--at', 'game:0', '--wait', '--wait-seconds', '2', '--seconds', '7', '--json']);
    const out = JSON.parse(f.emitted[0]);
    assert.equal((out.actions || out.completed).length, 3); assert.equal(out.wait.reason, 'dead'); assert.equal(f.requests.length, 3);
    assert.equal(f.commits.length, 1); assert.equal(f.acks.length, 1); assert.equal(f.acks[0].state, 'dead');
    assert.equal(f.waitOptions[0].seconds, 2);
    if (f.planOptions.length) assert.equal(f.planOptions[0].timeoutMs, 7000, '--seconds still belongs to the plan');
  }
});

test('partial actMany and plan failure do not observe further or wash the original failure away', async () => {
  for (const args of [['c1', 'p2', 'confirm'], ['c1 > p2 > confirm']]) {
    const f = fixture({ actionSteps: 3, failAt: 2 });
    await f.main(['act', ...args, '--at', 'game:0', '--wait', '--json']);
    const out = JSON.parse(f.emitted[0]);
    assert.equal(out.code, 'option_unavailable'); assert.equal(out.ok, false); assert.equal(out.wait.status, 'skipped');
    assert.equal((out.actions || out.completed).length, 1); assert.equal(f.requests.length, 2); assert.equal(f.events.includes('sleep'), false);
    assert.equal(f.events.filter(e => e === 'observe').length, f.planOptions.length ? 1 : 0); assert.equal(f.env.exitCode, 1);
  }
});

test('timeout is visible in text with hidden state and in JSON, without replaying the action', async () => {
  for (const json of [false, true]) {
    const f = fixture({ reads: ['running'] });
    await f.main(['act', 'c1', '--at', 'game:0', '--wait', '--wait-seconds', '1', '--state_hide', ...(json ? ['--json'] : [])]);
    assert.equal(f.requests.length, 1); assert.equal(f.commits.length, 1); assert.equal(f.acks.at(-1).state, 'running');
    if (json) { const out = JSON.parse(f.emitted[0]); assert.equal(out.wait.status, 'timeout'); assert.equal(out.ok, true); }
    else assert.match(f.emitted[0], /动作已完成；等待超时，当前 running/);
  }
});

test('observation error and epoch change preserve the successful action and do not ack or commit stale feedback', async () => {
  for (const next of [Error('disconnect'), state => ({ ...state, revision: 'other:1' })]) {
    const f = fixture({ reads: [next] });
    await f.main(['act', 'c1', '--at', 'game:0', '--wait', '--json']);
    const out = JSON.parse(f.emitted[0]);
    assert.equal(out.action.id, 'c1'); assert.equal(out.actionOutcome, 'completed'); assert.equal(out.stateFresh, false);
    assert.equal(out.ok, false); assert.equal(out.wait.status, 'error'); assert.equal(f.requests.length, 1);
    assert.equal(f.acks.length, 0); assert.equal(f.commits.length, 0); assert.equal(f.env.exitCode, 1);
    assert.equal(f.events.at(-1), 'unlock');
  }
});

test('wait failure text names the completed single action even when the board is hidden', async () => {
  const f = fixture({ reads: [Error('disconnect')] });
  await f.main(['act', 'c1', '--at', 'game:0', '--wait', '--state_hide']);
  assert.match(f.emitted[0], /已执行 杀/);
  assert.match(f.emitted[0], /等待失败.*快照不是当前状态/);
});

test('wait flags validate before lock, connection, notification mutation and action', async () => {
  for (const args of [
    ['act', 'c1', '--at', 'game:0', '--wait-seconds', '1'], ['observe', '--wait'], ['notify', 'status', '--wait'],
    ...['0', '61', '1.5', 'NaN'].map(n => ['act', 'c1', '--at', 'game:0', '--wait', '--wait-seconds', n]),
    ['act', 'c1', '--at', 'game:0', '--wait', '--wait-seconds'],
  ]) {
    const f = fixture(); await assert.rejects(f.main(args)); assert.equal(f.events.length, 0); assert.equal(f.requests.length, 0);
  }
});

test('default and maximum wait budget are distinct from the plan execution budget', async () => {
  for (const seconds of [undefined, '60']) {
    const f = fixture({ reads: ['over'] });
    await f.main(['act', 'c1', '--at', 'game:0', '--wait', '--json', ...(seconds ? ['--wait-seconds', seconds] : [])]);
    assert.equal(JSON.parse(f.emitted[0]).wait.seconds, seconds ? 60 : 15);
  }
});

test('notification status is readable without taking the act operation lock', async () => {
  const f = fixture(); await f.main(['notify', 'status', '--json']);
  assert.equal(JSON.parse(f.emitted[0]).status, 'operation_busy'); assert.equal(f.events.includes('lock'), false); assert.equal(f.events.includes('connect'), false);
});

test('failed log commit is explicit and retains the already printed successful action in error evidence', async () => {
  const f = fixture({ commitResult: { ok: false, code: 'event_epoch_changed' } });
  await assert.rejects(f.main(['act', 'c1', '--at', 'game:0', '--wait', '--json']), error => {
    assert.equal(error.code, 'event_epoch_changed'); assert.equal(error.details.phase, 'log_commit');
    assert.equal(error.details.output.action.id, 'c1'); assert.equal(error.details.output.actionOutcome, 'completed'); return true;
  });
  assert.equal(f.requests.length, 1); assert.equal(f.emitted.length, 1); assert.equal(f.evidence.at(-1).output.action.id, 'c1');
  assert.equal(f.events.at(-1), 'unlock');
});
