'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise the real CLI, play executor, shared wait helper and presentation.
// Only the game/session/notification boundaries and the wait clock are replaced.
function fixture({ actionSteps = 1, reads = ['choice'], finalPhase = 'phaseUse', settleState = 'running', failAt, insertedChoice = false } = {}) {
  const filename = path.resolve(__dirname, '../bin/noname.cjs'), realRequire = createRequire(filename);
  const events = [], emitted = [], requests = [], commits = [], acks = [], evidence = [], playOptions = [], waitOptions = [];
  let locked = false, clicks = 0, sequence = 0, readIndex = 0, settled = false, clock = 0, nativeCursor = 0, eventCursor = 40;
  const logs = [{ seq: 1, text: '调用前未消费' }];
  const journal = [{ seq: 41, kind: 'operation', operationId: 'before', actor: { id: 'other', label: '角色1' }, operation: { kind: 'skill', id: 'before', label: '调用前技能' }, targets: [] }];
  const addLog = text => {
    logs.push({ seq: logs.length + 1, text });
    journal.push({ seq: 40 + journal.length + 1, kind: 'operation', operationId: `op${journal.length}`, actor: { id: 'other', label: '角色1' }, operation: { kind: 'skill', id: `skill${journal.length}`, label: text }, targets: [] });
  };
  const snapshot = state => {
    const phase = clicks >= actionSteps ? finalPhase : 'phaseUse';
    return { state, revision: `game:${sequence++}`, phase, phaseId: phase === 'phaseUse' ? 'game:phaseUse:1' : null, actor: 'me', mode: 'versus', submode: 'two', round: 1,
      me: { id: 'me', name: 'hero', label: '自己', identity: {}, hand: [], equipment: [], judgments: [] }, players: [],
      choice: state === 'choice' ? { id: insertedChoice && clicks ? 'inserted' : 'd1', decisionId: insertedChoice && clicks ? 'inserted' : 'd1', event: 'chooseToUse', prompt: '请选择', constraints: {},
        context: { certainty: 'known', actor: 'me', skill: insertedChoice && clicks ? 'inserted' : null, sourceAction: null },
        options: insertedChoice && clicks ? [{ id: 'new', kind: 'button', label: '新询问' }] : [{ id: 'b1', kind: 'button', label: '动作1' }, { id: 'b2', kind: 'button', label: '动作2' }] } : null,
      log: { epoch: 'classic', from: nativeCursor + 1, to: logs.length, entries: logs.filter(row => row.seq > nativeCursor), truncated: false },
      experimentalLog: { epoch: 'events', source: 'eventflow', from: eventCursor + 1, to: 40 + journal.length, entries: journal.filter(row => row.seq > eventCursor), truncated: false, coverage: 'experimental_partial' },
    };
  };
  const page = {
    async act(_cdp, request) {
      assert.equal(locked, true); requests.push(request); events.push('act');
      if (failAt === requests.length) return { ok: false, code: 'rejected', message: '游戏拒绝', state: snapshot('choice') };
      clicks++; addLog(`动作${clicks}`);
      return { ok: true, action: { id: request.id, label: '动作' }, state: snapshot(clicks >= actionSteps ? 'running' : 'choice') };
    },
    async observe() {
      assert.equal(locked, true); events.push('observe');
      if (clicks < actionSteps) return snapshot('choice');
      if (!settled) { settled = true; addLog('中途插入技'); return snapshot(settleState); }
      const next = reads[Math.min(readIndex++, reads.length - 1)];
      if (next instanceof Error) throw next;
      addLog('后续响应');
      return typeof next === 'function' ? next(snapshot('running')) : snapshot(next);
    },
    async effects() { return { epoch: 'effects', actions: [] }; },
    async commitLogs(_cdp, cursor) { assert.equal(locked, true); events.push('commit'); commits.push(cursor); nativeCursor = cursor.to; eventCursor = cursor.eventTo; return { ok: true }; },
  };
  const session = {
    sessionDir: () => 'memory',
    async withLock(_name, work) { assert.equal(locked, false); locked = true; events.push('lock'); try { return await work(); } finally { locked = false; events.push('unlock'); } },
    async connect() { events.push('connect'); return { cdp: { close() { events.push('close'); } }, state: { evidenceDirectory: 'memory' } }; },
    async appendEvidence(_name, row) { evidence.push(row); },
  };
  const requireFixture = name => {
    if (name === 'node:fs') return { existsSync: () => false };
    if (['../src/native-session.cjs', '../src/session.cjs'].includes(name)) return session;
    if (['../src/native-setup.cjs', '../src/setup.cjs'].includes(name)) return {};
    if (name === '../src/page.cjs') return page;
    if (name === '../src/notification.cjs') return {
      beginOperation() { assert.equal(locked, true); events.push('begin'); },
      acknowledge(_dir, _session, state) { assert.equal(locked, true); events.push('ack'); acks.push(state); },
      read: () => ({ enabled: true }), ensureWorker: () => ({ enabled: true, status: 'armed' }),
    };
    if (name === '../src/display-config.cjs') return { ...realRequire(name), read: () => ({ logs: 'experimental', state: 'auto' }) };
    if (name === '../src/display-feedback.cjs') return { prepare: (_dir, _value, options) => ({ options, commit() { events.push('display-commit'); } }) };
    if (name === '../src/play.cjs') { const real = realRequire(name); return { ...real, executePlay(plan, adapter, options) { playOptions.push(options); return real.executePlay(plan, adapter, options); } }; }
    if (name === '../src/act-wait.cjs') { const real = realRequire(name); return { ...real, waitAfterAction(output, adapter, options) {
      waitOptions.push(options); return real.waitAfterAction(output, { ...adapter, now: () => clock, sleep: async ms => { assert.equal(locked, true); clock += ms; } }, options);
    } }; }
    return realRequire(name);
  };
  const module = { exports: {} }, processStub = { exitCode: 0 };
  vm.runInContext(fs.readFileSync(filename, 'utf8'), vm.createContext({ module, exports: module.exports, require: requireFixture, process: processStub, Buffer, setTimeout, clearTimeout,
    console: { log(value) { events.push('print'); emitted.push(value); addLog('输出后新事件'); } },
  }), { filename });
  return { ...module.exports, events, emitted, requests, commits, acks, evidence, playOptions, waitOptions, processStub };
}

