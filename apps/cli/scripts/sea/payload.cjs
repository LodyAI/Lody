// File format shared by the build tool and the generated standalone bootstrap.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function safePath(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.includes('\\') ||
    name.includes(':') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    name.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Unsafe SEA payload path');
  return name;
}
function pack(root) {
  const files = [],
    chunks = [];
  let offset = 0;
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const relative = safePath(prefix + name),
        file = path.join(dir, name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink())
        throw new Error('SEA staging must contain real files: ' + relative);
      if (stat.isDirectory()) {
        walk(file, relative + '/');
        continue;
      }
      if (!stat.isFile()) throw new Error('Unsupported SEA staging entry');
      if (name.endsWith('.map')) continue;
      const bytes = fs.readFileSync(file);
      files.push({
        path: relative,
        offset,
        size: bytes.length,
        mode: stat.mode & 0o777,
        sha256: digest(bytes),
      });
      chunks.push(bytes);
      offset += bytes.length;
    }
  }
  walk(root);
  const header = Buffer.from(JSON.stringify({ format: 1, files }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return zlib.gzipSync(Buffer.concat([length, header, ...chunks]), { level: 9 });
}
function unpack(bytes, destination) {
  const raw = zlib.gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 });
  const headerSize = raw.readUInt32BE(0);
  if (headerSize > 16 * 1024 * 1024 || headerSize + 4 > raw.length)
    throw new Error('Invalid SEA header');
  const header = JSON.parse(raw.subarray(4, 4 + headerSize).toString());
  if (header.format !== 1 || !Array.isArray(header.files) || header.files.length > 100000)
    throw new Error('Invalid SEA format');
  const names = new Set();
  let offset = 0;
  for (const entry of header.files) {
    const name = safePath(entry.path);
    if (
      names.has(name) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.offset !== offset ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    )
      throw new Error('Invalid SEA file');
    names.add(name);
    const start = 4 + headerSize + offset,
      data = raw.subarray(start, start + entry.size);
    if (data.length !== entry.size || digest(data) !== entry.sha256)
      throw new Error('SEA file digest mismatch');
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, data, { flag: 'wx', mode: entry.mode & 0o755, flush: true });
    offset += entry.size;
  }
  if (4 + headerSize + offset !== raw.length) throw new Error('Unexpected SEA trailing data');
}
function verifyTree(bytes, root) {
  const raw = zlib.gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 });
  const headerSize = raw.readUInt32BE(0);
  const header = JSON.parse(raw.subarray(4, 4 + headerSize).toString());
  for (const entry of header.files) {
    const file = path.join(root, safePath(entry.path));
    if (!fs.lstatSync(file).isFile() || digest(fs.readFileSync(file)) !== entry.sha256)
      throw new Error('Cached SEA payload is corrupt');
  }
}
module.exports = { digest, pack, unpack, verifyTree };
