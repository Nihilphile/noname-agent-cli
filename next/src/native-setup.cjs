'use strict';
const { ENTRY_READY_EXPRESSION } = require('./native-bootstrap.cjs');
const { installObservation } = require('./page.cjs');

// Native setup preserves the user's existing content and gameplay settings.
// Character choices use the game's existing free-choice controls and handlers.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function problem(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

function validateOptions(options) {
  const mode = options.mode || 'identity';
  if (!['identity', 'doudizhu', '2v2'].includes(mode)) {
    throw problem('unsupported_mode', `Unsupported mode ${mode}; use identity, doudizhu or 2v2.`);
  }
  if (options.character !== undefined && (typeof options.character !== 'string' || !options.character.trim())) {
    throw problem('invalid_character', 'Provide a non-empty character ID; use characters to discover IDs.');
  }
  return { mode, character: options.character };
}

async function page(cdp, fn, argument) {
  return cdp.evaluate(`(async()=>{if(!(${ENTRY_READY_EXPRESSION}))throw new Error('native_entry_not_ready: waiting for index document and import map');const {lib,game,ui,get,_status}=await import('/noname.js');return (${fn.toString()})({lib,game,ui,get,_status},${JSON.stringify(argument ?? null)});})()`);
}

async function poll(cdp, fn, { timeoutMs = 45000, description, argument } = {}) {
  const started = Date.now();
  let last, lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await page(cdp, fn, argument);
      if (last?.ready) return last;
    } catch (error) {
      lastError = error.message;
      if (/closed|ECONNREFUSED/i.test(error.message)) throw error;
    }
    if (last?.error) throw problem(last.error.code, last.error.message, last);
    await delay(200);
  }
  throw problem('setup_timeout', `Timed out waiting for ${description || 'game setup'}. Inspect status/diagnose and restart the session if the page failed to load.`, { last, lastError });
}

async function characters(cdp, { query = '' } = {}) {
  return page(cdp, ({ lib, get }, { query }) => {
    const clean = value => String(value || '').replace(/<[^>]*>/g, '');
    const packs = lib.characterPack || {};
    const ids = new Set(Object.keys(lib.character || {}));
    for (const pack of Object.values(packs)) for (const id of Object.keys(pack || {})) ids.add(id);
    const rows = [];
    for (const id of ids) {
      const name = clean(get.translation(id));
      if (query && !`${id} ${name}`.toLowerCase().includes(query.toLowerCase())) continue;
      const packNames = Object.keys(packs).filter(pack => Object.prototype.hasOwnProperty.call(packs[pack], id));
      const character = lib.character[id];
      let reason = null;
      if (!character) reason = 'pack_not_enabled';
      else if (lib.config.banned?.includes(id)) reason = 'banned_in_current_mode';
      else if (lib.characterFilter?.[id] && !lib.characterFilter[id](get.mode())) reason = 'restricted_in_current_mode';
      else if (character.isMinskin || character.isUnseen || character.isHiddenInStoneMode || ((character.isBoss || character.isHiddenBoss) && !character.isBossAllowed)) reason = 'not_offered_by_free_choice';
      rows.push({ id, name, packs: packNames, available: !reason, reason, aiAllowed: !lib.config.forbidai?.includes(id), testCandidate: packNames.includes('nihilphile') && !id.startsWith('zus_') });
    }
    return { mode: get.mode(), characters: rows.sort((a, b) => a.id.localeCompare(b.id)), query };
  }, { query });
}

