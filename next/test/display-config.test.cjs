'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/display-config.cjs');

test('display settings persist separately from games and single-command overrides do not change defaults', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-display-'));
  const file = path.join(dir, 'display.json');
  t.after(() => { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(dir); });
  assert.deepEqual(config.read(file), { logs: 'compact', state: 'auto' });
  config.save({ logs: 'raw', state: 'hide' }, file);
  assert.deepEqual(config.resolve(config.read(file), { compact: true, state_show: true }), { logs: 'compact', raw: false, state: 'show' });
  assert.deepEqual(config.read(file), { logs: 'classic', state: 'hide' });
  assert.throws(() => config.save({ logs: 'drop-events' }, file), /无效显示配置/);
  assert.deepEqual(config.read(file), { logs: 'classic', state: 'hide' });
  config.save(config.DEFAULTS, file);
  assert.deepEqual(config.read(file), config.DEFAULTS);
});

test('invalid settings and contradictory flags fail before game operations', () => {
  assert.throws(() => config.validate({ state: 'secret' }), /无效显示配置/);
  assert.throws(() => config.validate({ engine: 'modify' }), /无效显示配置/);
  assert.throws(() => config.validate({ constructor: 'raw' }), /无效显示配置/);
  assert.throws(() => config.resolve(config.DEFAULTS, { raw: true, compact: true }), /不能同时/);
  assert.throws(() => config.resolve(config.DEFAULTS, { 'log-mode': 'classic', raw: true }), /不能同时/);
  assert.throws(() => config.resolve(config.DEFAULTS, { 'log-mode': 'experimental', compact: true }), /不能同时/);
  assert.throws(() => config.resolve(config.DEFAULTS, { 'log-mode': 'raw' }), /必须是/);
  assert.throws(() => config.resolve(config.DEFAULTS, { state_hide: true, state_show: true }), /不能同时/);
  assert.throws(() => config.resolve(config.DEFAULTS, { state_auto: true, state_show: true }), /不能同时/);
  assert.throws(() => config.resolve(config.DEFAULTS, { state_auto: true, state_hide: true }), /不能同时/);
});

test('three log modes and legacy raw alias resolve without changing config', () => {
  assert.deepEqual(config.resolve({ logs: 'raw' }), { logs: 'classic', raw: true, state: 'auto' });
  assert.deepEqual(config.resolve({ state: 'hide' }, { state_auto: true }), { logs: 'compact', raw: false, state: 'auto' });
  const persisted = Object.freeze({ logs: 'experimental', state: 'hide' });
  assert.deepEqual(config.resolve(persisted), { logs: 'experimental', raw: false, state: 'hide' });
  assert.deepEqual(config.resolve(persisted, { 'log-mode': 'classic' }), { logs: 'classic', raw: true, state: 'hide' });
  assert.deepEqual(config.resolve(persisted, { compact: true }), { logs: 'compact', raw: false, state: 'hide' });
  assert.deepEqual(config.resolve(persisted, { raw: true }), { logs: 'classic', raw: true, state: 'hide' });
  assert.equal(persisted.logs, 'experimental');
});

test('experimental JSON substitutes only logs and respects hidden state without mutating evidence', () => {
  const original = Object.freeze({ entries: [{ seq: 4, text: '原文' }] });
  const experimental = Object.freeze({ coverage: 'experimental_partial', entries: [{ seq: 9, kind: 'operation' }] });
  const state = Object.freeze({ revision: 'e:1', state: 'choice', me: { hp: 3 }, players: [{ hp: 2 }], recent: ['原文'], log: original, experimentalLog: experimental, choice: { id: 'c1' } });
  const value = Object.freeze({ ok: false, code: 'stale_revision', state });
  const output = config.project(value, { logs: 'experimental', state: 'hide' });
  assert.equal(output.state.log, experimental);
  assert.equal(output.state.experimentalLog, undefined);
  assert.equal(output.state.recent, undefined);
  assert.deepEqual(state.recent, ['原文']);
  assert.equal(output.state.players, undefined);
  assert.equal(output.state.me, undefined);
  assert.equal(output.state.choice, state.choice);
  assert.equal(output.code, value.code);
  assert.equal(state.log, original);
  assert.equal(state.experimentalLog, experimental);
  for (const logs of ['classic', 'compact']) {
    const shown = config.project(state, { logs, state: 'show' });
    assert.equal(shown.experimentalLog, undefined);
    assert.equal(shown.log, original);
    assert.equal(shown.players, state.players);
  }
});

test('experimental missing log is explicitly unavailable and never falls back to prose', () => {
  const state = { revision: 'e:1', log: { entries: [{ seq: 1, text: '原文' }] } };
  const shown = config.project(state, { logs: 'experimental' });
  assert.equal(shown.log.available, false);
  assert.equal(shown.log.reason, 'experimental_log_unavailable');
  assert.deepEqual(shown.log.entries, []);
  assert.equal(state.log.entries[0].text, '原文');
});

test('hidden JSON keeps choices, revision, failure and exact logs without mutating evidence snapshot', () => {
  const state = Object.freeze({ revision: 'epoch:9', state: 'choice', me: { hp: 3 }, players: [{ hp: 4 }], victory: '规则', choice: { options: [{ id: 'target', label: '敌将' }] }, result: null, log: { entries: [{ seq: 9, text: '原始战报' }] } });
  const output = Object.freeze({ ok: false, code: 'unexpected_choice', completed: [{ step: 1 }], state });
  const hidden = config.project(output, { state: 'hide' });
  assert.equal(hidden.state.me, undefined);
  assert.equal(hidden.state.players, undefined);
  assert.equal(hidden.state.revision, state.revision);
  assert.equal(hidden.state.choice, state.choice);
  assert.equal(hidden.state.log, state.log);
  assert.equal(hidden.code, output.code);
  assert.equal(hidden.completed, output.completed);
  assert.equal(hidden.state.presentation.state, 'hidden');
  assert.equal(output.state.me.hp, 3);
  assert.equal(config.project(output, { state: 'show' }), output);
  const inspect = { id: 'p1', skills: ['技能'] };
  assert.equal(config.project(inspect, { state: 'hide' }), inspect);
});
