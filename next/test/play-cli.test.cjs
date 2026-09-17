'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(t, { realPlay = false, roomGuest = false, evidenceFailure = false, formatFailure = false, savedEvidence = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-play-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.resolve(__dirname, '../bin/noname.cjs');
  const realRequire = createRequire(filename);
  const emitted = [], evidence = [], parsed = [], executions = [], acts = [], commits = [], acknowledgements = [];
  let stdin = '', locks = 0, connections = 0, closes = 0, beginOperations = 0, feedbackCommits = 0;
  const processStub = { exitCode: 0, pid: process.pid };
  const state = { state: 'choice', revision: 'game:2', mode: 'identity', round: 1, phase: 'phaseUse', phaseId: 'game:phaseUse:1', actor: 'p1',
    me: { id: 'p1', name: 'hero', label: '自己', identity: {}, hp: 4, maxHp: 4, armor: 0, hand: [], equipment: [], judgments: [] }, players: [],
    choice: { id: 'choice-1', decisionId: 'decision-1', event: 'chooseToUse', prompt: '继续选择', constraints: {},
      context: { certainty: 'known', actor: 'p1', skill: null, sourceAction: null }, options: [{ id: 'ok', kind: 'button', label: '继续' }] },
    log: { epoch: 'journal', from: 7, to: 9, truncated: false, entries: [] } };
  let currentState = state, afterActState = null;
  let playOutput = { kind: 'play', ok: true, status: 'completed', value: 1,
    steps: [{ raw: '无中', status: 'completed', value: 1, card: { id: 'c17', label: '无中生有' }, actions: [{ id: 'c17' }] }],
    state, remaining: '' };
  const fakeFs = {
    existsSync(target) { return !!savedEvidence && String(target).endsWith('evidence.jsonl'); },
    readFileSync(target) { if (target === 0) return stdin; if (String(target).endsWith('evidence.jsonl')) return savedEvidence; throw Object.assign(Error('missing'), { code: 'ENOENT' }); },
  };
  const page = {
    async observe() { return currentState; },
    async act(_cdp, request) { acts.push(request); if (afterActState) { currentState = afterActState; afterActState = null; } return { ok: true, action: { id: request.id, label: request.id }, state: currentState }; },
    async effects() { return { epoch: 'game', actions: [] }; },
    async commitLogs(_cdp, value) { commits.push(value); return { ok: true }; },
  };
  const session = {
    read: () => roomGuest ? { room: { id: 'table', role: 'guest', controller: 'agent' } } : null,
    sessionDir: () => dir,
    async withLock(_name, work) { locks++; return work(); },
    async connect() { connections++; return { cdp: { close() { closes++; } }, state: { evidenceDirectory: dir, startedAt: 'now' } }; },
    async appendEvidence(_name, row) { if (evidenceFailure) throw Error('disk full'); evidence.push(row); },
  };
  const notifications = {
    beginOperation() { beginOperations++; },
    acknowledge(_dir, _session, snapshot) { acknowledgements.push(snapshot); },
    read() { return null; },
  };
  const play = {
    parsePlay(text) { parsed.push(text); return { source: text, groups: [] }; },
    async executePlay(plan, adapter, options) {
      executions.push({ plan, adapter, options });
      assert.equal(typeof adapter.observe, 'function'); assert.equal(typeof adapter.act, 'function');
      assert.equal(typeof adapter.effects, 'function'); assert.equal(typeof adapter.sleep, 'function');
      return playOutput;
    },
  };
  const displayConfig = {
    read: () => ({ logs: 'compact', state: 'show' }),
    resolve: value => ({ ...value, raw: false }),
    project: value => value,
  };
  const displayFeedback = { prepare(_dir, _value, display) { if (formatFailure) throw Error('format failed'); return { options: display, commit() { feedbackCommits++; } }; } };
  const requireFixture = name => {
    if (name === 'node:fs') return fakeFs;
    if (['../src/native-session.cjs', '../src/session.cjs'].includes(name)) return session;
    if (['../src/native-setup.cjs', '../src/setup.cjs'].includes(name)) return {};
    if (name === '../src/page.cjs') return page;
    if (name === '../src/play.cjs') return realPlay ? realRequire(name) : play;
    if (name === '../src/notification.cjs') return notifications;
    if (name === '../src/display-config.cjs') return displayConfig;
    if (name === '../src/display-feedback.cjs') return displayFeedback;
    return realRequire(name);
  };
  const module = { exports: {} };
  vm.runInContext(fs.readFileSync(filename, 'utf8'), vm.createContext({ module, exports: module.exports, require: requireFixture,
    process: processStub, Buffer, setTimeout, clearTimeout, console: { log(value) { emitted.push(value); } } }), { filename });
  return { ...module.exports, state, emitted, evidence, parsed, executions, acts, commits, acknowledgements, processStub,
    setStdin(value) { stdin = value; }, setOutput(value) { playOutput = value; }, setState(value) { currentState = value; }, setAfterActState(value) { afterActState = value; },
    counts: () => ({ locks, connections, closes, beginOperations, feedbackCommits }) };
}

