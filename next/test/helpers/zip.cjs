'use strict';
const {deflateRawSync} = require('node:zlib');
// Minimal ZIP fixture writer. CRC from a separate bitwise implementation.
function crc(data) { let n = -1; for (const b of data) { n ^= b; for (let i=0;i<8;i++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1; } return (n ^ -1) >>> 0; }
module.exports = function zip(entries, compressed = true) {
  const locals = [], central = []; let offset = 0;
  for (const [name,value] of entries) {
    const key = Buffer.from(name), data = Buffer.from(value), payload = compressed ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30), directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x800,6); local.writeUInt16LE(compressed ? 8 : 0,8);
    local.writeUInt32LE(crc(data),14); local.writeUInt32LE(payload.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(key.length,26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6); local.copy(directory,8,6,26); directory.writeUInt16LE(key.length,28); directory.writeUInt32LE(offset,42);
    locals.push(local,key,payload); central.push(directory,key); offset += local.length + key.length + payload.length;
  }
  const records = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(records.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,records,end]);
};
