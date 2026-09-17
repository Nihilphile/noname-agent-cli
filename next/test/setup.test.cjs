'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { validateOptions, prepare, chooseCharacter, restart } = require('../src/setup.cjs');

test('prepare waits for IndexedDB config application before writing isolated settings', async () => {
  const samples = [
    { lib: { config: { mode_config: {} }, db: false }, game: { promises: { saveConfig() {} } } },
    { lib: { config: { mode_config: {} }, db: {} }, game: { promises: { saveConfig() {} } } },
    { lib: { config: { mode_config: {} }, db: {} }, game: { layout: 'mobile', promises: { saveConfig() {} } } },
  ];
  let readinessCalls = 0;
  const cdp = {
    async evaluate(source) {
      if (!source.includes('game.promises?.saveConfig')) throw Error('after-readiness');
      const match = source.match(/return \(([\s\S]+)\)\(\{lib,game,ui,get,_status\},/);
      assert.ok(match, 'the setup readiness predicate should be serialized through page()');
      const predicate = vm.runInNewContext(`(${match[1]})`);
      const modules = { ...samples[Math.min(readinessCalls, samples.length - 1)], ui: {}, get: {}, _status: {} };
      readinessCalls++;
      return predicate(modules, null);
    },
  };
  await assert.rejects(prepare(cdp, { mode: 'doudizhu', extensions: [] }), /after-readiness/);
  assert.equal(readinessCalls, 3, 'defaults and saveConfig exist before IndexedDB has been loaded and applied');
});

test('unsupported modes are rejected before touching the browser', async () => {
  const cdp = { evaluate() { throw new Error('must not access browser'); } };
  await assert.rejects(prepare(cdp, { mode: 'connect' }), { code: 'unsupported_mode' });
  assert.throws(() => validateOptions({ character: '' }), { code: 'invalid_character' });
  assert.throws(() => validateOptions({ extensions: ['../other'] }), { code: 'invalid_extensions' });
});

test('missing and disabled characters are never silently substituted', async () => {
  let calls = 0;
  const cdp = { async evaluate() { calls++; return { characters: [] }; } };
  await assert.rejects(chooseCharacter(cdp, { character: 'missing' }), { code: 'character_not_found' });
  assert.equal(calls, 1);
  cdp.evaluate = async () => ({ characters: [{ id: 'disabled', available: false, reason: 'restricted_in_current_mode' }] });
  await assert.rejects(chooseCharacter(cdp, { character: 'disabled' }), { code: 'character_unavailable' });
});

test('character selection outside the native selection UI fails explicitly', async () => {
  const replies = [
    { characters: [{ id: 'some_character', available: true }] },
    { error: 'not_at_character_selection' },
  ];
  const cdp = { async evaluate() { return replies.shift(); } };
  await assert.rejects(chooseCharacter(cdp, { character: 'some_character' }), { code: 'not_at_character_selection' });
  assert.equal(replies.length, 0);
});

test('restart preserves stored mode and validates an explicit override', async () => {
  let calls = 0;
  const cdp = { async evaluate() { calls++; return { mode: 'identity', character: 'some_character' }; } };
  await assert.rejects(restart(cdp, { mode: 'invalid' }), { code: 'unsupported_mode' });
  assert.equal(calls, 1);
});