const args = (expression = 'act(b1)') => ['play', expression, '--at', 'game:0', '--interval-ms', '0', '--wait'];

test('play wait uses the real executor under one lock and commits complete independent logs once after final output', async () => {
  const f = fixture({ actionSteps: 2 });
  await f.main([...args('act(b1) | act(b2)'), '--seconds', '7', '--wait-seconds', '2', '--json']);
  const output = JSON.parse(f.emitted[0]);
  assert.equal(output.value, 1); assert.equal(output.status, 'completed'); assert.equal(output.wait.status, 'ready');
  assert.equal(output.steps.length, 2); assert.equal(f.requests.length, 2);
  assert.equal(f.playOptions[0].timeoutMs, 7000); assert.equal(f.playOptions[0].deferFinalWait, true);
  assert.equal(f.waitOptions[0].seconds, 2);
  assert.match(JSON.stringify(output.state.log.entries), /中途插入技/);
  assert.match(JSON.stringify(output.state.log.entries), /后续响应/);
  assert.doesNotMatch(JSON.stringify(output.state.log.entries), /输出后新事件/);
  for (const event of ['lock', 'connect', 'begin', 'print', 'commit', 'close', 'unlock']) assert.equal(f.events.filter(value => value === event).length, 1, event);
  assert.equal(f.commits[0].epoch, 'classic'); assert.equal(f.commits[0].eventEpoch, 'events');
  assert.equal(f.commits[0].eventTo - f.commits[0].to, 40);
  assert.equal(f.commits[0].eventTo, output.state.log.to);
  assert.equal(f.acks.length, 1); assert.equal(f.acks[0].revision, output.state.revision);
  assert.ok(f.events.indexOf('commit') > f.events.indexOf('print'));
  assert.equal(f.evidence[0].output.state.log.entries.length, 5);
});

test('play wait accepts a completed last step crossing phase and stops at the next choice, death or game over', async () => {
  for (const state of ['choice', 'dead', 'over']) {
    const f = fixture({ finalPhase: 'phaseDiscard', reads: [state] });
    await f.main([...args(), '--json']);
    const output = JSON.parse(f.emitted[0]);
    assert.equal(output.value, 1); assert.equal(output.status, 'completed'); assert.equal(output.wait.reason, state);
    assert.equal(output.steps[0].value, 1); assert.equal(f.requests.length, 1);
  }
});

test('the final new choice is delivered immediately and never auto-answered', async () => {
  const f = fixture({ settleState: 'choice', insertedChoice: true });
  await f.main([...args(), '--json']);
  const output = JSON.parse(f.emitted[0]);
  assert.equal(output.value, 1); assert.equal(output.wait.status, 'ready');
  assert.equal(output.state.choice.id, 'inserted'); assert.equal(f.requests.length, 1);
  assert.equal(f.events.filter(event => event === 'observe').length, 2);
});

