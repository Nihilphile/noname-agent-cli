'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-state-auto-cli-'));
  t.after(() => { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); });
  const filename = path.resolve(__dirname, '../bin/noname.cjs'), realRequire = createRequire(filename);
  const realDisplayConfig = realRequire('../src/display-config.cjs');
  const emitted = [], evidence = [], acks = [], commits = [];
  let current, actResult, observeCount = 0, failPrint = false;
  const make = (id, epoch = 'game', extra = {}) => ({ state: 'choice', revision: `${epoch}:1`, phase: 'phaseUse', phaseId: id ? `${epoch}:phaseUse:${id}` : null,
    mode: 'versus', submode: 'two', round: 1, actor: 'me',
    me: { id: 'me', name: 'any-general', label: '自己', identity: {}, hand: [], equipment: [], judgments: [] }, players: [], victory: '胜利条件',
    choice: { event: 'chooseToUse', prompt: '请选择', constraints: {}, options: [{ id: 'c1', kind: 'card', label: '杀' }] },
    result: { outcome: 'ongoing' }, log: { epoch: 'log', from: 1, to: 1, entries: [{ seq: 1, text: '持续战报' }] }, ...extra });
  current = make('p1');
  const page = {
    async observe() { observeCount++; return current; },
    async act() { return actResult || { ok: true, action: { id: 'ok', label: '确定' }, state: current }; },
    async commitLogs(_cdp, value) { commits.push(value); return { ok: true }; },
  };
  const session = { sessionDir: () => dir, async withLock(_name, work) { return work(); }, async connect() { return { cdp: { close() {} }, state: { evidenceDirectory: dir } }; }, async appendEvidence(_name, row) { evidence.push(row); } };
  const notification = { beginOperation() {}, acknowledge(_dir, _session, state) { acks.push(state); }, read: () => null };
  function loadCli() {
    const requireFixture = name => {
      if (name === 'node:fs') return { existsSync: () => false };
      if (['../src/native-session.cjs', '../src/session.cjs'].includes(name)) return session;
      if (['../src/native-setup.cjs', '../src/setup.cjs'].includes(name)) return {};
      if (name === '../src/page.cjs') return page;
      if (name === '../src/notification.cjs') return notification;
      if (name === '../src/display-config.cjs') return { ...realDisplayConfig, read: () => ({ logs: 'compact', state: 'auto' }) };
      return realRequire(name);
    };
    const module = { exports: {} };
    vm.runInContext(fs.readFileSync(filename, 'utf8'), vm.createContext({ module, exports: module.exports, require: requireFixture, process: { exitCode: 0 }, Buffer, setTimeout, clearTimeout,
      console: { log(value) { if (failPrint) throw Error('output failed'); emitted.push(value); } } }), { filename });
    return module.exports.main;
  }
  return { dir, make, emitted, evidence, acks, commits, main: argv => loadCli()(argv), set: value => { current = value; }, setAct: value => { actResult = value; }, failPrint: value => { failPrint = value; }, get observeCount() { return observeCount; } };
}

test('JSON and text share the first board receipt while observe always shows on demand', async t => {
  const f = fixture(t);
  await f.main(['wait', '--seconds', '1', '--json']);
  const json = JSON.parse(f.emitted[0]);
  assert.equal(json.me.name, 'any-general'); assert.equal(json.mode, 'versus'); assert.equal(json.submode, 'two');
  assert.equal(json.round, 1); assert.equal(json.phase, 'phaseUse'); assert.equal(json.actor, 'me');

  await f.main(['observe']);
  assert.match(f.emitted[1], /自己 自己|胜利条件/);
  assert.match(f.emitted[1], /^状态 choice \| revision game:1/);
  assert.doesNotMatch(f.emitted[1], /模式 versus|回合 1|阶段 phaseUse|行动者 me/);

  await f.main(['wait', '--seconds', '1']);
  assert.doesNotMatch(f.emitted[2], /自己 自己|胜利条件/); assert.match(f.emitted[2], /revision game:1/);
  assert.match(f.emitted[2], /c1 card 杀/); assert.match(f.emitted[2], /持续战报/); assert.match(f.emitted[2], /参与结果/);
  await f.main(['wait', '--seconds', '1', '--json']);
  const hiddenJson = JSON.parse(f.emitted[3]);
  assert.equal(hiddenJson.me, undefined); assert.equal(hiddenJson.presentation.state, 'hidden');
  assert.equal(hiddenJson.mode, 'versus'); assert.equal(hiddenJson.submode, 'two'); assert.equal(hiddenJson.round, 1);
  assert.equal(hiddenJson.phase, 'phaseUse'); assert.equal(hiddenJson.actor, 'me'); assert.equal(hiddenJson.revision, 'game:1');
  assert.equal(f.evidence[0].output.me.name, 'any-general');
  await f.main(['observe', '--json']);
  assert.equal(JSON.parse(f.emitted[4]).me.name, 'any-general');
  await f.main(['observe']);
  assert.match(f.emitted[5], /自己 自己/);
});