async function prepare(cdp, options = {}) {
  const intent = validateOptions(options);
  const expected = { mode: intent.mode === '2v2' ? 'versus' : intent.mode, submode: intent.mode === '2v2' ? 'two' : null };
  // An explicit prepare/restart may be requested after attaching to app.html.
  // Move to the complete same-origin entry before importing configuration.
  const currentEntry = await cdp.evaluate('location.href');
  if (new URL(currentEntry).pathname !== '/index.html') await cdp.send('Page.navigate', { url: new URL('/index.html', currentEntry).href });
  await poll(cdp, ({ lib, game }) => ({ ready: !!(lib.config?.mode_config && game.promises?.saveConfig) }), { description: 'game configuration to load' });
  await assertCompatibleSetup(cdp, expected.mode, expected.submode);
  const configChanges = await page(cdp, async ({ lib, game, _status }, { expected }) => {
    if (_status.connectMode) throw new Error('Native setup only supports an offline game.');
    if (lib.config.mode_config?.[expected.mode]?.double_character) throw new Error('The existing mode uses double-character selection. Preserve this setting; choose characters manually or change it in the game before directed single-character setup.');
    if (lib.config.continue_name?.length) throw new Error('The existing continue_name setting would bypass native character selection. Clear it through the game before directed setup.');
    const save = (key, value, mode) => game.promises.saveConfig(key, value, mode);
    const changes = [];
    const change = async (key, value, mode) => {
      const previous = mode ? lib.config.mode_config?.[mode]?.[key] : lib.config[key];
      if (previous === value) return;
      await save(key, value, mode);
      changes.push({ key, mode: mode || null, before: previous ?? null, after: value });
    };
    await change('mode', expected.mode);
    if (expected.submode) await change('versus_mode', expected.submode, expected.mode);
    await change('free_choose', true, expected.mode);
    changes.push({ key: lib.configprefix + 'directstart', storage: 'localStorage', before: localStorage.getItem(lib.configprefix + 'directstart'), after: 'true', transient: true });
    localStorage.setItem(lib.configprefix + 'directstart', 'true');
    return changes;
  }, { expected });
  if (typeof options.onConfigChanges === 'function') await options.onConfigChanges(configChanges);
  // The packaged app.html loads game/importmap.js, which is empty in this
  // installation. The same-origin index entry contains the actual module map.
  // Preserve origin/profile/config while using the complete shipped entry.
  const entry = await cdp.evaluate('new URL("/index.html", location.href).href');
  await cdp.send('Page.navigate', { url: entry });
  await delay(300);
  const ready = await poll(cdp, ({ lib, game, ui, get, _status }, expected) => {
    // A fresh profile shows an informational release-notes dialog before
    // character selection. Acknowledge its real control, never a game choice.
    const announcement = (ui.dialogs || []).find(dialog => dialog.isConnected &&
      (dialog.textContent.includes(`${lib.version}更新内容`) || dialog.textContent.startsWith('扩展更新')));
    if (announcement && _status.event?.name === 'game') {
      const control = (ui.controls || []).find(node => node.isConnected && node.custom && node.firstChild?.textContent === '确定');
      if (control) control.firstChild.click();
    }
    const atSelection = !!ui.cheat2 && !ui.cheat2.classList.contains('disabled') && _status.event?.name === 'chooseButton' && !!game.me;
    const matches = get.mode() === expected.mode && (!expected.submode || _status.mode === expected.submode);
    return {
      ready: matches && atSelection,
      error: atSelection && !matches ? { code: 'unexpected_game_mode', message: `Expected ${expected.mode}/${expected.submode || '*'}, but the game entered ${get.mode()}/${_status.mode || 'unknown'}. Check the game's mode settings and restart.` } : null,
      mode: get.mode(), submode: _status.mode, event: _status.event?.name || null,
      freeChoice: !!ui.cheat2, connected: !!_status.connectMode,
    };
  }, { description: `${intent.mode} character selection`, argument: expected });
  if (ready.connected) throw problem('unexpected_online_mode', 'Expected a single-player game, but the client entered online mode.');
  if (intent.character) return { ...(await chooseCharacter(cdp, { character: intent.character, expected })), configChanges };
  await installObservation(cdp);
  return { mode: ready.mode, submode: ready.submode, state: 'character_selection', configChanges };
}

async function assertCompatibleSetup(cdp, mode, submode) {
  const incompatible = await page(cdp, ({ lib, get, _status }, target) => {
    const mode = target.mode || get.mode();
    const submode = target.submode || _status.mode;
    if (mode !== 'versus' || submode !== 'two') return [];
    const settings = { two_assign: '代替队友选将', replace_character_two: '替补模式', two_phaseswap: '代替队友行动' };
    return Object.entries(settings).filter(([key]) => lib.config.mode_config?.versus?.[key]).map(([key, label]) => ({ key, label }));
  }, { mode, submode });
  if (incompatible.length) throw problem('unsupported_2v2_settings', `Directed single-character 2v2 requires these existing game options to be disabled manually in 对决 → 2v2: ${incompatible.map(item => `${item.label} (${item.key})`).join(', ')}. Their values were preserved.`, { settings: incompatible });
}

