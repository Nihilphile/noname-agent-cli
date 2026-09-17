'use strict';
const { createRequire } = require('node:module');
const path = require('node:path');
const options = JSON.parse(process.env.NONAME_ROOM_HOST);
const sourceRequire = createRequire(path.join(options.source, 'package.json'));
const originalRequire = window.require || require;
const nativeWs = sourceRequire('ws');
class LocalServer extends nativeWs.Server {
  constructor(config, callback) {
    super({ ...config, port: options.wsPort, host: '127.0.0.1' }, callback);
    window.__nonameRoomServer = this;
    this.on('error', error => { window.__nonameRoomServerError = String(error.message); });
  }
}
function mapped(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) return filename;
  if (options.importRoot) {
    const relative = path.relative(path.join(options.source, 'extension'),filename);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && sourceRequire('fs').existsSync(path.join(options.importRoot,'extension',relative.split(path.sep)[0]))) return path.join(options.importRoot,'extension',relative);
  }
  for (const item of options.extensionBundle || []) {
    const relative = path.relative(path.join(options.source, 'extension', item.name), filename);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return path.join(item.root, relative);
  }
  return filename;
}
const readonly = target => new Proxy(target, { get(target, key) {
  if (key === 'promises') return readonly(target[key]);
  if (/^(write|append|unlink|rm|rmdir|mkdir|rename|copy|cp|truncate|chmod|chown|symlink|link|createWriteStream)/.test(String(key))) return () => { throw Error('Room game resources are read-only.'); };
  if (key === 'open' || key === 'openSync') return (file, flags, ...args) => {
    if (flags !== 'r' && flags !== 0) throw Error('Room game resources are read-only.');
    return target[key](mapped(file), flags, ...args);
  };
  if (typeof target[key] === 'function' && /^(read|stat|lstat|access|exists|realpath|createReadStream)/.test(String(key))) return (file, ...args) => target[key](mapped(file), ...args);
  return target[key];
} });
const readonlyFs = readonly(sourceRequire('fs'));
window.__dirname = options.source;
window.require = function (name) {
  if (name === 'ws') return Object.assign(function (...args) { return new nativeWs(...args); }, nativeWs, { Server: LocalServer });
  if (name === 'fs' || name === 'node:fs') return readonlyFs;
  if (name === 'electron') return originalRequire('electron');
  return sourceRequire(mapped(name));
};
window.require.resolve = name => sourceRequire.resolve(mapped(name));
