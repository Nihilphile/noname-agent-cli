'use strict';
const fs = require('node:fs');
const session = require('./session.cjs');
const rooms = require('./room.cjs');
const setup = require('./room-setup.cjs');
const runtime = require('./test-room-runtime.cjs');
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_test_lineup', 'Lineup must be an object.');
  for (const key of Object.keys(input)) if (!['mode', 'seats'].includes(key)) fail('invalid_test_lineup', `Unknown lineup field: ${key}`);
  const { mode, seats } = input;
  if (!['doudizhu', '2v2'].includes(mode)) fail('invalid_test_lineup', 'Lineup mode must be doudizhu or 2v2.');
  if (!Array.isArray(seats) || seats.length !== (mode === '2v2' ? 4 : 3)) fail('invalid_test_lineup', 'Specify every seat: three for doudizhu, four for 2v2.');
  const normalized = seats.map(s => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail('invalid_test_lineup', 'Each seat must be an object.');
    for (const key of Object.keys(s)) if (!['session', 'character', mode === '2v2' ? 'team' : 'identity'].includes(key)) fail('invalid_test_lineup', `Unknown seat field: ${key}`);
    if (typeof s.session !== 'string') fail('invalid_test_lineup', 'Each seat requires a session.');
    session.sessionDir(s.session);
    if (typeof s.character !== 'string' || !s.character.trim() || s.character !== s.character.trim() || /[\x00-\x1f/\\]/.test(s.character) || ['__proto__', 'constructor', 'prototype'].includes(s.character)) fail('invalid_test_lineup', 'Use an exact character ID.');
    if (mode === '2v2' ? !['A', 'B'].includes(s.team) : !['zhu', 'fan'].includes(s.identity)) fail('invalid_test_lineup', 'Specify team A/B or identity zhu/fan for each seat.');
    return { ...s };
  });
  if (new Set(normalized.map(s => s.session.toLowerCase())).size !== seats.length) fail('invalid_test_lineup', 'Sessions must be unique (case insensitive).');
  if (new Set(normalized.map(s => s.character)).size !== seats.length) fail('invalid_test_lineup', 'Duplicate characters are not supported.');
  if (mode === '2v2' ? normalized.filter(s => s.team === 'A').length !== 2 : normalized.filter(s => s.identity === 'zhu').length !== 1) fail('invalid_test_lineup', 'Use two players per team, or one landlord and two farmers.');
  return { mode, seats: normalized };
}

async function create(id, options = {}) {
  const input = typeof options.lineup === 'string' ? JSON.parse(fs.readFileSync(options.lineup, 'utf8').replace(/^\uFEFF/, '')) : options.lineup;
  const lineup = validate(input);
  if (options.mode || options.session || options.host) fail('invalid_test_options', 'Lineup supplies mode and sessions; first seat is the agent host.');
  // Preflight all session names before creating any process.
  for (const seat of lineup.seats) {
    const previous = [session.read(seat.session), require('./native-session.cjs').read(seat.session)];
    if (previous.some(s => s && !s.cleanupComplete)) fail('session_in_use', `Session ${seat.session} already exists.`);
  }
  let created = false;
  try {
    await rooms.create(id, { ...options, mode: lineup.mode, session: lineup.seats[0].session, host: 'agent', testRoom: { lineup, status: 'configured' } });
    created = true;
    for (const seat of lineup.seats.slice(1)) await rooms.join(id, { session: seat.session, visible: options.visible, browser: options.browser });
    return rooms.status(id);
  } catch (error) {
    if (created) { const cleanup = await rooms.close(id); if (!cleanup.ok) error.message += ` Cleanup incomplete: ${cleanup.error}`; }
    throw error;
  }
}

async function connected(member, fn) {
  const { cdp } = await session.connect(member.session);
  try { return await fn(cdp); }
  catch (error) {
    const code = error.message.match(/\b(test_[a-z_]+)(?=:|\n|$)/)?.[1];
    if (code) error.code = code;
    throw error;
  } finally { cdp.close(); }
}

// Internal room lifecycle hooks: called under room's existing lifecycle lock.
async function beforeStart(room) {
  const lineup = validate(room.testRoom.lineup);
  if (lineup.mode !== room.mode || room.members.length !== lineup.seats.length) fail('test_roster_mismatch', 'Room does not match the frozen lineup.');
  const seats = lineup.seats.map((seat, i) => {
    const member = room.members.find(m => m.session === seat.session && m.state === 'joined');
    if (!member || (member.role === 'host') !== (i === 0)) fail('test_roster_mismatch', `Missing or changed seat: ${seat.session}`);
    return { ...seat, host: member.role === 'host', playerId: member.nativePlayerId || null };
  });
  for (const member of room.members) await connected(member, cdp => setup.evaluate(cdp, runtime.catalog, lineup));
  const host = room.members.find(m => m.role === 'host');
  return connected(host, cdp => setup.evaluate(cdp, runtime.install, { mode: lineup.mode, seats }));
}

async function afterStart(room) {
  const deadline = Date.now() + 30000;
  const lineup = room.testRoom.lineup;
  let snapshots = [];
  while (Date.now() < deadline) {
    for (const seat of lineup.seats) {
      await session.withLock(seat.session, () => connected(seat, cdp => setup.evaluate(cdp, runtime.select, seat)));
    }
    snapshots = [];
    for (const member of room.members) snapshots.push({ session: member.session, ...(await connected(member, cdp => setup.evaluate(cdp, runtime.snapshot))) });
    if (snapshots.some(s => !s.connected || s.auto)) fail('test_room_disconnected', 'A test participant disconnected or entered auto control.');
    const expected = lineup.seats.map(seat => ({ ...seat, playerId: room.members.find(m => m.session === seat.session).nativePlayerId }));
    let complete = true;
    for (const snapshot of snapshots) {
      if (snapshot.me !== expected.find(s => s.session === snapshot.session).playerId) fail('test_roster_mismatch', 'Client changed seats.');
      for (const seat of expected) {
        const actual = snapshot.players.find(p => p.playerId === seat.playerId);
        if (!actual?.character) { complete = false; continue; }
        if (actual.character !== seat.character || (lineup.mode === '2v2' ? actual.team !== seat.team : actual.identity !== seat.identity)) fail('test_lineup_mismatch', `${snapshot.session}: ${seat.session} does not match the lineup.`);
      }
    }
    if (complete) return { status: 'verified', verifiedAt: new Date().toISOString(), snapshots };
    await sleep(150);
  }
  fail('test_selection_timeout', 'Native character selection did not finish within 30 seconds.');
}

function required(id) {
  if (!rooms.read(id)?.testRoom) fail('not_test_room', `Room ${id} is not a test room.`);
}
async function start(id) { required(id); return rooms.start(id); }
async function status(id) { required(id); return rooms.status(id); }
async function close(id) { required(id); return rooms.close(id); }
function format(value) {
  const t = value.testRoom;
  return [`测试房 ${value.room} | ${value.mode} | ${value.state} | ${t.status}`,
    ...t.lineup.seats.map(s => {
      const connection = value.members.find(m => m.session === s.session)?.connection;
      return `${s.session} → ${s.character} | ${s.team || s.identity}${connection ? connection.connected ? ' | 已连接' : ' | 已断开' : ''}`;
    }),
    ...(t.error ? [t.error] : []), ...(value.error ? [value.error] : [])].join('\n');
}
module.exports = { create, start, status, close, format, validate, beforeStart, afterStart };
