'use strict';

// Serialized into the game page. All output is a player-view projection.
function installPage({ lib, game, ui, get, _status }) {
  if (window.__nonameAgent) return window.__nonameAgent;
  const ids = new WeakMap(), nodes = new Map();
  let serial = 0, revision = 0, signature = '', result = null, acting = false;
  // An engine event can return to the same step (chooseToUse.goto(0)). Its
  // object ID and a sampled running state therefore cannot identify a new
  // decision. Native pause/resume change paused synchronously: remember those
  // boundaries in the renderer, including cycles entirely between CDP reads.
  // This instruments the existing functions in memory only; their receiver,
  // arguments, return/promise identity and exceptions remain unchanged.
  let pauseGeneration = 0, observedGeneration = 0, observedChoosing = false;
  for (const method of ['pause', 'resume']) {
    const original = game[method];
    if (typeof original !== 'function') continue;
    game[method] = function (...args) {
      const before = !!_status.paused;
      try { return original.apply(this, args); }
      finally { if (!!_status.paused !== before) pauseGeneration++; }
    };
  }
  const id = (object, prefix = 'n') => {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return null;
    if (prefix === 'p' && window.__nonameFlow?.playerId) { const key = window.__nonameFlow.playerId(object); ids.set(object,key); nodes.set(key, object); return key; }
    if (!ids.has(object)) ids.set(object, prefix + (++serial));
    const key = ids.get(object); nodes.set(key, object);
    if (prefix === 'c') window.__nonameRoomPlay?.rememberCard?.(object, key);
    return key;
  };
  // Flow can prove which raw useCard event was submitted; this projection can
  // give the local player's already-visible material the same stable ID used by
  // observe().  Flow itself enforces the local-player privacy boundary.
  window.__nonameFlow?.setCardIdentityResolver?.(object => id(object, 'c'));
  const text = value => {
    if (get.plainText) return String(get.plainText(String(value ?? ''))).replace(/\s+/g, ' ').trim();
    const e = document.createElement('div'); e.innerHTML = String(value ?? '');
    return (e.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const visible = e => !!(e && e.isConnected && !e.closest('.hidden,.removing,.disabled') && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  // Reading a displayed result is separate from clicking an enabled control.
  // A disabled dialog/container can still show public results. Never reuse
  // this predicate for action options, where .disabled must remain forbidden.
  const displayed = e => {
    if (!e?.isConnected || e.closest?.('.hidden,.removing,.infohidden') || !e.getClientRects?.().length) return false;
    for (let node = e; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || style.opacity === '0') return false;
    }
    return true;
  };
  const publicDialogText = node => {
    if (!displayed(node)) return '';
    const children = [...(node.childNodes || [])];
    if (!children.length) return text(node.innerText || '');
    return text(children.map(child => child.nodeType === 3 ? child.textContent : child.nodeType === 1 ? publicDialogText(child) : '').join(' '));
  };
  const visibleDialogTexts = () => [...new Set([...(ui.dialogs || []), ui.dialog, ...document.querySelectorAll('.dialog')].filter(Boolean))].map(publicDialogText).filter(Boolean);
  const markCount = (name,node,p) => { if(name==='ghujia') return p.hujia??0; const badge=node.querySelector?.('.markcount'); const value=badge&&visible(badge)?text(badge.innerText):''; return /^-?\d+(?:\.\d+)?$/.test(value)?Number(value):null; };
  const selected = e => !!(e?.classList?.contains('selected') || e?.classList?.contains('glow2'));
  const label = name => text(lib.translate[name] || name);
  const canonicalSkill = name => { if(window.__nonameFlow?.canonicalSkill) return window.__nonameFlow.canonicalSkill(name); const seen=new Set(); for(let i=0;i<12;i++){ if(typeof name!=='string'||seen.has(name)) return null; seen.add(name); const source=lib.skill[name]?.sourceSkill; if(!source||source===name) return name; name=source; } return null; };
  const cardLabel = c => c.name === 'sha' && c.nature ? (Array.isArray(c.nature) ? c.nature : String(c.nature).split('|')).map(label).join('') + label(c.name) : label(c.name);
  const card = (c, hidden = false) => hidden ? { id: id(c, 'c'), visibility: 'hidden', name: '暗牌' } : {
    id: id(c, 'c'), name: c.name, label: cardLabel(c), suit: c.suit, number: c.number,
    ...(c.nature ? { nature: c.nature } : {}), selected: selected(c), selectable: c.classList?.contains('selectable') || false,
  };
  const skill = (name, p) => {
    let description;
    try { description = p !== game.me ? lib.translate[name + '_info'] : get.skillInfoTranslation ? get.skillInfoTranslation(name, p, true) : typeof lib.dynamicTranslate?.[name] === 'function' ? lib.dynamicTranslate[name](p, name) : lib.translate[name + '_info']; } catch { /* A third-party tooltip must not prevent observation. */ }
    return { id: name, name: label(name), description: text(description || '说明暂不可获取'), descriptionSource: p===game.me?'player_view':'static_public_rule' };
  };
  const cards = (p, zone) => p?.getCards ? p.getCards(zone) : [];
  const isTwo = () => get.mode() === 'versus' && (_status.connectMode
    ? _status.mode === '2v2' && lib.configOL?.versus_mode === '2v2'
    : _status.mode === 'two');
  const team = p => {
    if (!isTwo()) return null;
    if (typeof p.side !== 'boolean' || typeof game.me?.side !== 'boolean') return { visibility: 'unavailable' };
    return { visibility: 'known', side: p.side, relation: p === game.me ? 'self' : p.side === game.me.side ? 'ally' : 'enemy' };
  };
  const identity = p => {
    const affiliation = team(p);
    if (affiliation) return affiliation.visibility === 'known' ? { visibility: 'known', value: affiliation.relation, label: { self: '本方', ally: '队友', enemy: '敌方' }[affiliation.relation] } : { visibility: 'unavailable' };
    return p === game.me || p.identityShown || p.isZhu || get.mode() === 'doudizhu' ? { visibility: 'known', value: p.identity, label: label(p.identity) } : { visibility: 'hidden' };
  };
  const victory = () => {
    const mode = get.mode(), role = game.me?.identity;
    if (isTwo()) return '2v2：与队友合作，消灭敌方两名角色。';
    if (mode === 'doudizhu') return role === 'zhu' ? '地主：消灭两名农民。' : '农民：与另一名农民合作消灭地主。';
    return ({ zhu: '主公：消灭所有反贼和内奸。', zhong: '忠臣：保护主公，消灭所有反贼和内奸。', fan: '反贼：消灭主公；避免让内奸成为唯一存活者。', nei: '内奸：先消灭其他角色，最后与主公单挑并消灭主公。' })[role] || '身份尚未确定。';
  };
  const originalOver = game.over;
  game.over = function (...args) {
    result = { visibility: 'known', outcome: args[0] === true ? 'win' : args[0] === false ? 'loss' : 'other', message: typeof args[0] === 'string' ? text(args[0]) : null };
    return originalOver.apply(this, args);
  };
  function player(p, detail, { teamHand = false } = {}) {
    const concealed = p.classList?.contains('unseen');
    const out = { id: id(p, 'p'), name: concealed ? '未知武将' : p.name, label: concealed ? '未知武将' : label(p.name), me: p === game.me, identity: identity(p), ...(team(p) ? { team: team(p) } : {}), hp: p.hp ?? null, maxHp: p.maxHp ?? null, armor: p.hujia ?? 0, dead: !!p.isDead?.(), handCount: p.countCards?.('h') ?? null, equipment: cards(p, 'e').map(c => card(c)), judgments: cards(p, 'j').map(c => card(c)), linked: !!p.isLinked?.(), turnedOver: !!p.isTurnedOver?.() };
    // Native control or viewHandcard permission must explicitly grant access.
    // Team membership alone never widens hand visibility; missing/throwing
    // extension capabilities fail closed before reading any hand contents.
    let teamHandReason = null;
    if (teamHand && !_status.connectMode && p !== game.me && team(p)?.relation === 'ally') {
      try {
        if (p.isUnderControl?.(true) === true) teamHandReason = 'native_control';
        else if (game.me.hasSkillTag?.('viewHandcard', null, p, true) === true) teamHandReason = 'native_viewHandcard';
      } catch { teamHandReason = null; }
    }
    if (teamHandReason) {
      out.hand = cards(p, 'h').map(c => card(c));
      out.handVisibility = 'team_rule';
      out.handVisibilityReason = teamHandReason;
    }
    if (!detail) out.marks = Object.entries(p.marks || {}).filter(([,n])=>visible(n)).map(([name,n])=>({id:name,name:label(name),count:markCount(name,n,p),text:text(n.innerText)}));
    if (detail) {
      out.globalSkills = (lib.skill.global || []).filter(s => lib.translate[s+'_info'] && !lib.skill[s]?.silent && !lib.skill[s]?.hiddenSkill && !lib.skill[s]?.nopop && (!(lib.skill.globalmap?.[s]?.length) || lib.skill.globalmap[s].some(owner => owner === game.me || !owner.classList?.contains('unseen')))).map(s => ({id:s,name:label(s),description:text(lib.translate[s+'_info']),descriptionSource:'static_public_rule',scope:'global',availability:'game_rules'}));
      out.skills = concealed ? { visibility: 'hidden' } : (p.getSkills?.(null, false, false) || []).filter(s => !lib.skill[s]?.nopop && !lib.skill[s]?.equipSkill && lib.translate[s + '_info']).map(s => skill(s, p));
      out.marks = Object.entries(p.marks || {}).filter(([, n]) => visible(n)).map(([name, node]) => {
        let description = text(lib.translate[name + '_info'] || ''), publicCards = [];
        try {
          const intro = get.nodeintro?.(node, true);
          if (intro) {
            // Tooltips may retain secret card text in hidden descendant nodes.
            // This temporary tooltip is removed below; sanitize before reading it.
            for (const hidden of intro.querySelectorAll('.infohidden')) hidden.textContent = '暗牌';
            description = text(intro.textContent);
            publicCards = [...intro.querySelectorAll('.button.card')].map(b => ({ visibility: b.classList.contains('infohidden') || b.querySelector('.infohidden') || !text(b.textContent) ? 'hidden' : 'known', label: b.classList.contains('infohidden') || b.querySelector('.infohidden') || !text(b.textContent) ? '暗牌' : text(b.textContent) }));
            intro.remove();
          }
        } catch { /* Public tooltip unavailable; no raw storage fallback. */ }
        return { id: name, name: label(name), count:markCount(name,node,p), text: text(node.innerText), description, cards: publicCards };
      });
      // Expansion visibility is skill-defined. Opponents' x-zone cards may be
      // face down without an infohidden class (e.g. confiscated hand cards).
      out.expansions = p.getExpansions ? p === game.me ? p.getExpansions().map(c => card(c, c.classList.contains('infohidden'))) : { visibility: 'hidden', count: p.getExpansions().length } : { visibility: 'unavailable' };
      if (p === game.me) out.skillState = { used: { ...(p.getStat?.('skill') || {}) }, awakened: p.awakenedSkills || [], disabled: Object.keys(p.disabledSkills || {}), temporary: Object.keys(p.tempSkills || {}) };
    }
    return out;
  }
  function roomConnection() {
    const binding = window.__nonameRoomBinding;
    if (!binding) return null;
    const connected = !!_status.connectMode && (binding.role === 'host' ? !!window.__nonameRoomServer?._server?.listening : !!game.online && game.ws?.readyState === 1);
    const seatMatches = !binding.nativePlayerId || (game.me?.playerid || game.onlineID) === binding.nativePlayerId;
    return { id: binding.id, epoch: binding.epoch, memberId: binding.memberId, role: binding.role, controller: binding.controller, playerId: game.me?.playerid || game.onlineID || null, connected, seatMatches, auto: !!_status.auto, state: !connected ? 'disconnected' : !seatMatches ? 'seat_changed' : _status.waitingForPlayer && !lib.configOL?.gameStarted ? 'lobby' : _status.auto ? 'auto' : 'playing' };
  }
  function choice() {
    const room = roomConnection();
    if (room && (!room.connected || !room.seatMatches || room.auto || room.state === 'lobby')) return null;
    const event = _status.event;
    // Global setup choices (initial-hand redraw) belong to the local UI even
    // when the enclosing gameDraw event's player is a different seat.
    const mine = !!(_status.imchoosing && event);
    if (!mine) { observedChoosing = false; return null; }
    // Also handle a directly observed gap in custom UI that does not use the
    // standard pause methods. Ordinary option/selection changes keep this ID.
    if (!observedChoosing) { observedGeneration++; observedChoosing = true; }
    const options = [], used = new Set();
    const add = (node, kind, name, extra = {}) => {
      if (!visible(node) || used.has(node) || node.classList.contains('disabled')) return;
      used.add(node); options.push({ id: id(node, kind[0]), kind, label: name, selected: selected(node), ...extra });
    };
    for (const c of cards(game.me, 'hes')) if (c.classList.contains('selectable') || selected(c)) add(c, 'card', `${cardLabel(c)} ${label(c.suit)}${c.number}`, { card: card(c) });
    for (const p of game.players || []) if (p.classList.contains('selectable') || selected(p)) add(p, 'target', label(p.name), { player: id(p, 'p') });
    const dialogs = [...new Set([event.dialog, ui.dialog, ...(ui.dialogs || [])])].filter(visible);
    for (const d of dialogs) for (const select of d.querySelectorAll('select')) {
      add(select, 'number', text(select.previousElementSibling?.textContent) || '选择数值', { value: select.value, values: Array.from(select.options).filter(o=>!o.disabled).map(o=>({value:o.value,label:text(o.textContent)})) });
    }
    // Native textbuttons (including voting laws) have no .button class. The
    // dialog registry contains the actual clickable elements; DOM discovery
    // remains necessary for custom dialogs such as chooseToMove.
    for (const d of dialogs) for (const b of new Set([...(d.buttons || []), ...d.querySelectorAll('.button,.textbutton')])) {
      if (!b?.classList || b.classList.contains('noclick') || b.classList.contains('unselectable') || (!b.classList.contains('selectable') && !selected(b) && !event.custom?.replace?.button)) continue;
      // The engine's blank card preset retains its secret card in .link, but
      // deliberately renders no face. Never infer the face from that object.
      const face = text(b.innerText);
      const hidden = b.classList.contains('infohidden') || b.querySelector('.infohidden') || (b.classList.contains('card') && !face);
      add(b, 'button', hidden ? '暗牌' : face || '选项', { visibility: hidden ? 'hidden' : 'known', ...(typeof event.custom?.replace?.button === 'function' ? { interaction: 'custom', selectionCount: (ui.selected?.buttons || []).filter(node => node === b).length } : {}) });
    }
    for (const container of [...new Set([...(ui.controls || []), ui.confirm, ui.skills, ui.skills2, ui.skills3])].filter(visible)) {
      const isSkill = [ui.skills, ui.skills2, ui.skills3].includes(container);
      for (const n of container.children) add(n, isSkill ? 'skill' : n.link === 'ok' ? 'confirm' : n.link === 'cancel' ? 'cancel' : 'control', text(n.innerText) || label(n.link), isSkill ? { skill: n.link, contextSkillCanonical: canonicalSkill(n.link) } : {});
    }
    const groups = (event.buttonss || []).filter(visible).map(n => ({ id: id(n, 'g'), label: text(n.previousSibling?.textContent), buttons: [...n.children].map(b => id(b, 'b')) }));
    for (const g of event.buttonss || []) add(g, 'group', text(g.previousSibling?.textContent));
    const range = key => { try { const v = event[key]; if (v == null) return null; return typeof v === 'function' ? get.select(v) : typeof v === 'number' ? [v, v] : v; } catch { return { visibility: 'unavailable' }; } };
    const scope = window.__nonameRoomPlay?.snapshot?.(event);
    const context = scope?.normal ? { skill: null, actor: id(game.me, 'p'), sourceAction: null, certainty: 'known', transportRequestId: scope.requestId }
      : window.__nonameFlow?.choiceContext(event) || {skill:event.skill||null,certainty:'unknown'};
    return { id: id(event, 'e'), decisionId: `${window.__nonameAgentEpoch}:${id(event, 'e')}:${pauseGeneration}:${observedGeneration}`, event: event.name, context, prompt: dialogs.map(d => text(d.innerText)).filter(Boolean).join('\n').slice(0, 8000) || text(event.prompt || event.name), skill: event.skill || context.skill || null, constraints: { cards: range('selectCard'), targets: range('selectTarget'), buttons: range('selectButton'), forced: !!event.forced }, options, ...(groups.length ? { groups } : {}) };
  }
  function observe(detail = false) {
    const room = roomConnection();
    if (room && !room.seatMatches) return { state: 'disconnected', room, revision: `${window.__nonameAgentEpoch}:${revision}`, me: null, players: [], choice: null, result: null, recent: [] };
    const ch = choice();
    let phase = _status.event?.name || null, phaseId = null;
    for (let ev = _status.event, i = 0; ev && i < 40; i++) {
      if (/^phase(Zhunbei|Judge|Draw|Use|Discard|Jieshu)$/.test(ev.name)) {
        phase = ev.name;
        if (phase === 'phaseUse') phaseId = `${window.__nonameAgentEpoch}:phaseUse:${id(ev, 'e')}`;
        break;
      }
      const parent = ev.parent || ev.getParent?.(); if (parent === ev) break; ev = parent;
    }
    const scope = window.__nonameRoomPlay?.snapshot?.(_status.event);
    if (room?.role === 'guest') {
      phaseId = scope?.phaseId ? `${window.__nonameAgentEpoch}:phaseUse:${scope.phaseId}` : null;
      if (phaseId) phase = 'phaseUse';
    }
    const sig = JSON.stringify([id(_status.event, 'e'), _status.event?.step, phaseId, ch, cards(game.me,'h').map(c=>id(c,'c')), game.me?.hp, !!_status.over, !!game.me?.isDead?.()]);
    if (signature !== sig) { signature = sig; revision++; }
    const all = [...new Set([...(game.players || []), ...(game.dead || [])])];
    const state = room && (!room.connected || !room.seatMatches) ? 'disconnected' : _status.over ? 'over' : game.me?.isDead?.() ? 'dead' : ch ? 'choice' : game.me?.name ? 'running' : 'setup';
    const recent = ui.sidebar ? [...ui.sidebar.children].slice(0, detail ? 50 : 6).map(n => text(n.innerText)).filter(Boolean) : [];
    const log = window.__nonameFlow?.logs();
    const experimentalLog = window.__nonameFlow?.eventLogs?.();
    return { state, ...(room ? { room, capabilities: { effects: room.role === 'guest' ? 'partial_online' : 'local_events', experimentalLog: room.role === 'guest' ? 'partial_online' : 'local_events' } } : {}), revision: `${window.__nonameAgentEpoch}:${revision}`, mode: get.mode(), submode: _status.mode || null, version: lib.version || null, round: game.roundNumber || 0, phase, phaseId, actor: room?.role === 'guest' && phaseId ? id(game.me, 'p') : _status.currentPhase ? id(_status.currentPhase, 'p') : null, victory: victory(), me: game.me ? { ...player(game.me, detail), hand: cards(game.me, 'h').map(c => card(c)) } : null, players: all.filter(p => p !== game.me).map(p => player(p, detail, { teamHand: true })), choice: ch, result: state === 'over' ? result || { visibility: 'unavailable', message: '未捕获结算，请读取结算界面。' } : state === 'dead' ? { outcome: 'death', finalOutcome: 'unobserved' } : null, recent: log ? log.entries.map(e=>e.text) : recent, ...(log ? {log} : {}), ...(experimentalLog ? {experimentalLog} : {}), ...(detail || state === 'over' ? { visibleDialogs: visibleDialogTexts() } : {}), ...(detail ? { auto: !!_status.auto } : {}) };
  }
  async function act(request) {
    const before = observe();
    const fail = (code, message) => ({ ok: false, code, message, state: observe() });
    if (before.room && (!before.room.connected || !before.room.seatMatches)) return fail('room_disconnected', '联机连接或席位已变化；请检查 room status，不要重放动作。');
    if (before.room?.auto) return fail('room_auto', '当前由原生 AI 托管，请先在游戏中解除托管。');
    if (before.room?.controller === 'human') return fail('human_controlled', '此席位由人类通过游戏窗口操作。');
    if (acting) return fail('action_pending', '上一操作仍在执行，请等待后 observe。');
    if (!request.at || request.at !== before.revision) return fail('stale_choice', '选择已变化；使用 observe 返回的新 revision 重试。');
    if (!before.choice) return fail('not_choosing', '当前没有等待你处理的选择。');
    let option = before.choice.options.find(o => o.id === request.id);
    if (!option && ['confirm', 'cancel'].includes(request.id)) option = before.choice.options.find(o => o.kind === request.id);
    if (!option) return fail('option_unavailable', '选项不存在或当前不可选。');
    if (option.interaction === 'custom' && request.unselect) return fail('custom_selection', '该选项使用游戏自定义选择规则；需要清除时使用对话框提供的清除选择或取消。');
    if (option.selected && option.interaction !== 'custom' && !request.unselect && !request.to) return fail('already_selected', '该项已选；取消选择使用 --unselect。');
    if (!option.selected && request.unselect) return fail('not_selected', '该项尚未选择。');
    const node = nodes.get(option.id);
    if (option.kind === 'number') {
      if (request.value == null || !option.values.some(x=>x.value===String(request.value))) return fail('invalid_value', '需要 --value 当前下拉框允许的值。');
      if (String(request.value) === option.value) return fail('already_selected', '该数值已选中，可以确认。');
    } else if (request.value != null) return fail('invalid_value', '--value 仅用于数值下拉框。');
    acting = true;
    try {
      if (request.to) {
        const destination = before.choice.options.find(o => o.id === request.to && ['group', 'button'].includes(o.kind));
        if (!destination || !['button'].includes(option.kind) || !before.choice.groups) return fail('invalid_move', '移动需要当前移动对话框中的按钮和目标区域/按钮。');
        const target = nodes.get(destination.id);
        node.scrollIntoView({ block: 'center' });
        if (!selected(node)) node.click();
        target.scrollIntoView({ block: 'center' });
        const r = target.getBoundingClientRect();
        const x = destination.kind === 'group' ? r.right - 3 : r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || (destination.kind === 'group' ? hit !== target : !(hit === target || target.contains(hit)))) return fail('move_target_obscured', '目标区域空白被遮挡，请选择明确的空白区域或目标牌后重试。');
        const event = new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 0 });
        Object.defineProperty(event, 'which', { value: 1 });
        hit.dispatchEvent(event);
      } else if (option.kind === 'number') { node.value = String(request.value); node.dispatchEvent(new Event('change', { bubbles: true })); }
      else if (option.kind === 'group') return fail('move_required', '移动区域使用 act <按钮id> --to <区域id> --at <revision>。');
      else node.click();
      await new Promise(resolve => setTimeout(resolve, request.to ? 450 : 180));
      const after = observe();
      if (request.to && JSON.stringify(after.choice?.groups) === JSON.stringify(before.choice.groups)) return fail('move_rejected', '游戏未接受移动；检查技能的移动限制并重新观察。');
      if (after.revision === before.revision) return fail('no_effect', '游戏未接受该操作；重新观察后重试，或使用 diagnose 查看弹窗/错误。');
      return { ok: true, action: { id: option.id, kind: option.kind, label: option.label, ...(request.to ? { to: request.to } : {}) }, state: after };
    } finally { acting = false; }
  }
  async function actMany(request) {
    const actions = [], original = _status.event, originalDecision = observe().choice?.decisionId;
    let at = request.at, last;
    for (const optionId of request.ids) {
      const current = observe();
      if (_status.event !== original || current.choice?.decisionId !== originalDecision) return {ok:false,code:'choice_changed',message:'组合操作遇到新的选择，已停止。已完成动作见 actions，请阅读新状态再决定。',actions,state:current};
      last = await act({id:optionId,at});
      if (!last.ok) return {...last,actions};
      actions.push(last.action); at=last.state.revision;
    }
    return {ok:true,actions,state:last?.state||observe()};
  }
  window.__nonameAgentEpoch = Math.random().toString(36).slice(2, 9);
  const api = { observe, act, actMany,
    inspect(request) { const p = [...(game.players||[]),...(game.dead||[])].find(p=>id(p,'p')===request.id); if (!p) return {ok:false,code:'player_unavailable',message:'角色不存在；请使用 observe 中的角色 id。'}; const v=player(p,true); return {ok:true,id:v.id,name:v.name,label:v.label,skills:v.skills,globalSkills:v.globalSkills,marks:v.marks,...(p===game.me?{skillState:v.skillState}: {})}; },
    logs(request) { return window.__nonameFlow?.logs(request)||{entries:[]}; },
    eventLogs(request) { return window.__nonameFlow?.eventLogs?.(request)||{source:'eventflow',coverage:'unavailable',entries:[]}; },
    effects() {
      const value = window.__nonameFlow?.effects() || { actions: [] };
      const receipts = window.__nonameRoomPlay?.receipts?.() || [];
      return receipts.length ? { ...value, actions: [...value.actions, ...receipts] } : value;
    },
    commitLogs(request) { const f=window.__nonameFlow; if(f?.commitFeedback) return f.commitFeedback(request); if(f && f.logs().epoch===request.epoch) { f.commitLogs(request.to); return {ok:true}; } return {ok:false,code:'log_epoch_changed'}; },
    rule(name) { return lib.skill[name] ? skill(name, game.me) : lib.card[name] ? { id: name, name: label(name), description: text(lib.translate[name + '_info'] || '') } : { error: 'unknown_rule', id: name }; } };
  for (const method of ['inspect', 'logs', 'eventLogs', 'effects', 'rule']) {
    const read = api[method];
    api[method] = (...args) => {
      const room = roomConnection();
      if (room && !room.seatMatches) throw Error('room_seat_changed: 席位已变化；请检查 room status。');
      const value = read(...args);
      return room?.role === 'guest' && ['eventLogs', 'effects'].includes(method) ? { ...value, transportCoverage: 'partial_online' } : value;
    };
  }
  window.__nonameAgent = api;
  return api;
}

