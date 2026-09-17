'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// An independent Electron application, using a COPY of the installed runtime.
// No original app files, profiles, or single-instance lifecycle are involved.
function prepareRuntime(source) {
  const installation = path.resolve(source, '../..');
  const executable = path.join(installation, '无名杀.exe');
  if (!fs.existsSync(executable)) throw Error('The installed Electron executable is missing.');
  const stamp = crypto.createHash('sha256').update(executable + ':' + fs.statSync(executable).mtimeMs + ':' + fs.statSync(executable).size).digest('hex').slice(0, 16);
  const root = path.resolve(__dirname, '../state/_room-runtime', stamp);
  const ready = path.join(root, 'ready.json');
  if (!fs.existsSync(ready)) {
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(installation, { withFileTypes: true })) {
      if (entry.isFile() && /\.(exe|dll|pak|dat|bin|json)$/.test(entry.name)) fs.copyFileSync(path.join(installation, entry.name), path.join(root, entry.name));
    }
    fs.cpSync(path.join(installation, 'locales'), path.join(root, 'locales'), { recursive: true });
    const app = path.join(root, 'resources/app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'noname-agent-room', version: '0.1.0', main: 'main.cjs' }));
    fs.writeFileSync(path.join(app, 'main.cjs'), `require(${JSON.stringify(path.join(__dirname, 'room-shell.cjs'))});\n`);
    fs.writeFileSync(ready, JSON.stringify({ installation, stamp }));
  }
  return path.join(root, '无名杀.exe');
}
module.exports = { prepareRuntime };