test('mid-plan inserted choices and failed actions keep their original result and skip appended wait', async () => {
  for (const setup of [{ actionSteps: 2, insertedChoice: true }, { failAt: 1 }]) {
    const f = fixture(setup);
    await f.main([...args('act(b1) > act(b2)'), '--json']);
    const output = JSON.parse(f.emitted[0]);
    assert.equal(output.ok, false); assert.equal(output.wait.status, 'skipped');
    assert.equal(f.requests.length, 1); assert.equal(output.actionOutcome, undefined);
    if (setup.insertedChoice) { assert.equal(output.code, 'unexpected_choice'); assert.equal(output.remaining, 'act(b2)'); }
    else { assert.equal(output.steps[0].code, 'rejected'); assert.equal(output.steps[1].status, 'skipped'); }
  }
});

test('an earlier failed group followed by an accepted last action returns failed without tail polling', async () => {
  const f = fixture();
  await f.main([...args('act(missing) | act(b1)'), '--json']);
  const output = JSON.parse(f.emitted[0]);
  assert.equal(output.ok, false); assert.equal(output.value, 0); assert.equal(output.status, 'failed');
  assert.equal(output.wait.status, 'skipped'); assert.equal(output.state.state, 'running');
  assert.deepEqual(output.steps.map(step => step.value), [0, 1]);
  assert.equal(f.requests.length, 1); assert.equal(f.events.filter(event => event === 'observe').length, 2);
});

test('play timeout reports successful steps and fresh running state in both JSON and experimental text', async () => {
  for (const json of [true, false]) {
    const f = fixture({ reads: ['running'] });
    await f.main([...args(), '--wait-seconds', '1', '--state_hide', ...(json ? ['--json'] : [])]);
    if (json) { const output = JSON.parse(f.emitted[0]); assert.equal(output.value, 1); assert.equal(output.ok, true); assert.equal(output.wait.status, 'timeout'); assert.equal(output.stateFresh, true); }
    else { assert.match(f.emitted[0], /^play 1/m); assert.match(f.emitted[0], /等待超时，当前 running/); assert.match(f.emitted[0], /中途插入技/); }
    assert.equal(f.requests.length, 1); assert.equal(f.commits.length, 1);
  }
});

test('play wait read errors and each log/session epoch change keep successful steps without stale acknowledgement or log consumption', async () => {
  for (const next of [Error('disconnect'), state => ({ ...state, revision: 'other:1' }), state => ({ ...state, log: { ...state.log, epoch: 'other' } }), state => ({ ...state, experimentalLog: { ...state.experimentalLog, epoch: 'other' } })]) {
    const f = fixture({ reads: [next] });
    await f.main([...args(), '--json']);
    const output = JSON.parse(f.emitted[0]);
    assert.equal(output.ok, false); assert.equal(output.value, 1); assert.equal(output.steps[0].value, 1);
    assert.equal(output.actionOutcome, 'completed'); assert.equal(output.wait.status, 'error'); assert.equal(output.stateFresh, false);
    assert.equal(f.requests.length, 1); assert.equal(f.acks.length, 0); assert.equal(f.commits.length, 0);
    assert.equal(f.processStub.exitCode, 1);
  }
  const f = fixture({ reads: [Error('disconnect')] });
  await f.main([...args(), '--state_hide']);
  assert.match(f.emitted[0], /1\. 1 act\(b1\)/); assert.match(f.emitted[0], /等待失败.*不要重放动作/);
});

test('play wait validates flags before any connection and preserves default and maximum separate budgets', async () => {
  for (const argv of [args().filter(value => value !== '--wait').concat(['--wait-seconds', '5']), ...['0', '61', 'NaN', '1.5'].map(seconds => args().concat(['--wait-seconds', seconds])), args().concat(['--wait-seconds'])]) {
    const f = fixture(); await assert.rejects(f.main(argv)); assert.equal(f.events.length, 0);
  }
  for (const seconds of [undefined, '60']) {
    const f = fixture(); await f.main([...args(), '--json', ...(seconds ? ['--wait-seconds', seconds] : [])]);
    assert.equal(JSON.parse(f.emitted[0]).wait.seconds, seconds ? 60 : 15);
    assert.equal(f.playOptions[0].timeoutMs, 30000);
  }
});
