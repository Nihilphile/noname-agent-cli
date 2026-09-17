'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fail = message => { throw Object.assign(Error(message), {code:'invalid_extension_zip'}); };
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 && !['__proto__','constructor','prototype'].includes(name) && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !/^\./.test(name) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
}
function validPath(name) { return typeof name === 'string' && name.length <= 500 && name.split('/').every(validName); }
const crcTable = Array.from({length:256}, (_, n) => { for (let i=0;i<8;i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(data) { let crc = 0xffffffff; for (const b of data) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function inspectZip(filename) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) fail('ZIP must be a file of at most 64 MiB.');
  const bytes = fs.readFileSync(filename);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) fail('ZIP end record is missing.');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt32LE(end + 4) || bytes.readUInt16LE(end + 8) !== count || count === 65535 || count > 10000 || offset + size !== end) fail('Split/ZIP64 archives or excessive entries are unsupported.');
  const seen = new Set(), files = [], contents = new Map(); let cursor = offset, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid ZIP directory.');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), length = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + length + extra + comment;
    if (next > end) fail('Invalid ZIP directory length.');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + length);
    const decoded = new TextDecoder('utf-8',{fatal:true}).decode(rawName);
    const name = decoded.replace(/\/$/, '');
    if (!validPath(name) || seen.has(name.toLowerCase()) || (flags & 1) || ![0,8].includes(method) || ((bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000) fail(`Unsafe, duplicate or unsupported ZIP entry: ${name}`);
    seen.add(name.toLowerCase());
    const unpacked = bytes.readUInt32LE(cursor + 24);
    expanded += unpacked;
    if (unpacked > 32 * 1024 * 1024 || expanded > 128 * 1024 * 1024) fail('ZIP exceeds the 32 MiB per-file / 128 MiB expanded limit.');
    // Do not allow a Unicode extra field to redirect the native JSZip loader to
    // a different path from the one preflight verified.
    for (let at = cursor + 46 + length; at < cursor + 46 + length + extra;) {
      if (at + 4 > next) fail('Malformed ZIP extra field.');
      const id = bytes.readUInt16LE(at), n = bytes.readUInt16LE(at+2);
      if (at + 4 + n > cursor + 46 + length + extra) fail('Malformed ZIP extra length.');
      if (id === 1) fail('ZIP64 entries are unsupported.');
      if (id === 0x7075 && (n < 5 || new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(at+9,at+4+n)) !== decoded)) fail('ZIP Unicode path must match its entry name.');
      at += 4 + n;
    }
    const local = bytes.readUInt32LE(cursor + 42), compressed = bytes.readUInt32LE(cursor + 20);
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) fail('Invalid ZIP local header.');
    const localLength = bytes.readUInt16LE(local+26), localExtra = bytes.readUInt16LE(local+28), start = local+30+localLength+localExtra;
    if (start + compressed > offset || !bytes.subarray(local+30,local+30+localLength).equals(rawName) || bytes.readUInt16LE(local+8) !== method || bytes.readUInt16LE(local+6) !== flags) fail('ZIP local entry does not match its directory.');
    const payload = bytes.subarray(start,start+compressed);
    const data = method === 8 ? zlib.inflateRawSync(payload,{maxOutputLength:Math.max(1,unpacked)}) : payload;
    if (data.length !== unpacked || crc32(data) !== bytes.readUInt32LE(cursor+16)) fail(`ZIP CRC or size mismatch: ${name}`);
    if (decoded.endsWith('/')) files.push({path:name,dir:true});
    else { files.push({path:name,bytes:data.length,sha256:hash(data)}); contents.set(name,data); }
    cursor = next;
  }
  if (cursor !== end) fail('Unexpected ZIP directory data.');
  const fileNames = new Set(files.filter(f=>!f.dir).map(f => f.path.toLowerCase()));
  for (const f of files) { const parts = f.path.toLowerCase().split('/'); while (parts.pop() && parts.length) if (fileNames.has(parts.join('/'))) fail(`File/directory collision: ${f.path}`); }
  if (!contents.has('extension.js')) fail('ZIP must contain extension.js at its root (do not wrap it in another folder).');
  let name = null;
  if (contents.has('info.json')) { name = JSON.parse(contents.get('info.json').toString('utf8')).name; if (!validName(name)) fail('info.json contains an invalid extension name.'); }
  return {bytes, sha256:hash(bytes), files, name};
}
function verifyFiles(root, manifest) {
  for (const file of manifest) {
    const filename = path.join(root, file.path), real = fs.realpathSync(filename), relative = path.relative(fs.realpathSync(root), real);
    if (relative.startsWith('..') || path.isAbsolute(relative) || (file.dir ? !fs.statSync(real).isDirectory() : hash(fs.readFileSync(real)) !== file.sha256)) throw Error(`Extension file verification failed: ${file.path}`);
  }
}
// A selected extension completely shadows its source directory, including missing
// files. Falling back would mix two installed versions.
function overlayFile(source, bundle, requestPath, safeFile) {
  const base = safeFile(source, requestPath);
  if (!base) return null;
  let decoded; try { decoded = decodeURIComponent(requestPath.split('?')[0]); } catch { return null; }
  const parts = decoded.replace(/^\/+/, '').split('/');
  if (parts[0] === 'extension') {
    const item = bundle.find(e => e.name.toLowerCase() === (parts[1] || '').toLowerCase());
    if (item) return safeFile(item.root, '/' + (parts.slice(2).join('/') || '.'));
  }
  return base;
}
module.exports = {validName, validPath, inspectZip, verifyFiles, overlayFile, hash, crc32};
