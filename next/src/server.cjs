'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {validName, validPath, overlayFile} = require('./extension-files.cjs');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const denied = new Set(['home', '.git', '.env', '.ssh', '.codex']);

function safeFile(root, requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath.split('?')[0]); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes(':')) return null;
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || denied.has(part.toLowerCase()))) return null;
  const candidate = path.resolve(root, ...parts, ...(parts.length ? [] : ['index.html']));
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const real = fs.realpathSync(candidate);
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some(part => denied.has(part.toLowerCase()))) return null;
    return real;
  } catch { return candidate; }
}

function createServer({ source, token, roomProfile = false, extensionBundle = [], extensionOnly = false, importRoot, importFiles = [] }) {
  const root = fs.realpathSync(source);
  const resource = requested => {
    const installing = importRoot && fs.existsSync(path.join(importRoot, 'extension')) ? fs.readdirSync(path.join(importRoot, 'extension')).filter(validName).map(name => ({name, root:path.join(importRoot, 'extension', name)})) : [];
    return overlayFile(root, [...installing, ...extensionBundle], requested, safeFile);
  };
  const validToken = value => {
    if (typeof value !== 'string') return false;
    const actual = Buffer.from(value); const expected = Buffer.from(token);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const pathname = req.url.split('?')[0];
    if ((roomProfile || extensionOnly) && pathname === '/game/config.json' && ['GET', 'HEAD'].includes(req.method)) {
      try {
        const defaults = JSON.parse(fs.readFileSync(path.join(root, 'game/config.json'), 'utf8'));
        Object.assign(defaults, { extensions: ['Nihilphile'], extension_auto_import: false, extension_Nihilphile_enable: true, new_tutorial: true, show_splash: 'off', mode: 'connect', characters: ['standard', 'nihilphile'], cards: ['standard', 'extra'], directstartmode: null });
        defaults.extensions = [...new Set([...(extensionOnly ? [] : ['Nihilphile']), ...extensionBundle.map(e => e.name)])];
        for (const name of defaults.extensions) defaults[`extension_${name}_enable`] = true;
        defaults.characters = [...new Set(['standard', ...(extensionOnly ? [] : ['nihilphile']), ...extensionBundle.flatMap(e => e.characterPacks || [])])];
        defaults.cards = [...new Set(['standard', 'extra', ...extensionBundle.flatMap(e => e.cardPacks || [])])];
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(req.method === 'HEAD' ? '' : JSON.stringify(defaults));
      } catch { res.writeHead(500); return res.end('Room default configuration is unavailable.'); }
    }
    if (pathname.startsWith('/__oneshot/')) {
      if (!validToken(req.headers['x-oneshot-token'])) { res.writeHead(403); return res.end('Forbidden'); }
      if (['/__oneshot/extension-write','/__oneshot/extension-mkdir'].includes(pathname) && req.method === 'POST' && importRoot) {
        const requested = new URL(req.url, 'http://127.0.0.1').searchParams.get('path') || '';
        const directory = pathname.endsWith('-mkdir');
        const normalized = requested.replace(/^\.\//, '');
        const parts = (directory ? normalized.replace(/\/$/,'') : normalized).split('/');
        const relative = parts.slice(2).join('/');
        const expected = importFiles.find(f => f.path === relative);
        const allowed = directory ? (!relative || validPath(relative) && importFiles.some(f => f.dir && f.path === relative || f.path.startsWith(relative+'/'))) : validPath(relative) && expected && !expected.dir;
        if (parts[0] !== 'extension' || !validName(parts[1]) || !allowed) { res.writeHead(403); return res.end('Unexpected import path: '+requested); }
        const target = safeFile(fs.realpathSync(importRoot), '/' + parts.join('/'));
        if (!target) { res.writeHead(403); return res.end('Invalid import path'); }
        if (directory) {
          try { fs.mkdirSync(target,{recursive:true}); return res.end('ok'); }
          catch(error) { res.writeHead(500); return res.end(error.message); }
        }
        const chunks = []; let size = 0, exceeded = false;
        req.on('data', chunk => { size += chunk.length; if (size > expected.bytes) { if (!exceeded) { exceeded = true; res.writeHead(413); res.end('Import file exceeds declared size'); } } else chunks.push(chunk); });
        req.on('end', () => {
          if (exceeded) return;
          try {
            const bytes = Buffer.concat(chunks);
            if (size !== expected.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw Error('Import content mismatch');
            fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, bytes);
            res.end('ok');
          } catch (error) { res.writeHead(500); res.end(error.message); }
        });
        return;
      }
      if (pathname === '/__oneshot/health' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ pid: process.pid, source: root }));
      }
      if (pathname === '/__oneshot/stop' && req.method === 'POST') {
        res.end('stopping'); setImmediate(() => { server.close(); server.closeAllConnections(); }); return;
      }
      res.writeHead(404); return res.end();
    }
    const fileAPIs = ['/checkFile', '/checkDir', '/readFile', '/readFileAsText', '/getFileList', '/createDir', '/writeFile', '/removeFile', '/removeDir'];
    if (fileAPIs.includes(pathname)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const fail = message => res.end(JSON.stringify({ success: false, errorMsg: message }));
      const result = data => res.end(JSON.stringify({ success: true, data }));
      if (req.method !== 'GET' || ['/writeFile', '/removeFile', '/removeDir'].includes(pathname)) return fail('Source is read-only; game source file changes are disabled in this isolated session.');
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      const requested = query.get('fileName') ?? query.get('dir') ?? '';
      const filename = resource('/' + (requested || '.'));
      if (!filename) return fail('Path is outside allowed game resources.');
      try {
        let stat;
        try { stat = fs.statSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (pathname === '/checkFile' || pathname === '/checkDir') return result(stat?.isFile() ? 'file' : stat?.isDirectory() ? 'directory' : 'missing');
        if (pathname === '/createDir') return stat?.isDirectory() ? result(null) : fail('Source is read-only; this directory does not exist.');
        if (pathname === '/getFileList') {
          const entries = fs.readdirSync(filename, { withFileTypes: true }).filter(entry => !denied.has(entry.name.toLowerCase()) && safeFile(fs.realpathSync(filename), '/' + entry.name));
          return result({ folders: entries.filter(entry => entry.isDirectory()).map(entry => entry.name), files: entries.filter(entry => entry.isFile()).map(entry => entry.name) });
        }
        if (!stat?.isFile()) return fail('File does not exist.');
        return result(fs.readFileSync(filename).toString(pathname === '/readFile' ? 'base64' : 'utf8'));
      } catch (error) { return fail(error.message); }
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('Read-only source'); }
    const filename = resource(req.url);
    if (!filename) { res.writeHead(403); return res.end('Forbidden'); }
    fs.stat(filename, (error, stat) => {
      if (error || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.setHeader('Content-Type', MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      if (filename === path.join(root, 'service-worker.js')) res.setHeader('Service-Worker-Allowed', '/');
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(filename);
      stream.on('error', () => res.destroy()); stream.pipe(res);
    });
  });
  return server;
}

if (require.main === module) {
  const [source, readyFile, token, profile] = process.argv.slice(2);
  const options = profile && profile !== 'room' ? JSON.parse(fs.readFileSync(profile, 'utf8')) : {roomProfile:profile === 'room'};
  const server = createServer({ source, token, ...options });
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(readyFile, JSON.stringify({ port: server.address().port, pid: process.pid, token })));
  server.on('error', error => { console.error(error); process.exitCode = 1; });
}
module.exports = { createServer, safeFile };
