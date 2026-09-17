'use strict';
const { validName } = require('./extension-files.cjs');

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const unique = values => [...new Set(values)];

function list(value, { code, label, validate }) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : String(value).split(',');
  const normalized = values.map(item => typeof item === 'string' ? item.trim() : item);
  if (normalized.some(item => typeof item !== 'string' || !item || !validate(item))) {
    throw Object.assign(Error(`${label} must be a comma-separated list of installed IDs.`), { code });
  }
  return unique(normalized);
}

const packId = value => value.length <= 100 && !['__proto__', 'constructor', 'prototype'].includes(value) && !/[,/\\:\x00-\x1f]/.test(value);
const fields = [
  { name: 'extensions', option: 'extensions', code: 'invalid_extensions', label: 'Extensions', validate: validName },
  { name: 'characterPacks', option: 'character-packs', code: 'invalid_character_packs', label: 'Character packs', validate: packId },
  { name: 'cardPacks', option: 'card-packs', code: 'invalid_card_packs', label: 'Card packs', validate: packId },
];

function resolve(options = {}, fallback = {}) {
  return Object.fromEntries(fields.map(field => {
    const value = own(options, field.name) ? options[field.name]
      : own(options, field.option) ? options[field.option]
        : own(fallback, field.name) ? fallback[field.name]
          : fallback[field.option];
    return [field.name, list(value, field)];
  }));
}

function merge(...profiles) {
  const normalized = profiles.map(profile => resolve(profile));
  return Object.fromEntries(fields.map(field => [field.name, unique(normalized.flatMap(profile => profile[field.name]))]));
}

function fromExtensionBundle(bundle = []) {
  return resolve({
    extensions: bundle.map(entry => entry.name),
    characterPacks: bundle.flatMap(entry => entry.characterPacks || []),
    cardPacks: bundle.flatMap(entry => entry.cardPacks || []),
  });
}

module.exports = { resolve, merge, fromExtensionBundle };
