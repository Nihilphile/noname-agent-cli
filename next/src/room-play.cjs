'use strict';

// Serialized into each room renderer. The host supplies only the recipient's
// phase scope and direct-card submission receipts over the existing connection.
// No hands, full host event tree, or effect-completeness claims cross this seam.
function installRoomPlay({ lib, game, _status }) {
  if (window.__nonameRoomPlay) return window.__nonameRoomPlay;
  const binding = window.__nonameRoomBinding;
  if (!binding) return null;
  const parent = e => e?.parent;
  const phaseOf = e => {
    const seen = new Set();
    for (let n = e; n && !seen.has(n); n = parent(n)) {
      if (n.name === 'phaseUse') return n;
      seen.add(n);
    }
    return null;
  };
  const nature = c => Array.isArray(c?.nature) ? c.nature.join('|') : c?.nature || '';
  if (binding.role === 'host') {
    const prototype = lib.element?.GameEvent?.prototype;
    if (!prototype?.send || !prototype?.loop) return null;
    const ids = new WeakMap(), witnessed = new WeakSet();
    const epoch = `room-play-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let serial = 0;
    const id = event => { if (!ids.has(event)) ids.set(event, `${epoch}:${++serial}`); return ids.get(event); };
    const send = (player, payload) => {
      try { player?.send?.(function (message) { window.__nonameRoomPlay?.receive(message); }, { ...payload, roomEpoch: binding.epoch, epoch, playerId: player.playerid }); }
      catch { /* A missing receipt stops the pipeline; never alter the engine. */ }
    };
    const originalSend = prototype.send;
    prototype.send = function (...args) {
      try {
        const phase = phaseOf(this);
        const normal = this.name === 'chooseToUse' && this.type === 'phase' && parent(this) === phase && phase?.player === this.player && !this.skill && !this._trigger && !this.relatedEvent;
        this.set('_nonameRoomPlayRequest', { roomEpoch: binding.epoch, epoch, playerId: this.player?.playerid, requestId: `${id(this)}:request:${++serial}`, phaseId: phase?.player === this.player ? id(phase) : null, normal });
      } catch { /* Unsupported custom events remain untrusted. */ }
      return originalSend.apply(this, args);
    };
    const originalLoop = prototype.loop;
    prototype.loop = function (...args) {
      try {
        const request = parent(this)?._nonameRoomPlayRequest;
        const material = this.cards?.length === 1 ? this.cards[0] : null;
        if (!witnessed.has(this) && this.name === 'useCard' && request?.normal && request.playerId === this.player?.playerid &&
          material?.cardid && !this.skill && material.name === this.card?.name && nature(material) === nature(this.card)) {
          witnessed.add(this);
          send(this.player, { type: 'accepted', id: id(this), phaseId: request.phaseId, requestId: request.requestId,
            cardId: material.cardid, name: this.card.name, targets: (this.targets || []).map(p => p.playerid) });
        }
      } catch { /* Receipt projection must not own execution. */ }
      const value = originalLoop.apply(this, args);
      if (this.name === 'phaseUse') {
        const ended = () => send(this.player, { type: 'phaseEnd', phaseId: id(this) });
        if (value?.then) value.then(ended, () => {}); else ended();
      }
      return value;
    };
    return window.__nonameRoomPlay = { epoch, receive() {} };
  }
  if (binding.role !== 'guest') return null;
  const cards = new Map(), records = new Map(), ended = new Set();
  let phaseId = null, epoch = null;
  const valid = value => value?.roomEpoch === binding.epoch && value.playerId === window.__nonameRoomBinding?.nativePlayerId && typeof value.epoch === 'string';
  const api = {
    rememberCard(card, localId) { if (card?.cardid && typeof localId === 'string') cards.set(card.cardid, localId); },
    snapshot(event) {
      const request = event?._nonameRoomPlayRequest;
      const scoped = valid(request);
      if (scoped) {
        epoch = request.epoch;
        if (request.phaseId && !ended.has(request.phaseId)) phaseId = request.phaseId;
      }
      return { phaseId, epoch, requestId: scoped ? request.requestId : null,
        normal: !!(scoped && request.normal && phaseId === request.phaseId && !ended.has(request.phaseId) && event.name === 'chooseToUse' && event.type === 'phase' && event.player === game.me && !event.skill && !event._trigger && !event.relatedEvent) };
    },
    receive(message) {
      if (!valid(message)) return;
      epoch = message.epoch;
      if (message.type === 'phaseEnd') {
        ended.add(message.phaseId); if (phaseId === message.phaseId) phaseId = null;
        return;
      }
      if (message.type !== 'accepted' || !cards.has(message.cardId) || typeof message.id !== 'string') return;
      const players = [...(game.players || []), ...(game.dead || [])];
      const resolve = native => { const p = players.find(p => p.playerid === native); return p && window.__nonameFlow?.playerId(p); };
      const actor = resolve(message.playerId), targets = (message.targets || []).map(resolve);
      if (!actor || targets.some(id => !id)) return;
      records.set(message.id, { id: message.id, kind: 'card', actor, name: message.name, targets, status: 'pending',
        physicalCards: [cards.get(message.cardId)], physicalMode: 'direct', confirmation: 'host_accepted', requestId: message.requestId,
        phaseId: message.phaseId, coverage: 'partial', effectCompleteness: {}, effects: [] });
      if (records.size > 200) records.delete(records.keys().next().value);
    },
    receipts() { return Array.from(records.values()); },
  };
  return window.__nonameRoomPlay = api;
}
module.exports = { installRoomPlay };