test('play forwards expression, revision, timeout and animation interval under the operation lock', async t => {
  const f = fixture(t);
  await f.main(['play', '无中 > act(confirm)', '--at', 'game:1', '--seconds', '12', '--interval-ms', '750', '--json']);
  assert.deepEqual(f.parsed, ['无中 > act(confirm)']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.executions[0].options)), { at: 'game:1', timeoutMs: 12000, intervalMs: 750 });
  assert.deepEqual(f.counts(), { locks: 1, connections: 1, closes: 1, beginOperations: 1, feedbackCommits: 1 });
  assert.equal(f.evidence.findLast(row => row.command !== 'play_progress').command, 'play');
  assert.equal(f.evidence.findLast(row => row.command !== 'play_progress').input['interval-ms'], '750');
  assert.equal(f.acknowledgements[0], f.state);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].epoch, 'journal'); assert.equal(f.commits[0].to, 9);
  assert.equal(JSON.parse(f.emitted[0]).steps[0].card.id, 'c17');
});

test('room guest play reaches the normal executor under its session lock', async t => {
  const f = fixture(t, { roomGuest: true });
  await f.main(['play', 'act(ok)', '--at', 'game:2', '--session', 'guest-a', '--json']);
  assert.equal(f.executions.length, 1); assert.equal(f.counts().locks, 1);
  assert.equal(f.counts().connections, 1); assert.equal(JSON.parse(f.emitted[0]).ok, true);
});

test('play --stdin uses the same path and applies the documented defaults', async t => {
  const f = fixture(t); f.setStdin('  顺[殷华] | 杀[fp3]\r\n');
  await f.main(['play', '--stdin', '--at', 'game:8', '--json']);
  assert.equal(f.parsed[0], '  顺[殷华] | 杀[fp3]\r\n');
  assert.deepEqual(JSON.parse(JSON.stringify(f.executions[0].options)), { at: 'game:8', timeoutMs: 30000, intervalMs: 500 });
});

test('play validates exclusive input, bounds and unsupported act flags without executing', async t => {
  const f = fixture(t);
  await assert.rejects(f.main(['play', '杀', '--at', 'r', '--wait-seconds', '5']), /只用于 act --wait 或 play --wait/);
  await assert.rejects(f.main(['play', '杀', '--at', 'r', '--seconds', '0']), /1\.\.60/);
  await assert.rejects(f.main(['play', '杀', '--at', 'r', '--interval-ms', '5001']), /0\.\.5000/);
  assert.deepEqual(f.counts(), { locks: 0, connections: 0, closes: 0, beginOperations: 0, feedbackCommits: 0 });
  await assert.rejects(f.main(['play', '杀', '--stdin', '--at', 'r']), /--stdin 单独读取/);
  await assert.rejects(f.main(['play', '杀', '--at', 'r', '--to', 'p2']), /play 中请写入 act/);
  await assert.rejects(f.main(['act', 'c1', '--at', 'r', '--interval-ms', '1']), /只用于 play/);
  assert.equal(f.executions.length, 0); assert.equal(f.counts().locks, 0); assert.equal(f.counts().connections, 0);
});