test('explicit state overrides remain authoritative and shown JSON records the display', async t => {
  const f = fixture(t);
  await f.main(['observe', '--state_hide', '--json']);
  assert.equal(JSON.parse(f.emitted[0]).me, undefined);
  assert.equal(fs.existsSync(path.join(f.dir, 'display-feedback.json')), false);
  await f.main(['observe', '--state_show', '--json']);
  assert.equal(JSON.parse(f.emitted[1]).me.name, 'any-general');
  assert.equal(fs.existsSync(path.join(f.dir, 'display-feedback.json')), true);

  await f.main(['observe', '--state_auto']);
  assert.doesNotMatch(f.emitted[2], /自己 自己/);
  f.set(f.make('extra-same-round'));
  await f.main(['observe', '--state_hide']);
  assert.doesNotMatch(f.emitted[3], /自己 自己/);
  await f.main(['observe', '--state_show']);
  assert.match(f.emitted[4], /自己 自己/);
  await f.main(['observe', '--state_auto']);
  assert.doesNotMatch(f.emitted[5], /自己 自己/);
});

test('wait and act share own-turn cadence and hide off-turn responses; observe shows on demand', async t => {
  const f = fixture(t);
  await f.main(['wait', '--seconds', '1']);
  await f.main(['wait', '--seconds', '1']);
  await f.main(['act', 'ok', '--at', 'game:1']);
  assert.match(f.emitted[0], /自己 自己/);
  assert.doesNotMatch(f.emitted[1], /自己 自己/);
  assert.doesNotMatch(f.emitted[2], /自己 自己/);

  f.set(f.make('ending', 'game', { phase: 'phaseJieshu', phaseId: null, choice: { event: 'chooseControl', prompt: '战帅选择', constraints: {}, options: [{ id: 'yes', kind: 'control', label: '是' }] } }));
  await f.main(['wait', '--seconds', '1']);
  assert.doesNotMatch(f.emitted[3], /自己 自己/); assert.match(f.emitted[3], /战帅选择/);

  f.set(f.make('other-phase', 'game', { actor: 'other' }));
  await f.main(['observe']); await f.main(['wait', '--seconds', '1']);
  assert.match(f.emitted[4], /自己 自己/); assert.doesNotMatch(f.emitted[5], /自己 自己/);
  await f.main(['act', 'ok', '--at', 'game:1']);
  assert.doesNotMatch(f.emitted[6], /自己 自己/);
  assert.match(f.emitted[6], /c1 card 杀/);
  assert.match(f.emitted[6], /持续战报/);
});

test('stale action and failed output do not consume the first display', async t => {
  const f = fixture(t), state = f.make('first');
  f.set(state); f.setAct({ ok: false, code: 'stale_revision', message: '已过期', state });
  await f.main(['act', 'ok', '--at', 'game:0']);
  assert.doesNotMatch(f.emitted[0], /自己 自己/);
  await f.main(['wait', '--seconds', '1']);
  assert.match(f.emitted[1], /自己 自己/);

  f.set(f.make('output-failure')); f.failPrint(true);
  await assert.rejects(f.main(['wait', '--seconds', '1', '--json']), /output failed/);
  f.failPrint(false); await f.main(['wait', '--seconds', '1']);
  assert.match(f.emitted[2], /自己 自己/);
});

test('extra phase, new epoch and bad receipt show automatically; unknown context needs observe', async t => {
  const f = fixture(t);
  await f.main(['wait', '--seconds', '1']);
  for (const [id, epoch] of [['extra', 'game'], ['p1', 'newgame']]) {
    f.set(f.make(id, epoch)); await f.main(['wait', '--seconds', '1']);
    assert.match(f.emitted.at(-1), /自己 自己/);
  }
  fs.writeFileSync(path.join(f.dir, 'display-feedback.json'), '{broken');
  f.set(f.make('corrupt', 'third')); await f.main(['wait', '--seconds', '1']);
  assert.match(f.emitted.at(-1), /自己 自己/);
  f.set(f.make(null, 'third')); await f.main(['wait', '--seconds', '1']); await f.main(['observe']);
  assert.doesNotMatch(f.emitted.at(-2), /自己 自己/); assert.match(f.emitted.at(-1), /自己 自己/);
});

test('detail remains on demand and explicit hide still wins', async t => {
  const f = fixture(t);
  await f.main(['observe']);
  await f.main(['observe', '--detail']);
  assert.match(f.emitted[1], /自己 自己/);
  await f.main(['observe', '--detail', '--state_hide', '--json']);
  assert.equal(JSON.parse(f.emitted[2]).me, undefined);
  await f.main(['observe', '--detail', '--state_auto']);
  assert.doesNotMatch(f.emitted[3], /自己 自己/);
});