async function chooseCharacter(cdp, { character, expected }) {
  validateOptions({ character });
  await assertCompatibleSetup(cdp);
  const catalog = await characters(cdp, { query: character });
  const target = catalog.characters.find(item => item.id === character);
  if (!target) throw problem('character_not_found', `Character ${character} is not loaded. Use characters, check the extension installation, then start with the required extension enabled.`);
  if (!target.available) throw problem('character_unavailable', `Character ${character} cannot be chosen: ${target.reason}. Enable its pack or choose a compatible mode.`, target);
  // Establish the baseline and hook the native event/logSkill path before the
  // selection click can advance into enterGame/phaseBefore startup triggers.
  await installObservation(cdp);
  const opened = await page(cdp, ({ game, ui, _status }, id) => {
    if (game.me?.name === id || game.me?.name1 === id) return { alreadySelected: true };
    if (!ui.cheat2 || _status.event?.name !== 'chooseButton') return { error: 'not_at_character_selection' };
    if (ui.cheat2.classList.contains('disabled')) return { error: 'free_choice_not_ready' };
    if (ui.cheat2.dialog !== _status.event.dialog) ui.cheat2.firstChild.click();
    return { opened: true };
  }, character);
  if (opened.error) throw problem(opened.error, 'The game is not ready for character selection. Start/restart a game and retry.');
  if (!opened.alreadySelected) {
    await delay(150);
    const selected = await page(cdp, ({ ui, _status, get, game }, id) => {
      const dialog = _status.event?.dialog;
      const button = dialog?.buttons?.find(button => button.link === id);
      if (!button) return { error: 'not_in_free_choice' };
      const input = dialog.querySelector('.searcher input');
      if (input) {
        input.value = String(get.translation(id)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      if (!button.classList.contains('selectable')) return { error: 'not_selectable' };
      if (!button.classList.contains('selected')) button.click();
      return { selected: ui.selected.buttons.some(button => button.link === id) || game.me?.name === id || game.me?.name1 === id };
    }, character);
    if (selected.error) throw problem('character_selection_rejected', `The game's selection UI did not accept ${character}.`, selected);
    if (!selected.selected) {
      // Native auto_confirm can clear ui.selected immediately, then commit the
      // character on a later engine step. Observe that commit before deciding
      // this was a rejected click; never confirm whatever prompt follows it.
      try {
        await poll(cdp, ({ game }, id) => ({ ready: game.me?.name === id || game.me?.name1 === id }), { timeoutMs: 2500, description: `automatic character confirmation ${character}`, argument: character });
      } catch {
        throw problem('character_selection_rejected', `The game's selection UI did not accept ${character}.`, selected);
      }
    }
    await delay(100);
    const confirmed = await page(cdp, ({ ui, game, _status }, id) => {
      if (game.me?.name === id || game.me?.name1 === id) return true;
      if (_status.event?.name !== 'chooseButton') return false;
      if (ui.selected.buttons.length !== 1 || ui.selected.buttons[0].link !== id) return false;
      const ok = Array.from(ui.confirm?.childNodes || []).find(node => node.link === 'ok');
      if (!ok) return false;
      ok.click();
      return true;
    }, character);
    if (!confirmed) {
      const autoSelected = await page(cdp, ({ game }, id) => game.me?.name === id || game.me?.name1 === id, character);
      if (!autoSelected) throw problem('character_confirmation_unavailable', 'The game did not offer confirmation for this character selection. Inspect status for another required selection.');
    }
  }
  const actual = await poll(cdp, ({ game, get, _status }, id) => ({
    ready: game.me?.name === id || game.me?.name1 === id,
    mode: get.mode(), submode: _status.mode,
    character: game.me?.name1 || game.me?.name || null,
    name: game.me?.name1 ? String(get.translation(game.me.name1)).replace(/<[^>]*>/g, '') : null,
    event: _status.event?.name,
  }), { timeoutMs: 12000, description: `actual character ${character}`, argument: character });
  if (expected && (actual.mode !== expected.mode || (expected.submode && actual.submode !== expected.submode))) {
    throw problem('unexpected_game_mode', `Expected ${expected.mode}/${expected.submode || '*'}, but the character was selected in ${actual.mode}/${actual.submode || 'unknown'}.`, actual);
  }
  return { mode: actual.mode, submode: actual.submode, character: actual.character, name: actual.name, state: 'character_selected' };
}

async function restart(cdp, options = {}) {
  return prepare(cdp, options);
}

module.exports = { prepare, characters, chooseCharacter, restart, validateOptions, character: (cdp, id) => require('./character.cjs').character(cdp, id, { native: true }) };