test('failed play keeps partial steps, remaining text and final state in JSON evidence', async t => {
  const f = fixture(t);
  const partial = { kind: 'play', ok: false, status: 'failed', value: 0, code: 'option_unavailable', message: '目标不可选',
    steps: [{ raw: '无中', status: 'completed', value: 1, card: { id: 'c17' } }, { raw: '杀[fp3]', status: 'failed', value: 0, code: 'target_unavailable' },
      { raw: 'act(confirm)', status: 'skipped', value: null }], state: f.state, remaining: 'act(confirm) | 顺[殷华]' };
  f.setOutput(partial);
  await f.main(['play', '无中 > 杀[fp3] > act(confirm) | 顺[殷华]', '--at', 'game:1', '--json']);
  const rendered = JSON.parse(f.emitted[0]);
  assert.equal(rendered.ok, false); assert.equal(rendered.steps.length, 3); assert.equal(rendered.remaining, partial.remaining);
  assert.equal(f.evidence.findLast(row => row.command !== 'play_progress').output.steps[0].card.id, 'c17'); assert.equal(f.evidence.findLast(row => row.command !== 'play_progress').output.remaining, partial.remaining);
  assert.equal(f.processStub.exitCode, 1); assert.equal(f.acknowledgements.length, 1); assert.equal(f.commits.length, 1);
});

test('uncertain play state does not acknowledge notifications or advance the log cursor', async t => {
  const f = fixture(t);
  f.setOutput({ kind: 'play', ok: false, status: 'paused', value: null, code: 'action_uncertain', message: '提交结果未知',
    steps: [{ raw: '杀[fp3]', status: 'paused', value: null, code: 'action_uncertain' }], state: f.state, stateFresh: false, remaining: '杀[fp3]' });
  await f.main(['play', '杀[fp3]', '--at', 'game:1', '--json']);
  assert.equal(f.acknowledgements.length, 0); assert.equal(f.commits.length, 0);
  assert.equal(f.evidence.findLast(row => row.command !== 'play_progress').output.stateFresh, false); assert.equal(JSON.parse(f.emitted[0]).remaining, '杀[fp3]');
});

test('compact play rendering names 1, 0, skipped, waiting, actual card/actions and remaining work', t => {
  const f = fixture(t);
  const text = f.render({ kind: 'play', ok: false, status: 'paused', value: null, code: 'unexpected_choice', message: '等待额外选择', steps: [
    { raw: '无中', status: 'completed', value: 1, card: { id: 'c17' }, actions: [{ id: 'c17' }, { id: 'confirm' }] },
    { raw: '杀[fp3]', status: 'failed', value: 0, code: 'target_unavailable' },
    { raw: '诸葛连弩', status: 'skipped', value: null },
    { raw: 'act(skill)', status: 'paused', value: null, message: '需要选择' },
  ], remaining: ['诸葛连弩', 'act(skill)'] }, false, { state: 'hide', logs: 'compact' });
  assert.match(text, /^play 等待 \| unexpected_choice: 等待额外选择/m);
  assert.match(text, /1\. 1 无中 \| 牌 c17；动作 c17 → confirm/);
  assert.match(text, /2\. 0 杀\[fp3\]/); assert.match(text, /3\. 跳过 诸葛连弩/); assert.match(text, /4\. 等待 act\(skill\)/);
  assert.match(text, /剩余 诸葛连弩 \| act\(skill\)/);
  const unknown = f.render({ kind: 'play', ok: false, status: 'paused', value: null, code: 'result_unknown', message: '提交结果待核实',
    steps: [{ raw: '杀', status: 'paused', value: null, code: 'result_unknown' }], remaining: '' }, false, {});
  assert.match(unknown, /^play 未知/); assert.match(unknown, /1\. 未知 杀/);
});

