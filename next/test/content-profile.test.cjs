'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const profiles = require('../src/content-profile.cjs');

test('content profile defaults to the official game with no required extension', () => {
  assert.deepEqual(profiles.resolve(), { extensions: [], characterPacks: [], cardPacks: [] });
});

test('content profile parses generic comma-separated extension and pack lists', () => {
  assert.deepEqual(profiles.resolve({ extensions: 'Nihilphile, Friends,Nihilphile', 'character-packs': 'nihilphile,friends', 'card-packs': 'extra_cards' }), {
    extensions: ['Nihilphile', 'Friends'], characterPacks: ['nihilphile', 'friends'], cardPacks: ['extra_cards'],
  });
});

test('content profile keeps source extensions separate while merging frozen room bundles', () => {
  const source = profiles.resolve({ extensions: ['Local'], characterPacks: ['local_pack'] });
  const bundle = profiles.fromExtensionBundle([{ name: 'Imported', characterPacks: ['imported_pack'], cardPacks: ['imported_cards'] }]);
  assert.deepEqual(profiles.merge(source, bundle), {
    extensions: ['Local', 'Imported'], characterPacks: ['local_pack', 'imported_pack'], cardPacks: ['imported_cards'],
  });
});

test('content profile rejects unsafe extension names and malformed pack ids', () => {
  assert.throws(() => profiles.resolve({ extensions: '../other' }), { code: 'invalid_extensions' });
  assert.throws(() => profiles.resolve({ 'character-packs': 'safe,../other' }), { code: 'invalid_character_packs' });
  assert.throws(() => profiles.resolve({ 'card-packs': 'a:b' }), { code: 'invalid_card_packs' });
});
