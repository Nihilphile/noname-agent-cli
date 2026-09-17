'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const feedback = require('../src/display-feedback.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-state-auto-'));
  t.after(() => { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); });
  return dir;
}
const snapshot = (phaseId = 'p1', epoch = 'game', extra = {}) => ({
  revision: `${epoch}:1`, phase: 'phaseUse', phaseId: `${epoch}:phaseUse:${phaseId}`,
  actor: 'me', state: 'choice', me: { id: 'me', name: 'any-general' }, players: [],
  choice: { event: 'chooseToUse', prompt: '请选择', options: [] },
  log: { entries: [{ seq: 1, text: '日志' }] }, ...extra,
});

test('only successfully printed text consumes the first own-phase decision', t => {
  const dir = fixture(t), state = Object.freeze(snapshot());
  assert.equal(feedback.prepare(dir, state, { state: 'auto' }).options.state, 'show');
  feedback.prepare(dir, state, { state: 'auto' }, { json: true }).commit();
  feedback.prepare(dir, { ok: false, state }, { state: 'auto' }).commit();
  const staleBefore = feedback.prepare(dir, { state, stateFresh: false }, { state: 'auto' });
  assert.equal(staleBefore.options.state, 'show'); staleBefore.commit();
  feedback.prepare(dir, state, { state: 'hide' }).commit();
  assert.equal(fs.existsSync(path.join(dir, 'display-feedback.json')), false);
  const first = feedback.prepare(dir, state, { state: 'auto' });
  assert.equal(first.options.state, 'show'); first.commit();
  assert.equal(feedback.prepare(dir, state, { state: 'auto' }).options.state, 'hide');
  assert.equal(feedback.prepare(dir, { state, stateFresh: false }, { state: 'auto' }).options.state, 'show');
  const staleRunning = { state: { ...state, state: 'running', choice: null }, stateFresh: false };
  assert.equal(feedback.prepare(dir, staleRunning, { state: 'auto' }).options.state, 'show');
  assert.equal(state.me.name, 'any-general'); assert.equal(state.log.entries.length, 1);
});

test('own turn shows each play phase once and hides the rest of that turn', t => {
  const dir = fixture(t), original = snapshot();
  feedback.prepare(dir, original, { state: 'show' }).commit();
  assert.equal(feedback.prepare(dir, original, { state: 'auto' }).options.state, 'hide');
  assert.equal(feedback.prepare(dir, original, { state: 'show' }).options.state, 'show');

  const extra = feedback.prepare(dir, snapshot('extra'), { state: 'auto' });
  assert.equal(extra.options.state, 'show'); extra.commit();
  assert.equal(feedback.prepare(dir, snapshot('extra'), { state: 'auto' }).options.state, 'hide');

  const running = snapshot('third', 'game', { state: 'running', choice: null });
  assert.equal(feedback.prepare(dir, running, { state: 'auto' }).options.state, 'hide');
  const firstDecision = feedback.prepare(dir, snapshot('third'), { state: 'auto' });
  assert.equal(firstDecision.options.state, 'show'); firstDecision.commit();

  const ending = snapshot('ignored', 'game', { phase: 'phaseJieshu', phaseId: null, choice: { event: 'chooseControl', prompt: '战帅选择', options: [] } });
  assert.equal(feedback.prepare(dir, ending, { state: 'auto' }).options.state, 'hide');
});

test('responses outside our turn always show, including during another phaseUse', t => {
  const dir = fixture(t);
  const response = snapshot('other-turn', 'game', { actor: 'other' });
  for (let n = 0; n < 3; n++) {
    const prepared = feedback.prepare(dir, response, { state: 'auto' });
    assert.equal(prepared.options.state, 'show'); prepared.commit();
  }
  assert.equal(fs.existsSync(path.join(dir, 'display-feedback.json')), false);
});

test('new game epoch resets receipts and separate sessions keep separate first feedback', t => {
  const a = fixture(t), b = fixture(t);
  feedback.prepare(a, snapshot(), { state: 'auto' }).commit();
  assert.equal(feedback.prepare(b, snapshot(), { state: 'auto' }).options.state, 'show');
  const next = feedback.prepare(a, snapshot('p1', 'new-game'), { state: 'auto' });
  assert.equal(next.options.state, 'show'); next.commit();
  const persisted = JSON.parse(fs.readFileSync(path.join(a, 'display-feedback.json'), 'utf8'));
  assert.equal(persisted.epoch, 'new-game'); assert.deepEqual(persisted.shownPhases, ['new-game:phaseUse:p1']);
});

test('unknown context and setup/dead/over snapshots conservatively show', t => {
  const dir = fixture(t);
  for (const state of [
    { ...snapshot(), phaseId: null }, { ...snapshot(), phaseId: 'other:phaseUse:p1' },
    { ...snapshot(), phase: null, phaseId: null }, { ...snapshot(), actor: null },
    { ...snapshot(), me: { name: 'missing-id' } }, { ...snapshot(), players: undefined },
    ...['setup', 'dead', 'over'].map(status => snapshot('p1', 'game', { state: status, choice: null })),
  ]) {
    for (let n = 0; n < 2; n++) { const p = feedback.prepare(dir, state, { state: 'auto' }); assert.equal(p.options.state, 'show'); p.commit(); }
  }
  assert.equal(fs.existsSync(path.join(dir, 'display-feedback.json')), false);
});

test('corrupt presentation receipt fails open and is replaced only after feedback is shown', t => {
  const dir = fixture(t), file = path.join(dir, 'display-feedback.json');
  fs.writeFileSync(file, '{broken');
  const p = feedback.prepare(dir, snapshot(), { state: 'auto' });
  assert.equal(p.options.state, 'show'); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  p.commit(); assert.equal(feedback.prepare(dir, snapshot(), { state: 'auto' }).options.state, 'hide');
});
