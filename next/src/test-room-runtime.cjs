'use strict';

// Runs only in the tool-owned room host. Patch the two known native selection
// implementations in memory; retain their event steps, init and broadcasts.
function install({ lib, game, ui, get, ai, _status }, plan) {
  const fail = message => { throw Error(`test_room_incompatible: ${message}`); };
  if (!_status.waitingForPlayer || game.online) fail('host must be in the lobby');
  if (lib.configOL.double_character) fail('double-character rooms are unsupported');
  if (plan.mode === '2v2' ? lib.configOL.mode !== 'versus' || lib.configOL.versus_mode !== '2v2'
    : lib.configOL.mode !== 'doudizhu' || lib.configOL.doudizhu_mode !== 'normal') fail('room mode changed since creation');
  const method = plan.mode === '2v2' ? 'chooseCharacterOL2' : 'chooseCharacterOL';
  const original = game[method];
  if (window.__nonameTestRoom) fail('test setup is already installed');
  let source = original?.toString().replace(/\r\n/g, '\n');
  if (!source) fail(`missing ${method}`);
  const replace = (from, to) => {
    if (source.split(from).length !== 2) fail(`native selection changed: ${from}`);
    source = source.replace(from, to);
  };
  const seat = player => {
    const entry = plan.seats.find(s => s.host ? player === game.me : s.playerId === player.playerid);
    if (!entry) fail(`unbound player ${player.playerid}`);
    return entry;
  };
  const state = {
    mode: plan.mode, selections: {},
    seat,
    candidates(player) {
      const entry = seat(player);
      if (!lib.character[entry.character] || lib.filter.characterDisabled(entry.character)) fail(`unavailable character ${entry.character}`);
      this.selections[player.playerid] = { session: entry.session, character: entry.character };
      return [entry.character];
    },
    sides() { return Object.fromEntries(game.players.map(p => [p.playerid, seat(p).team === 'A'])); },
  };
  if (plan.mode === 'doudizhu') {
    replace('identityList.randomSort();', 'identityList = game.players.map(p => window.__nonameTestRoom.seat(p).identity);');
    replace('event.list.randomRemove(num3), "characterx"', 'window.__nonameTestRoom.candidates(game.players[i]), "character"');
  } else {
    replace('var firstChoose = game.players.randomGet();', 'for (var p of game.players) p.side = window.__nonameTestRoom.seat(p).team === "A";\nvar firstChoose = game.players.randomGet();');
    replace('function (ref, bool, bool2, firstChoose)', 'function (ref, bool, bool2, firstChoose, testSides)');
    // Insert inside the broadcast callback, before its UI projection.
    const broadcastStart = source.indexOf('function (ref, bool, bool2, firstChoose, testSides)');
    const insertion = source.indexOf('for (var i = 0; i < 4; i++)', broadcastStart);
    if (insertion < 0) fail('missing side broadcast');
    source = source.slice(0, insertion) + 'for (var p of game.players) p.side = testSides[p.playerid];\n' + source.slice(insertion);
    replace('_status.firstAct\n', '_status.firstAct, window.__nonameTestRoom.sides()\n');
    replace('choose[game.players[i].playerid] = list.randomRemove(6);', 'choose[game.players[i].playerid] = window.__nonameTestRoom.candidates(game.players[i]);');
    replace('ui.create.buttons(players, "characterx", buttons)', 'ui.create.buttons(players, "character", buttons)');
    replace('ui.create.buttons(friends, "characterx", buttons)', 'ui.create.buttons(friends, "character", buttons)');
  }
  // Functions may use method shorthand. All native closure names are supplied;
  // engine step compilation sees only global window state, never our closure.
  const expression = /^(async\s+)?function\b/.test(source) ? source : `function ${source}`;
  const patched = Function('lib', 'game', 'ui', 'get', 'ai', '_status', `return (${expression});`)(lib, game, ui, get, ai, _status);
  window.__nonameTestRoom = state;
  game[method] = patched;
  return { installed: true, method };
}

function catalog({ lib, game, _status }, plan) {
  if (!_status.connectMode) throw Error('test_room_not_connected');
  const characters = Object.assign({}, ...(lib.configOL.characterPack || []).map(id => lib.characterPack[id] || {}));
  for (const s of plan.seats) {
    if (!lib.character[s.character] || !characters[s.character]) throw Error(`test_character_not_loaded: ${s.character}`);
    if (lib.connectBanned?.includes(s.character) || lib.filter.characterDisabled(s.character, characters)) {
      const reason = lib.connectBanned?.includes(s.character) ? 'connectBanned'
        : lib.configOL.banned?.includes(s.character) ? 'room ban'
          : lib.config?.forbidai?.includes(s.character) || lib.character[s.character].isAiForbidden ? 'forbidai (native online candidate filter)'
            : 'native mode/character restriction';
      throw Error(`test_character_disabled: ${s.character} (${reason})`);
    }
  }
  return { ready: true, playerId: game.onlineID || game.me?.playerid || null };
}

// Click only the native character dialog. Never confirm a later skill or turn.
function select({ lib, game, ui, get, _status }, expected) {
  const actual = game.me?.name1 || game.me?.name;
  if (actual) {
    if (actual !== expected.character) throw Error(`test_character_mismatch: ${actual} != ${expected.character}`);
    return { selected: true };
  }
  if (_status.auto) throw Error('test_room_auto_control');
  const event = _status.event;
  if (!_status.imchoosing || event?.name !== 'chooseButton') return { selected: false };
  let ancestor = event, characterEvent = false;
  for (let i = 0; ancestor && i < 12; i++, ancestor = ancestor.parent) {
    if (['chooseCharacter', 'chooseCharacterOL'].includes(ancestor.name)) characterEvent = true;
  }
  const dialog = typeof event.dialog === 'object' ? event.dialog : get.idDialog?.(game._characterDialogID);
  const buttons = dialog?.players || dialog?.buttons || [];
  const button = buttons.find(b => b.link === expected.character && b.classList?.contains('character'));
  // Remote chooseButton does not necessarily retain its host event ancestors.
  if (!button || (!characterEvent && !dialog?.textContent?.match(/选择角色|请选择武将/))) return { selected: false };
  if (button.classList.contains('unselectable')) throw Error('test_character_not_selectable');
  if (!button.classList.contains('selected')) {
    if (!button.classList.contains('selectable') && !event.custom?.replace?.button) return { selected: false };
    button.click();
    return { selected: false, clicked: true };
  }
  const chosen = ui.selected?.buttons || [];
  if (chosen.length !== 1 || chosen[0].link !== expected.character) throw Error('test_character_selection_conflict');
  const ok = Array.from(ui.confirm?.childNodes || []).find(n => n.link === 'ok');
  if (ok) ok.click();
  return { selected: false, confirmed: !!ok };
}

function snapshot({ game, _status }) {
  return { me: game.me?.playerid, auto: !!_status.auto,
    connected: game.online ? game.ws?.readyState === 1 : !!window.__nonameRoomServer?._server?.listening,
    players: [...(game.players || []), ...(game.dead || [])].map(p => ({ playerId: p.playerid, character: p.name1 || p.name || null, identity: p.identity, team: typeof p.side === 'boolean' ? p.side ? 'A' : 'B' : null })),
    selections: window.__nonameTestRoom?.selections || null };
}

module.exports = { install, catalog, select, snapshot };
