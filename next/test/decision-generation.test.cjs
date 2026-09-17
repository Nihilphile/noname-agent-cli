'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installPage } = require('../src/page.cjs');

function fixture(configure = () => {}) {
  const classes = new Set(['selectable']);
  const card = {
    name: 'sha', suit: 'spade', number: 7, isConnected: true,
    classList: { contains: value => classes.has(value) },
    closest: () => null, getClientRects: () => [{}],
  };
  const me = {
    name: 'arbitrary_character', identity: 'zhu', hp: 4, maxHp: 4,
    classList: { contains: () => false },
    getCards: zone => ['h', 'hes'].includes(zone) ? [card] : [],
    countCards: () => 1, marks: {},
  };
  const status = { paused: true, imchoosing: true, event: { name: 'chooseToUse', step: 0, player: me } };
  const game = {
    me, players: [me], dead: [], over() {},
    pause() { status.paused = true; },
    resume() { status.paused = false; },
  };
  configure(game, status);
  const input = { game, _status: status, ui: {}, lib: { translate: {}, skill: {} }, get: { mode: () => 'doudizhu', plainText: value => value } };
  const context = vm.createContext({ window: {}, document: {}, getComputedStyle: () => ({ visibility: 'visible' }) });
  const install = vm.runInContext(`(${installPage.toString()})`, context);
  const api = install(input);
  return { api, game, status, classes, install: () => install(input) };
}

test('same event and step re-entering pause between observations gets a new decision', () => {
  const f = fixture();
  const before = f.api.observe();
  const event = f.status.event;
  // No observe in between: a 500 ms poll can miss this entire transition.
  f.game.resume(); f.status.imchoosing = false;
  f.status.imchoosing = true; f.game.pause();
  const after = f.api.observe();
  assert.equal(f.status.event, event);
  assert.equal(f.status.event.step, 0);
  assert.equal(before.choice.id, after.choice.id);
  assert.notEqual(before.choice.decisionId, after.choice.decisionId);
  assert.notEqual(before.revision, after.revision);
});

test('selection changes and redundant pause calls keep the current decision', () => {
  const f = fixture();
  const before = f.api.observe();
  f.classes.add('selected');
  f.game.pause(); f.game.pause();
  const after = f.api.observe();
  assert.equal(after.choice.options[0].selected, true);
  assert.notEqual(before.revision, after.revision);
  assert.equal(before.choice.decisionId, after.choice.decisionId);
  assert.equal(f.api.observe().choice.decisionId, after.choice.decisionId);
});

test('a directly observed custom choosing gap rearms the same event without pause methods', () => {
  const f = fixture(game => { delete game.pause; delete game.resume; });
  const first = f.api.observe().choice;
  f.status.imchoosing = false;
  assert.equal(f.api.observe().choice, null);
  f.status.imchoosing = true;
  const next = f.api.observe().choice;
  assert.equal(first.id, next.id);
  assert.notEqual(first.decisionId, next.decisionId);
});

test('a different event at the same paused state has a distinct decision', () => {
  const f = fixture();
  const first = f.api.observe().choice;
  f.status.event = { ...f.status.event };
  const next = f.api.observe().choice;
  assert.notEqual(first.id, next.id);
  assert.notEqual(first.decisionId, next.decisionId);
});

test('pause wrappers preserve receiver, arguments and exact promise/return identities', () => {
  const calls = [], pending = Promise.resolve('pause'), result = {};
  const f = fixture((game, status) => {
    game.pause = function (...args) { calls.push({ method: 'pause', receiver: this, args }); status.paused = true; return pending; };
    game.resume = function (...args) { calls.push({ method: 'resume', receiver: this, args }); status.paused = false; return result; };
  });
  const receiver = {}, arg = {};
  assert.equal(f.game.resume.call(receiver, arg, 3), result);
  assert.equal(f.game.pause.call(receiver, 'a', arg), pending);
  assert.deepEqual(calls, [
    { method: 'resume', receiver, args: [arg, 3] },
    { method: 'pause', receiver, args: ['a', arg] },
  ]);
});

test('pause exceptions are unchanged and a state transition before a throw is still observed', () => {
  const thrown = new Error('original pause failed');
  const f = fixture((game, status) => {
    game.pause = function () { status.paused = true; throw thrown; };
    game.resume = function () { status.paused = false; throw thrown; };
  });
  const first = f.api.observe().choice;
  assert.throws(() => f.game.resume(), error => error === thrown);
  assert.throws(() => f.game.pause(), error => error === thrown);
  assert.notEqual(f.api.observe().choice.decisionId, first.decisionId);
});

test('reinstalling the projection neither stacks wrappers nor changes decision identity', () => {
  const f = fixture();
  const pause = f.game.pause, resume = f.game.resume;
  const before = f.api.observe().choice.decisionId;
  assert.equal(f.install(), f.api);
  assert.equal(f.game.pause, pause);
  assert.equal(f.game.resume, resume);
  assert.equal(f.api.observe().choice.decisionId, before);
});
