'use strict';
// Durable public event batches. Evidence is a recovery source, never a second
// event stream: the journal epoch and sequence identify an event in both files.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const { createHash } = require('node:crypto');
const { formatExperimental } = require('./experimental-format.cjs');
const archiveFile = dir => path.join(dir, 'game-log.jsonl');
const gameId = epoch => 'g-' + createHash('sha256').update(epoch).digest('hex').slice(0, 16);

function append(dir, log, meta = {}, time = new Date().toISOString()) {
  if (log?.source !== 'eventflow' || !log.epoch || !Number.isSafeInteger(log.to)) throw Error('Invalid experimental journal batch');
  fs.mkdirSync(dir, { recursive: true });
  // A leading newline isolates a torn previous append without deleting evidence.
  const fd = fs.openSync(archiveFile(dir), 'a');
  try { fs.writeFileSync(fd, '\n' + JSON.stringify({ version: 1, time, log, meta }) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

async function load(dir) {
  const games = new Map(), warnings = [];
  function add(log, meta, time, origin) {
    if (log?.source !== 'eventflow' || typeof log.epoch !== 'string' || !Number.isSafeInteger(log.to) || log.to < 0 || !Array.isArray(log.entries)) return;
    let game = games.get(log.epoch);
    if (!game) {
      game = { id: gameId(log.epoch), epoch: log.epoch, rows: new Map(), sources: new Set(), players: new Map(), firstSeen: time || null, lastSeen: time || null, to: 0, meta: {}, metaTime: '', context: null };
      games.set(log.epoch, game);
    }
    game.sources.add(origin);
    if (time && (!game.firstSeen || time < game.firstSeen)) game.firstSeen = time;
    if (time && (!game.lastSeen || time > game.lastSeen)) game.lastSeen = time;
    game.to = Math.max(game.to, log.to);
    for (const row of log.entries) if (Number.isSafeInteger(row?.seq) && row.seq > 0 && row.seq <= log.to) game.rows.set(row.seq, row);
    for (const p of Array.isArray(log.players) ? log.players : []) if (p?.id && (!game.players.has(p.id) || (time || '') >= game.metaTime)) game.players.set(p.id, p);
    if ((time || '') >= game.metaTime) { game.meta = { ...game.meta, ...meta }; game.metaTime = time || ''; game.context = log.context || game.context; }
    if (log.transportCoverage) game.transportCoverage = log.transportCoverage;
    if (log.samplingErrors?.length) game.samplingErrors = log.samplingErrors;
  }
  // Recover old CLI feedback first; continuous archives fill its missing ranges.
  for (const [file, origin] of [[path.join(dir, 'evidence.jsonl'), 'evidence'], [archiveFile(dir), 'recorder']]) {
    if (!fs.existsSync(file)) continue;
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let invalid = 0;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { invalid++; continue; }
        if (!row || typeof row !== 'object' || Array.isArray(row)) { invalid++; continue; }
        if (origin === 'recorder') add(row.log, row.meta, row.time, origin);
        else {
          const output = row.output, time = row.time || row.timestamp;
          const state = output?.state && typeof output.state === 'object' ? output.state : output;
          const meta = { ...(typeof state?.state === 'string' ? { state: state.state } : {}), ...(state?.mode ? { mode: state.mode } : {}), ...(state?.result ? { result: state.result } : {}) };
          for (const log of [output, output?.experimentalLog, output?.log, state?.experimentalLog, state?.log]) add(log, meta, time, origin);
        }
      }
    } finally { lines.close(); input.destroy(); }
    if (invalid) warnings.push(`${path.basename(file)}：跳过 ${invalid} 行损坏或未写完的记录`);
  }
  const values = [...games.values()].map(g => {
    const entries = [...g.rows.values()].sort((a, b) => a.seq - b.seq), gaps = [];
    let next = 1;
    for (const entry of entries) { if (entry.seq > next) gaps.push({ from: next, to: entry.seq - 1 }); next = entry.seq + 1; }
    if (next <= g.to) gaps.push({ from: next, to: g.to });
    return { id: g.id, epoch: g.epoch, firstSeen: g.firstSeen, lastSeen: g.lastSeen, sources: [...g.sources], ...g.meta,
      count: entries.length, gaps, startVerified: false, endObserved: g.meta.state === 'over',
      log: { source: 'eventflow', epoch: g.epoch, from: entries[0]?.seq ?? g.to + 1, to: g.to, entries, players: [...g.players.values()], context: g.context,
        coverage: 'experimental_partial', truncated: gaps.length > 0, ...(g.transportCoverage ? { transportCoverage: g.transportCoverage } : {}), ...(g.samplingErrors ? { samplingErrors: g.samplingErrors } : {}) } };
  }).filter(g => g.count || g.log.players.length).sort((a, b) => (a.firstSeen || '').localeCompare(b.firstSeen || ''));
  return { games: values, warnings };
}

function select(archive, { game = 'latest', from = 1, to = Number.MAX_SAFE_INTEGER, round } = {}) {
  const selected = game === 'latest' ? archive.games.at(-1) : archive.games.find(g => g.id === game || g.epoch === game);
  if (!selected) return { kind: 'game-log', ok: false, code: 'game_log_unavailable', message: '没有找到实验战报。用 logs games 查看记录；人类开局前用 watch on 开启记录。', warnings: archive.warnings };
  const entries = selected.log.entries.filter(e => e.seq >= from && e.seq <= to && (round == null || e.context?.round === round));
  return { kind: 'game-log', ok: true, game: { ...selected, log: undefined }, warnings: archive.warnings,
    log: { ...selected.log, entries, from: entries[0]?.seq ?? from, to: entries.at(-1)?.seq ?? Math.min(selected.log.to, to) }, filter: { from, to, ...(round == null ? {} : { round }) } };
}
function catalog(archive) { return { kind: 'game-list', games: archive.games.map(({ log, ...g }) => ({ ...g, players: log.players })), warnings: archive.warnings }; }
function format(value) {
  const warnings = (value.warnings || []).map(s => '注意：' + s);
  if (value.kind === 'game-list') return [...(value.games.length ? value.games.map(g => `${g.id} | ${g.firstSeen || '时间未知'} | ${g.mode || '模式未知'} | ${g.endObserved ? '已观测结束' : '结局未确认'} | ${g.count} 条${g.gaps.length ? '，有缺段' : ''} | ${g.players.map(p => p.label || p.id).join('、')}`) : ['暂无实验战报；开局前运行 watch on。']), ...warnings].join('\n');
  if (!value.ok) return [value.message, ...warnings].join('\n');
  const g = value.game;
  const lines = [`对局 ${g.id} | ${g.mode || '模式未知'} | ${g.endObserved ? '已观测结束' : '结局未确认'} | 已存 ${g.count} 条`, `最后记录：${g.lastSeen || '时间未知'}`, '记录范围：仅已采集的实验事件；开局起点未验证。'];
  if (g.sources.length === 1 && g.sources[0] === 'evidence') lines.push('来源：旧操作证据恢复；未被观察或已丢失的事件无法补回。');
  if (g.gaps.length) lines.push('缺失事件：' + g.gaps.map(r => r.from === r.to ? r.from : `${r.from}-${r.to}`).join('、'));
  if (value.log.transportCoverage === 'partial_online') lines.push('联机客机事件流覆盖不完整。');
  if (value.log.samplingErrors?.length) lines.push('采集存在错误：' + JSON.stringify(value.log.samplingErrors));
  if (value.filter.round != null) lines.push(`筛选：第 ${value.filter.round} 轮`);
  return [...lines, ...warnings, formatExperimental(value.log)].join('\n');
}
module.exports = { append, load, select, catalog, format, archiveFile, gameId };