test('CLI runs the real play core across > short-circuit, | continuation and a later pause', async t => {
  const f = fixture(t, { realPlay: true });
  const after = { ...f.state, revision: 'game:3', choice: { ...f.state.choice, id: 'choice-2', decisionId: 'decision-2',
    options: [{ id: 'other', kind: 'button', label: '另一选择' }] } };
  f.setAfterActState(after);
  await f.main(['play', 'act(missing) > act(skipped) | act(ok) > act(later)', '--at', 'game:2', '--interval-ms', '0']);
  const output = f.evidence.findLast(row => row.command !== 'play_progress').output;
  assert.equal(output.status, 'paused'); assert.deepEqual(output.steps.map(step => step.status), ['failed', 'skipped', 'completed', 'paused']);
  assert.equal(output.steps[2].actions[0].id, 'ok'); assert.equal(output.remaining, 'act(later)');
  assert.match(f.emitted[0], /1\. 0 act\(missing\)/); assert.match(f.emitted[0], /2\. 跳过 act\(skipped\)/);
  assert.match(f.emitted[0], /3\. 1 act\(ok\) \| 动作 ok/); assert.match(f.emitted[0], /4\. 等待 act\(later\)/); assert.match(f.emitted[0], /剩余 act\(later\)/);
});

test('legacy act still uses its original request path and lock', async t => {
  const f = fixture(t);
  await f.main(['act', 'c1', '--at', 'game:1', '--json']);
  assert.equal(f.acts.length, 1); assert.equal(f.acts[0].id, 'c1'); assert.equal(f.acts[0].at, 'game:1');
  assert.equal(f.acts[0].unselect, false); assert.equal(f.acts[0].to, undefined); assert.equal(f.acts[0].value, undefined);
  assert.equal(f.executions.length, 0); assert.equal(f.counts().locks, 1); assert.equal(f.evidence.findLast(row => row.command !== 'play_progress').command, 'act');
});

test('play keeps its action receipt on stdout when evidence or presentation fails', async t => {
  for (const flag of ['evidenceFailure', 'formatFailure']) {
    const f = fixture(t, { [flag]: true });
    await f.main(['play', '无中', '--at', 'game:2', '--json']);
    const result = JSON.parse(f.emitted[0]);
    assert.equal(f.emitted.length, 1); assert.equal(result.completedSteps, 1);
    assert.equal(result.steps[0].card.id, 'c17'); assert.ok(result.operationId);
    assert.ok(result.evidenceError || result.feedbackError);
  }
});

test('receipt recovery reads a saved progress record without connecting or dispatching', async t => {
  const progress = { command: 'play_progress', operationId: 'operation-1', output: { kind: 'play', status: 'paused', value: null, steps: [{ raw: '杀[]', status: 'paused', inFlight: { id: 'c1', status: 'unknown' } }], remaining: '结束出牌' } };
  const f = fixture(t, { savedEvidence: JSON.stringify(progress) + '\n{"interrupted":' });
  await f.main(['receipt', 'operation-1', '--json']);
  const result = JSON.parse(f.emitted[0]);
  assert.equal(result.operationId, 'operation-1'); assert.equal(result.mustObserve, true);
  assert.equal(result.steps[0].inFlight.status, 'unknown'); assert.equal(result.remaining, '结束出牌');
  assert.equal(f.counts().connections, 0); assert.equal(f.acts.length, 0);
});

test('progress evidence retains accepted raw steps before tail observation', async t => {
  const f = fixture(t, { realPlay: true });
  await f.main(['play', 'act(ok)', '--at', 'game:2', '--interval-ms', '0', '--json']);
  assert.ok(f.evidence.some(row => row.command === 'play_progress' && row.output.steps[0]?.inFlight?.status === 'unknown'));
  assert.ok(f.evidence.some(row => row.command === 'play_progress' && row.output.steps[0]?.status === 'completed'));
  assert.equal(JSON.parse(f.emitted[0]).completedSteps, 1);
});