const { installFlow } = require('./flow.cjs');
const { createEventJournal } = require('./event-journal.cjs');
const { installRoomPlay } = require('./room-play.cjs');
const { ENTRY_READY_EXPRESSION } = require('./native-bootstrap.cjs');
const observationPrelude = `if(document.readyState==='loading')throw new Error('page_loading: 页面正在解析，请稍后 observe 或 wait');if(window.__oneshotNativeDialogInstalled && !(${ENTRY_READY_EXPRESSION}))throw new Error('entry_not_ready: 原客户端入口或模块映射尚未就绪');const m=await import('/noname.js');(${installRoomPlay.toString()})(m);const flow=(${installFlow.toString()})(m,(${createEventJournal.toString()}));`;
const observationExpression = () => `(async()=>{${observationPrelude}return {ok:true,epoch:flow.logs().epoch,eventEpoch:flow.eventLogs().epoch};})()`;
const expression = (method, arg) => `(async()=>{${observationPrelude}const api=(${installPage.toString()})(m);return await api[${JSON.stringify(method)}](${JSON.stringify(arg)});})()`;
const installObservation = cdp => cdp.evaluate(observationExpression());
const observe = (cdp, detail = false) => cdp.evaluate(expression('observe', detail));
const act = (cdp, request) => cdp.evaluate(expression('act', request));
const actMany = (cdp, request) => cdp.evaluate(expression('actMany', request));
const rule = (cdp, name) => cdp.evaluate(expression('rule', name));
const inspect = (cdp, request) => cdp.evaluate(expression('inspect', request));
const logs = (cdp, request) => cdp.evaluate(expression('logs', request));
const eventLogs = (cdp, request) => cdp.evaluate(expression('eventLogs', request));
const effects = cdp => cdp.evaluate(expression('effects'));
const commitLogs = (cdp, request) => cdp.evaluate(expression('commitLogs', request));
module.exports = { installPage, expression, observationExpression, installObservation, observe, act, actMany, rule, inspect, logs, eventLogs, effects, commitLogs };
