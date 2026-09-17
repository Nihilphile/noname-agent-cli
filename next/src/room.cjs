'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const session = require('./session.cjs');
const setup = require('./room-setup.cjs');
const notifications = require('./notification.cjs');
const extensions = require('./extensions.cjs');
const contentProfiles = require('./content-profile.cjs');
function extensionOptions(room) {
  const bundle = room.extensionBundle || [];
  for (const e of bundle) require('./extension-files.cjs').verifyFiles(e.root, e.files);
  return contentProfiles.merge(room.contentProfile || {}, contentProfiles.fromExtensionBundle(bundle));
}
const ROOT = path.resolve(__dirname, '../state/_rooms');
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
function filename(id) { session.sessionDir(id); return path.join(ROOT, `${id}.json`); }
function read(id) { const file = filename(id); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
function write(room) { const file = filename(room.id); fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(room, null, 2)); fs.renameSync(file + '.tmp', file); }
function required(id) { return read(id) || fail('room_absent', `Room ${id} does not exist.`); }
const locked = (id, fn) => session.withLock(`room-${id}`, fn);
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(err => err ? reject(err) : resolve(port)); }); });
function validate({ id, mode = 'doudizhu', host = 'human', timeout = 600 }) {
  filename(id);
  if (!['doudizhu', '2v2'].includes(mode)) fail('unsupported_room_mode', 'room supports doudizhu or 2v2.');
  if (!['human', 'agent'].includes(host)) fail('invalid_controller', '--host must be human or agent.');
  if (!Number.isInteger(Number(timeout)) || Number(timeout) < 10 || Number(timeout) > 3600) fail('invalid_room_timeout', '--turn-seconds must be 10..3600.');
  return { mode, host, timeout: Number(timeout) };
}
async function available(name) {
  session.sessionDir(name);
  const prior = session.read(name);
  if (prior && !prior.cleanupComplete) fail('session_in_use', `Session ${name} already exists; choose another name.`);
  const native = require('./native-session.cjs').read(name);
  if (native && !native.cleanupComplete) fail('session_in_use', `Native session ${name} already exists.`);
}
async function connected(name, fn) { const { cdp } = await session.connect(name); try { return await fn(cdp); } finally { cdp.close(); } }
function own(room, member) {
  const state = session.read(member.session);
  if (!state || state.room?.id !== room.id || state.room?.epoch !== room.epoch || state.room?.memberId !== member.id) fail('room_ownership_mismatch', `Session ${member.session} no longer belongs to this room.`);
  return state;
}
function summary(room) {
  return { ok: true, room: room.id, state: room.state, mode: room.mode, address: room.address, turnSeconds: room.timeout, contentProfile: contentProfiles.resolve(room.contentProfile || {}), extensions:(room.extensionBundle || []).map(e => ({name:e.name,sha256:e.sha256})), members: room.members.map(m => ({ session: m.session, role: m.role, controller: m.controller, playerId: m.nativePlayerId || null, state: m.state })), ...(room.error ? { error: room.error } : {}) };
}
async function create(id, options = {}) {
  const config = validate({ id, ...options });
  return locked(id, async () => {
    if (read(id) && read(id).state !== 'closed') fail('room_exists', 'Room already exists; close it explicitly before recreating.');
    const name = options.session || `${id}-host`;
    return session.withLock(name, async () => {
      await available(name);
      const port = await freePort();
      const member = { id: crypto.randomUUID(), session: name, role: 'host', controller: config.host, state: 'starting' };
      const room = { id, epoch: crypto.randomUUID(), ...config, source: path.resolve(options.source || session.DEFAULT_SOURCE), contentProfile: contentProfiles.resolve(options), address: `ws://127.0.0.1:${port}`, state: 'creating', members: [member], createdAt: new Date().toISOString() };
      room.extensionBundle = extensions.snapshot();
      write(room);
      try {
        await session.start({ session: name, source: room.source, contentProfile: room.contentProfile, extensionBundle:room.extensionBundle, visible: config.host === 'human' || !!options.visible, roomHost: { wsPort: port }, room: { id, epoch: room.epoch, memberId: member.id, role: 'host', controller: member.controller } });
        session.update(name, { room: { id, epoch: room.epoch, memberId: member.id, role: 'host', controller: member.controller } });
        await connected(name, async cdp => { const content = extensionOptions(room); await setup.prepare(cdp, { mode: room.mode, nickname: '房主', timeout: room.timeout, ...content }); await setup.host(cdp, { ...room, ...content }); });
        member.state = 'joined'; room.state = 'lobby'; write(room); return summary(room);
      } catch (error) { room.state = 'failed'; room.error = error.message; member.state = 'failed'; write(room); throw error; }
    });
  });
}
async function join(id, options = {}) {
  const name = options.session;
  if (!name) fail('session_required', 'room join requires --session NAME.');
  return locked(id, async () => {
    const room = required(id);
    if (room.state !== 'lobby') fail('room_not_joinable', 'Join before the room starts.');
    if (room.members.filter(m => m.state !== 'left').length >= (room.mode === '2v2' ? 4 : 3)) fail('room_full', 'Room is full.');
    if (room.members.some(m => m.session === name)) fail('member_exists', 'This session is already registered in the room.');
    return session.withLock(name, async () => {
      await available(name);
      const member = { id: crypto.randomUUID(), session: name, role: 'guest', controller: 'agent', state: 'starting' };
      room.members.push(member); write(room);
      try {
        await session.start({ session: name, source: room.source, contentProfile: room.contentProfile, extensionBundle:room.extensionBundle, visible: !!options.visible, browser: options.browser, room: { id, epoch: room.epoch, memberId: member.id, role: 'guest', controller: member.controller } });
        session.update(name, { room: { id, epoch: room.epoch, memberId: member.id, role: 'guest', controller: member.controller } });
        const joined = await connected(name, async cdp => { await setup.prepare(cdp, { mode: room.mode, nickname: name.slice(-12), timeout: room.timeout, ...extensionOptions(room) }); return setup.join(cdp, room.address); });
        member.nativePlayerId = joined.onlineID; member.state = 'joined';
        session.update(name, { room: { ...session.read(name).room, nativePlayerId: member.nativePlayerId } });
        write(room); return summary(room);
      } catch (error) { member.state = 'failed'; member.error = error.message; write(room); throw error; }
    });
  });
}
async function start(id) {
  return locked(id, async () => {
    const room = required(id), members = room.members.filter(m => m.state !== 'left');
    if (room.state !== 'lobby') fail('room_not_waiting', 'Room is not waiting for start.');
    if (members.length !== (room.mode === '2v2' ? 4 : 3) || members.some(m => m.state !== 'joined')) fail('room_not_ready', 'All seats must have joined successfully.');
    for (const member of members) { own(room, member); const s = await connected(member.session, setup.status); if (!s.connected || !s.waiting) fail('member_not_ready', `${member.session} is not connected in the lobby.`); }
    const host = members.find(m => m.role === 'host');
    await session.withLock(host.session, () => connected(host.session, async cdp => {
      const s = await setup.status(cdp);
      if (s.peers?.length !== members.length || members.filter(m => m.role === 'guest').some(m => !s.peers.some(p => p.id === m.nativePlayerId))) fail('room_roster_mismatch', 'Native roster does not match registered members.');
      await setup.start(cdp);
      room.state = 'playing'; write(room);
      const assigned = await setup.poll(cdp, ({ game }) => ({ ready: !!game.me?.playerid, playerId: game.me?.playerid }), null, 'host seat assignment');
      host.nativePlayerId = assigned.playerId;
      session.update(host.session, { room: { ...session.read(host.session).room, nativePlayerId: host.nativePlayerId } });
    }));
    write(room); return summary(room);
  });
}
async function status(id) {
  const room = required(id), out = summary(room);
  for (let i = 0; i < room.members.length; i++) {
    const member = room.members[i];
    if (member.state === 'left') continue;
    try { own(room, member); out.members[i].connection = await connected(member.session, setup.status); }
    catch (e) { out.members[i].connection = { connected: false, error: e.message }; }
  }
  return out;
}
async function leave(id, name) {
  return locked(id, async () => {
    const room = required(id), member = room.members.find(m => m.session === name);
    if (!member) fail('member_absent', 'Session is not a member of this room.');
    if (member.role === 'host') fail('host_leave_requires_close', `Host owns the room; use room close ${id} to end it for everyone.`);
    if (member.state === 'left') return summary(room);
    await session.withLock(name, async () => { own(room, member); notifications.disable(session.sessionDir(name), 'room_left'); const stopped = await session.stop(name); if (!stopped.ok) fail('cleanup_incomplete', stopped.message); });
    member.state = 'left'; write(room); return summary(room);
  });
}
async function close(id) {
  return locked(id, async () => {
    const room = required(id);
    if (room.state === 'closed') return summary(room);
    const failures = [];
    for (const member of [...room.members].reverse()) {
      if (member.state === 'left') continue;
      try {
        await session.withLock(member.session, async () => {
          const state = session.read(member.session);
          if ((!state || state.cleanupComplete) && member.state === 'failed') return;
          own(room, member);
          notifications.disable(session.sessionDir(member.session), 'room_closed');
          const stopped = await session.stop(member.session);
          if (!stopped.ok) fail('cleanup_incomplete', stopped.message);
        });
        member.state = 'left'; write(room);
      } catch (error) { failures.push(`${member.session}: ${error.message}`); }
    }
    room.state = failures.length ? 'cleanup_incomplete' : 'closed'; room.error = failures.join('; ') || null; write(room);
    return { ...summary(room), ok: !failures.length };
  });
}
module.exports = { create, join, start, status, leave, close, read, validate };
