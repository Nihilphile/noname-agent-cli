'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createServer, safeFile } = require('../src/server.cjs');
const session = require('../src/session.cjs');
const { connectCDP } = require('../src/transport.cjs');

test('read-only HTTP server serves game modules and blocks private files and traversal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-readonly-'));
  fs.mkdirSync(path.join(root, 'Home')); fs.writeFileSync(path.join(root, 'Home', 'secret'), 'private');
  fs.writeFileSync(path.join(root, 'index.html'), '<title>game</title>');
  fs.writeFileSync(path.join(root, 'service-worker.js'), 'self.test=true');
  fs.mkdirSync(path.join(root, 'node_modules', '.pnpm'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', '.pnpm', 'test.js'), 'export default 1');
  const server = createServer({ source: root, token: 'test-secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  assert.equal(await (await fetch(url)).text(), '<title>game</title>');
  const worker = await fetch(url + '/service-worker.js');
  assert.match(worker.headers.get('content-type'), /javascript/);
  assert.equal(worker.headers.get('service-worker-allowed'), '/');
  assert.equal((await fetch(url + '/node_modules/.pnpm/test.js')).status, 200);
  for (const requestPath of ['/Home/secret', '/home/secret', '/%48ome/secret', '/..%2fHome/secret', '/%2e%2e/secret', '/a%5c..%5cHome/secret', '/C:/secret']) {
    const response = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: requestPath }, response => { response.resume(); resolve(response); }).on('error', reject);
    });
    assert.equal(response.statusCode, 403, requestPath);
  }
  assert.equal((await fetch(url + '/index.html', { method: 'POST', body: 'changed' })).status, 405);
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), '<title>game</title>');
  assert.equal((await fetch(url + '/__oneshot/health')).status, 403);
  const health = await fetch(url + '/__oneshot/health', { headers: { 'x-oneshot-token': 'test-secret' } });
  assert.equal((await health.json()).source, fs.realpathSync(root));
  assert.deepEqual(await (await fetch(url + '/checkFile?fileName=index.html')).json(), { success: true, data: 'file' });
  assert.deepEqual(await (await fetch(url + '/checkDir?dir=node_modules')).json(), { success: true, data: 'directory' });
  assert.deepEqual(await (await fetch(url + '/checkFile?fileName=absent.js')).json(), { success: true, data: 'missing' });
  assert.equal((await (await fetch(url + '/readFileAsText?fileName=index.html')).json()).data, '<title>game</title>');
  assert.equal(Buffer.from((await (await fetch(url + '/readFile?fileName=index.html')).json()).data, 'base64').toString(), '<title>game</title>');
  const listing = await (await fetch(url + '/getFileList?dir=')).json();
  assert.equal(listing.success, true); assert.equal(listing.data.folders.includes('Home'), false);
  assert.equal((await (await fetch(url + '/readFileAsText?fileName=Home/secret')).json()).success, false);
  assert.equal((await (await fetch(url + '/readFileAsText?fileName=../private')).json()).success, false);
  assert.equal((await (await fetch(url + '/writeFile', { method: 'POST', body: '{}' })).json()).success, false);
  assert.equal((await (await fetch(url + '/removeFile?fileName=index.html')).json()).success, false);
  assert.equal((await (await fetch(url + '/createDir?dir=absent')).json()).success, false);
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), '<title>game</title>');
  assert.equal(safeFile(root, '/bad%zz'), null);
});

test('session names cannot escape the isolated state tree', () => {
  for (const name of ['../game', 'C:\\game', '/game', 'a/b', 'a.b', '', 'CON', 'nul', 'x'.repeat(65)]) assert.throws(() => session.sessionDir(name), /Session name/);
  assert.equal(path.basename(session.sessionDir('valid_name-01')), 'valid_name-01');
});

test('room defaults apply on first boot without changing source or ordinary sessions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-room-defaults-'));
  fs.mkdirSync(path.join(root, 'game'));
  const filename = path.join(root, 'game/config.json');
  const original = JSON.stringify({ extensions: ['restore-user-config'], mode: 'identity', untouched: 42 });
  fs.writeFileSync(filename, original);
  const servers = [];
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const roomProfile of [true, false]) {
    const server = createServer({ source: root, token: 'test', roomProfile }); servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/game/config.json`;
    const body = await (await fetch(url)).json();
    assert.deepEqual(body.extensions, roomProfile ? ['Nihilphile'] : ['restore-user-config']);
    assert.equal(body.mode, roomProfile ? 'connect' : 'identity'); assert.equal(body.untouched, 42);
    assert.equal(await (await fetch(url, { method: 'HEAD' })).text(), '');
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
  }
});

test('session operation lock excludes concurrent mutations and releases on failure', async t => {
  const name = `test-lock-${process.pid}`;
  const dir = session.sessionDir(name);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await session.withLock(name, async () => {
    await assert.rejects(session.withLock(name, async () => {}), /Another start\/stop command/);
  });
  await assert.rejects(session.withLock(name, async () => { throw new Error('simulated operation failure'); }), /simulated/);
  await session.withLock(name, async () => session.appendEvidence(name, { type: 'test' }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'evidence.jsonl'), 'utf8')).type, 'test');
});

test('doctor gives actionable missing-source and missing-browser diagnostics', async () => {
  const result = await session.doctor({ source: path.join(os.tmpdir(), 'nonexistent-noname-source'), browser: path.join(os.tmpdir(), 'nonexistent-browser.exe') });
  assert.equal(result.ok, false); assert.equal(result.errors.length, 2);
  assert.match(result.errors.join(' '), /--source/); assert.match(result.errors.join(' '), /--browser/);
});

test('CDP transport round trips real runtime values and reports page exceptions', async t => {
  const child = spawn(process.execPath, ['--inspect=0', '-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => child.kill());
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Inspector did not start')), 10000);
    child.stderr.on('data', chunk => { output += chunk; const match = output.match(/ws:\/\/[^\s]+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
    child.on('error', reject);
  });
  const cdp = await connectCDP(url);
  t.after(() => cdp.close());
  assert.deepEqual(await cdp.evaluate('({count: 6*7, values: [true, null]})'), { count: 42, values: [true, null] });
  assert.equal(await cdp.evaluate('Promise.resolve("resolved")'), 'resolved');
  await assert.rejects(cdp.evaluate('(()=>{throw new Error("test-exception")})()'), /test-exception/);
  await assert.rejects(cdp.send('Invalid.method'), /CDP Invalid.method/);
  cdp.close();
  await assert.rejects(cdp.evaluate('1'), /closed/);
});
