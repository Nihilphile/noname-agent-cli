'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-play-experimental-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.resolve(__dirname, '../bin/noname.cjs');
  const realRequire = createRequire(filename);
  const realDisplayConfig = realRequire('../src/display-config.cjs');
  const emitted = [], commits = [], evidence = [];
  const processStub = { exitCode: 0, pid: process.pid };
  let current, playOutput;

  const page = {
    async observe() { return current; },
    async act() { throw Error('unexpected act'); },
    async effects() { return { epoch: 'effects', actions: [] }; },
    async commitLogs(_cdp, request) { commits.push(request); return { ok: true }; },
  };
  const session = {
    sessionDir: () => dir,
    async withLock(_name, work) { return work(); },
    async connect() { return { cdp: { close() {} }, state: { evidenceDirectory: dir } }; },
    async appendEvidence(_name, row) { evidence.push(row); },
  };
  const play = {
    parsePlay(source) { return { source }; },
    async executePlay() { return playOutput; },
  };
  const notifications = { beginOperation() {}, acknowledge() {}, read: () => null };
  const displayConfig = { ...realDisplayConfig, read: () => ({ logs: 'experimental', state: 'auto' }) };
  const requireFixture = name => {
    if (['../src/native-session.cjs', '../src/session.cjs'].includes(name)) return session;
    if (['../src/native-setup.cjs', '../src/setup.cjs'].includes(name)) return {};
    if (name === '../src/page.cjs') return page;
    if (name === '../src/play.cjs') return play;
    if (name === '../src/notification.cjs') return notifications;
    if (name === '../src/display-config.cjs') return displayConfig;
    return realRequire(name);
  };
  const module = { exports: {} };
  vm.runInContext(fs.readFileSync(filename, 'utf8'), vm.createContext({
    module, exports: module.exports, require: requireFixture, process: processStub,
    Buffer, setTimeout, clearTimeout, console: { log(value) { emitted.push(value); } },
  }), { filename });
  return {
    dir, emitted, commits, evidence, processStub,
    main: module.exports.main,
    setState(value) { current = value; },
    setPlay(value) { playOutput = value; current = value.state; },
  };
}

function state(epoch, phase, { actor = 'me', revision = 1 } = {}) {
  const me = { id: 'me', name: 'hero', label: '自己', identity: { label: '主公' }, hp: 4, maxHp: 4, armor: 0,
    hand: [{ id: 'c1', label: '杀', suit: 'spade', number: 7 }], equipment: [], judgments: [], marks: [] };
  const context = { round: 1, turn: { id: `${epoch}:turn:1`, actor: { id: actor, label: actor === 'me' ? '自己' : '对手' } },
    phase: { id: `${epoch}:phaseUse:${phase}`, name: 'phaseUse' } };
  return {
    state: 'choice', revision: `${epoch}:${revision}`, mode: 'identity', round: 1, phase: 'phaseUse',
    phaseId: `${epoch}:phaseUse:${phase}`, actor, me, players: [], victory: '胜利条件',
    choice: { id: `choice-${revision}`, event: 'chooseToUse', prompt: '请选择', constraints: {}, options: [{ id: 'next', kind: 'button', label: '继续' }] },
    result: { outcome: 'ongoing' },
    log: { epoch: `classic-${epoch}`, from: 2, to: 4, truncated: false, entries: [{ seq: 4, text: '经典增量' }] },
    experimentalLog: { epoch: `event-${epoch}`, from: 7, to: 7, truncated: false, coverage: 'experimental_partial', context, players: [], entries: [
      { seq: 7, kind: 'operation', actor: { id: 'me', label: '自己' }, operationId: 'op-1', operation: { kind: 'card', id: 'sha', label: '杀' }, targets: [], context },
    ] },
  };
}

function outcome(snapshot, extra = {}) {
  return { kind: 'play', ok: true, status: 'completed', value: 1,
    steps: [{ raw: 'act(next)', status: 'completed', value: 1, actions: [{ id: 'next', label: '继续' }] }],
    state: snapshot, remaining: '', ...extra };
}

test('successful play text consumes the first own-phase board and commits both log streams once', async t => {
  const f = fixture(t), first = state('gameA', 'p1');
  f.setPlay(outcome(first));
  await f.main(['play', 'act(next)', '--at', 'gameA:0', '--interval-ms', '0']);
  assert.match(f.emitted[0], /^play 1/m);
  assert.match(f.emitted[0], /自己 自己/);
  assert.match(f.emitted[0], /实验战报（部分事件）/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.commits)), [{ epoch: 'classic-gameA', to: 4, eventEpoch: 'event-gameA', eventTo: 7 }]);

  const later = state('gameA', 'p1', { revision: 2 });
  f.setPlay(outcome(later));
  await f.main(['play', 'act(next)', '--at', 'gameA:1', '--interval-ms', '0']);
  assert.doesNotMatch(f.emitted[1], /自己 自己/);
  assert.match(f.emitted[1], /场上概览已隐藏/);
  assert.equal(f.commits.length, 2);

  f.setState(later);
  await f.main(['observe']);
  assert.equal(f.commits.length, 2, 'observe must not advance either log cursor');
});

test('JSON, failed, paused, and stale play feedback leave the first-display receipt available', async t => {
  const f = fixture(t);
  const cases = [
    { phase: 'json', argv: ['--json'], extra: {} },
    { phase: 'failed', argv: [], extra: { ok: false, status: 'failed', value: 0, code: 'option_unavailable' } },
    { phase: 'paused', argv: [], extra: { ok: false, status: 'paused', value: null, code: 'unexpected_choice' } },
    { phase: 'stale', argv: [], extra: { ok: true, stateFresh: false } },
  ];
  for (const [index, item] of cases.entries()) {
    const snapshot = state(`case${index}`, item.phase);
    f.setPlay(outcome(snapshot, item.extra));
    await f.main(['play', 'act(next)', '--at', `${snapshot.revision}`, '--interval-ms', '0', ...item.argv]);
    f.processStub.exitCode = 0;
    f.setState(snapshot);
    await f.main(['observe']);
    assert.match(f.emitted.at(-1), /自己 自己/, `${item.phase} must not consume the text-board receipt`);
  }
});

test('off-turn responses always show and a new game epoch gets an independent receipt', async t => {
  const f = fixture(t), response = state('response', 'other', { actor: 'other' });
  f.setState(response);
  await f.main(['observe']);
  await f.main(['observe']);
  assert.match(f.emitted[0], /自己 自己/);
  assert.match(f.emitted[1], /自己 自己/);

  for (const epoch of ['epochA', 'epochB']) {
    const snapshot = state(epoch, 'same-suffix');
    f.setPlay(outcome(snapshot));
    await f.main(['play', 'act(next)', '--at', snapshot.revision, '--interval-ms', '0']);
    assert.match(f.emitted.at(-1), /自己 自己/, `${epoch} must have its own first display`);
  }
  assert.deepEqual(f.commits.map(x => [x.epoch, x.eventEpoch]), [
    ['classic-epochA', 'event-epochA'], ['classic-epochB', 'event-epochB'],
  ]);
});
