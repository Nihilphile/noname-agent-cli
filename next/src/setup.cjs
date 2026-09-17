'use strict';

// All configuration is saved in the browser profile owned by this CLI session.
// Character choices use the game's existing free-choice controls and handlers.
const INTENT_KEY = 'noname-cli-oneshot-intent';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function problem(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

function validateOptions(options) {
  const mode = options.mode || 'identity';
  if (!['identity', 'doudizhu'].includes(mode)) {
    throw problem('unsupported_mode', `Unsupported mode ${mode}; use identity or doudizhu.`);
  }
  if (options.character !== undefined && (typeof options.character !== 'string' || !options.character.trim())) {
    throw problem('invalid_character', 'Provide a non-empty character ID; use characters to discover IDs.');
  }
  const extensions = options.extensions || ['Nihilphile'];
  if (!Array.isArray(extensions) || extensions.some(x => typeof x !== 'string' || !x || /[\\/]/.test(x))) {
    throw problem('invalid_extensions', 'Extensions must be an array of installed extension folder names.');
  }
  return { mode, character: options.character, extensions };
}

async function page(cdp, fn, argument) {
  return cdp.evaluate(`(async()=>{const {lib,game,ui,get,_status}=await import('/noname.js');return (${fn.toString()})({lib,game,ui,get,_status},${JSON.stringify(argument ?? null)});})()`);
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
      else if (lib.characterFilter[id] && !lib.characterFilter[id](get.mode())) reason = 'restricted_in_current_mode';
      else if (character.isMinskin || character.isUnseen || character.isHiddenInStoneMode || ((character.isBoss || character.isHiddenBoss) && !character.isBossAllowed)) reason = 'not_offered_by_free_choice';
      rows.push({ id, name, packs: packNames, available: !reason, reason });
    }
    return { mode: get.mode(), characters: rows.sort((a, b) => a.id.localeCompare(b.id)), query };
  }, { query });
}

async function prepare(cdp, options = {}) {
  const intent = validateOptions(options);
  await poll(cdp, ({ lib, game }) => ({ ready: !!(lib.db && game.layout && lib.config?.mode_config && game.promises?.saveConfig) }), { description: 'game configuration to load' });
  await page(cdp, async ({ lib, game }, { intent, intentKey }) => {
    const save = (key, value, mode) => game.promises.saveConfig(key, value, mode);
    for (const extension of intent.extensions) {
      const response = await fetch(`/extension/${encodeURIComponent(extension)}/extension.js`, { method: 'HEAD' });
      if (!response.ok) throw new Error(`Extension is not installed: ${extension}`);
    }
    // The bundle's defaults enable cosmetic/automation extensions. Keep the
    // isolated session's extension list explicit and reproducible.
    await save('extension_auto_import', false);
    await save('extensions', [...new Set(intent.extensions)]);
    for (const extension of intent.extensions) await save(`extension_${extension}_enable`, true);
    // Nihilphile registers a character package separately from its extension.
    if (intent.extensions.includes('Nihilphile')) await save('characters', [...new Set([...(lib.config.characters || []), 'nihilphile'])]);
    await save('mode', intent.mode);
    await save('show_splash', 'off');
    await save('new_tutorial', true);
    await save('auto_confirm', false);
    await save('touchscreen', false);
    await save('showMax_character_number', '24');
    await save('free_choose', true, intent.mode);
    await save('choose_timeout', '86400', intent.mode);
    await save('double_character', false, intent.mode);
    await save(intent.mode === 'identity' ? 'identity_mode' : 'doudizhu_mode', 'normal', intent.mode);
    await save('continue_name', undefined);
    localStorage.setItem(lib.configprefix + 'directstart', 'true');
    localStorage.setItem(intentKey, JSON.stringify(intent));
    return true;
  }, { intent, intentKey: INTENT_KEY });
  await cdp.send('Page.reload', { ignoreCache: false });
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
    return {
      ready: get.mode() === expected && !!ui.cheat2 && !ui.cheat2.classList.contains('disabled') && _status.event?.name === 'chooseButton' && !!game.me,
      mode: get.mode(), submode: _status.mode, event: _status.event?.name || null,
      freeChoice: !!ui.cheat2, connected: !!_status.connectMode,
    };
  }, { description: `${intent.mode} character selection`, argument: intent.mode });
  if (ready.connected) throw problem('unexpected_online_mode', 'Expected a single-player game, but the client entered online mode.');
  if (intent.character) return chooseCharacter(cdp, { character: intent.character });
  return { mode: ready.mode, submode: ready.submode, state: 'character_selection' };
}

async function chooseCharacter(cdp, { character }) {
  validateOptions({ character });
  const catalog = await characters(cdp, { query: character });
  const target = catalog.characters.find(item => item.id === character);
  if (!target) throw problem('character_not_found', `Character ${character} is not loaded. Use characters, check the extension installation, then start with the required extension enabled.`);
  if (!target.available) throw problem('character_unavailable', `Character ${character} cannot be chosen: ${target.reason}. Enable its pack or choose a compatible mode.`, target);
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
    const selected = await page(cdp, ({ ui, _status, get }, id) => {
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
      return { selected: ui.selected.buttons.some(button => button.link === id) };
    }, character);
    if (selected.error || !selected.selected) throw problem('character_selection_rejected', `The game's selection UI did not accept ${character}.`, selected);
    await delay(100);
    const confirmed = await page(cdp, ({ ui }, id) => {
      if (ui.selected.buttons.length !== 1 || ui.selected.buttons[0].link !== id) return false;
      const ok = Array.from(ui.confirm?.childNodes || []).find(node => node.link === 'ok');
      if (!ok) return false;
      ok.click();
      return true;
    }, character);
    if (!confirmed) throw problem('character_confirmation_unavailable', 'The game did not offer confirmation for this character selection. Inspect status for another required selection.');
  }
  const actual = await poll(cdp, ({ game, get, _status }, id) => ({
    ready: game.me?.name === id || game.me?.name1 === id,
    mode: get.mode(), submode: _status.mode,
    character: game.me?.name1 || game.me?.name || null,
    name: game.me?.name1 ? String(get.translation(game.me.name1)).replace(/<[^>]*>/g, '') : null,
    event: _status.event?.name,
  }), { timeoutMs: 12000, description: `actual character ${character}`, argument: character });
  await cdp.evaluate(`(()=>{const k=${JSON.stringify(INTENT_KEY)};const v=JSON.parse(localStorage.getItem(k)||'{}');v.character=${JSON.stringify(character)};localStorage.setItem(k,JSON.stringify(v));return true})()`);
  return { mode: actual.mode, submode: actual.submode, character: actual.character, name: actual.name, state: 'character_selected' };
}

async function restart(cdp, options = {}) {
  const previous = await cdp.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(INTENT_KEY)})||'{}')`);
  return prepare(cdp, { ...previous, ...options });
}

module.exports = { prepare, characters, chooseCharacter, restart, validateOptions, character: require('./character.cjs').character };
