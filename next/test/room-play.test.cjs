'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installRoomPlay } = require('../src/room-play.cjs');
function fixture() {
  const sent = [];
  class GameEvent {
    constructor(name, values = {}) { Object.assign(this, { name, _set: [] }, values); }
    set(k, v) { this[k] = v; this._set.push([k,v]); return this; }
    send() { return this; }
    loop() { return this.work ? this.work() : Promise.resolve(); }
  }
  const player = { playerid: 'guest', send(_callback, payload) { sent.push(structuredClone(payload)); } };
  const host = { __nonameRoomBinding: { role: 'host', epoch: 'room' } };
  const guest = { __nonameRoomBinding: { role: 'guest', epoch: 'room', nativePlayerId: 'guest' } };
  const me = { playerid: 'guest' }, other = { playerid: 'other', getCards() { throw Error('private hand'); } };
  const hostAPI = vm.runInNewContext(`(${installRoomPlay})`, { window: host })({ lib: { element: { GameEvent } }, game: { online: false }, _status: {} });
  guest.__nonameFlow = { playerId: p => p === me ? 'p1' : 'p2' };
  const guestAPI = vm.runInNewContext(`(${installRoomPlay})`, { window: guest })({ lib: {}, game: { online: true, me, players: [me,other] }, _status: {} });
  const phase = new GameEvent('phaseUse', { player });
  const request = new GameEvent('chooseToUse', { player, parent: phase, type: 'phase' });
  request.send();
  const local = { name: 'chooseToUse', type: 'phase', player: me, _nonameRoomPlayRequest: structuredClone(request._nonameRoomPlayRequest) };
  return { GameEvent, sent, player, me, other, phase, request, local, hostAPI, guestAPI };
}
test('guest keeps authoritative phase across remote decisions and gets only its own host submission receipt', async () => {
  const f = fixture();
  const initial = f.guestAPI.snapshot(f.local); assert.equal(initial.normal, true); assert.ok(initial.phaseId);
  f.guestAPI.rememberCard({ cardid: 'native-card', name: 'sha' }, 'c1');
  assert.equal(f.guestAPI.receipts().length, 0, 'selection alone is not a receipt');
  const action = new f.GameEvent('useCard', { player: f.player, parent: f.request, card: { name: 'sha' }, cards: [{ cardid: 'native-card', name: 'sha' }], targets: [{ playerid: 'other' }] });
  await action.loop();
  for (const row of f.sent) f.guestAPI.receive(row);
  const rows = f.guestAPI.receipts(); assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'p1'); assert.equal(rows[0].physicalCards[0], 'c1'); assert.equal(rows[0].targets[0], 'p2');
  assert.equal(rows[0].confirmation, 'host_accepted'); assert.equal(rows[0].coverage, 'partial');
  for (const row of f.sent) f.guestAPI.receive(row);
  assert.equal(f.guestAPI.receipts().length, 1, 'duplicate delivery cannot manufacture another receipt');
  assert.equal(f.guestAPI.snapshot({ name: 'game' }).phaseId, initial.phaseId);
  await f.phase.loop(); for (const row of f.sent) f.guestAPI.receive(row);
  assert.equal(f.guestAPI.snapshot(f.local).phaseId, null, 'old choice cannot reopen a completed phase');
});
test('converted cards, foreign epochs and unmatched cards cannot become direct-play receipts', async () => {
  const f = fixture(); f.guestAPI.snapshot(f.local); f.guestAPI.rememberCard({ cardid: 'native-card' }, 'c1');
  const props = { player: f.player, parent: f.request, card: { name: 'sha' }, cards: [{ cardid: 'native-card', name: 'shan' }], targets: [] };
  await new f.GameEvent('useCard', props).loop();
  for (const row of f.sent) f.guestAPI.receive(row);
  assert.equal(f.guestAPI.receipts().length, 0);
  await new f.GameEvent('useCard', { ...props, cards: [{ cardid: 'unseen-card', name: 'sha' }] }).loop();
  for (const row of f.sent) f.guestAPI.receive(row);
  assert.equal(f.guestAPI.receipts().length, 0);
  await new f.GameEvent('useCard', { ...props, cards: [{ cardid: 'native-card', name: 'sha' }] }).loop();
  for (const row of f.sent) f.guestAPI.receive({ ...row, roomEpoch: 'another-room' });
  assert.equal(f.guestAPI.receipts().length, 0);
  for (const row of f.sent) f.guestAPI.receive({ ...row, playerId: 'other' });
  assert.equal(f.guestAPI.receipts().length, 0);
});
test('nested prompts stay untrusted and a new phase cannot inherit the prior phase identity', () => {
  const f = fixture(); const first = f.guestAPI.snapshot(f.local);
  assert.equal(f.guestAPI.snapshot({ name: 'chooseToUse', type: 'phase', player: f.me, parent: f.local }).normal, false);
  const phase = new f.GameEvent('phaseUse', { player: f.player });
  const request = new f.GameEvent('chooseToUse', { type: 'phase', player: f.player, parent: phase }); request.send();
  const next = f.guestAPI.snapshot({ ...f.local, _nonameRoomPlayRequest: request._nonameRoomPlayRequest });
  assert.notEqual(next.phaseId, first.phaseId);
});
test('bridge preserves engine loop return identity and observation send failures cannot break play', async () => {
  const f = fixture(); const promise = Promise.resolve('original');
  const event = new f.GameEvent('phaseUse', { player: f.player, work: () => promise });
  f.player.send = () => { throw Error('closed socket'); };
  assert.equal(event.loop(), promise); await promise;
});
