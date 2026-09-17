'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareRuntime } = require('../src/room-runtime.cjs');

for (const executableName of ['无名杀.exe', 'noname.exe']) {
  test(`room runtime supports ${executableName}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-room-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'game', 'resources', 'app');
    const installation = path.resolve(source, '../..');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(path.join(installation, 'locales'));
    fs.writeFileSync(path.join(installation, executableName), 'runtime');
    fs.writeFileSync(path.join(installation, 'icudtl.dat'), 'runtime');
    const executable = prepareRuntime(source, path.join(root, 'cache'));
    assert.equal(path.basename(executable), executableName);
    assert.equal(fs.readFileSync(executable, 'utf8'), 'runtime');
    assert.ok(fs.existsSync(path.join(path.dirname(executable), 'resources', 'app', 'main.cjs')));
  });
}
