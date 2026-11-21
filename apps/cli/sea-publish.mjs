import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
export const platforms = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
];
const digest = (b) => createHash('sha256').update(b).digest('hex');
function order(a, b) {
  const parse = (value) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!m) throw new Error('Unsupported channel version');
    return { core: m.slice(1, 4).map(Number), pre: m[4]?.split('.') };
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const left = x.pre[i],
      right = y.pre[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const numericLeft = /^\d+$/.test(left),
      numericRight = /^\d+$/.test(right);
    if (numericLeft && numericRight) return Number(left) < Number(right) ? -1 : 1;
    if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}
/** Store writes are conditional; a failed platform upload never advances a channel. */
export async function publishDaemonRelease({ directory, source, version, channel, store }) {
  const staged = [];
  for (const platform of platforms) {
    const dir = path.join(directory, platform),
      raw = fs.readFileSync(path.join(dir, 'manifest.json'));
    const manifest = JSON.parse(raw);
    if (
      manifest.format !== 1 ||
      manifest.product !== 'lody-cloud' ||
      manifest.distribution !==
        (channel === 'next' ? 'lody-cloud-next-daemon' : 'lody-cloud-daemon') ||
      manifest.source !== source ||
      manifest.version !== version ||
      manifest.channel !== channel ||
      manifest.platform !== platform ||
      manifest.serviceProtocol !== 1 ||
      manifest.dataFormat !== 1
    )
      throw new Error('Frozen daemon identity mismatch');
    const prefix = `runtimes/${manifest.distribution}/${version}/${platform}`;
    const artifacts = [];
    for (const artifact of [manifest.capsule, manifest.node]) {
      if (!/^[a-zA-Z0-9_-]+\.gz$/.test(artifact.file)) throw new Error('Invalid artifact name');
      const bytes = fs.readFileSync(path.join(dir, artifact.file));
      if (bytes.length !== artifact.size || digest(bytes) !== artifact.sha256)
        throw new Error('Frozen artifact mismatch');
      if (
        !Number.isSafeInteger(artifact.contentSize) ||
        artifact.contentSize < 1 ||
        artifact.contentSize > 1024 * 1024 * 1024
      )
        throw new Error('Invalid artifact content size');
      const raw = gunzipSync(bytes, { maxOutputLength: artifact.contentSize });
      if (raw.length !== artifact.contentSize || digest(raw) !== artifact.contentSha256)
        throw new Error('Frozen artifact content mismatch');
      artifacts.push([`${prefix}/${artifact.file}`, bytes]);
    }
    staged.push({ platform, raw, manifest, artifacts, prefix });
  }
  for (const entry of staged) {
    for (const [key, bytes] of [...entry.artifacts, [`${entry.prefix}/manifest.json`, entry.raw]]) {
      const current = await store.get(key);
      if (current) {
        if (!current.bytes.equals(bytes)) throw new Error(`Immutable artifact conflict: ${key}`);
      } else {
        await store.put(key, bytes, { absent: true, immutable: true });
        const readback = await store.get(key);
        if (!readback || !readback.bytes.equals(bytes))
          throw new Error('R2 immutable readback mismatch');
      }
    }
  }
  for (const entry of staged) {
    const key = `runtimes/${entry.manifest.distribution}/channels/${entry.platform}/${channel}.json`;
    const current = await store.get(key);
    if (current) {
      const old = JSON.parse(current.bytes);
      if (
        old.product !== entry.manifest.product ||
        old.distribution !== entry.manifest.distribution ||
        old.platform !== entry.platform ||
        old.channel !== channel
      )
        throw new Error('Invalid existing channel identity');
      const comparison = order(old.version, version);
      if (comparison > 0) continue;
      if (comparison === 0) {
        if (!current.bytes.equals(entry.raw)) throw new Error('Same-version channel conflict');
        continue;
      }
    }
    await store.put(key, entry.raw, current ? { etag: current.etag } : { absent: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = path.resolve(process.argv[2]),
    source = process.env.LODY_DAEMON_SOURCE_SHA,
    version = process.env.LODY_DAEMON_VERSION,
    channel = process.env.LODY_DAEMON_CHANNEL;
  if (!/^[a-f0-9]{40}$/.test(source ?? '') || !['stable', 'next', 'nightly'].includes(channel))
    throw new Error('Invalid publish identity');
  const bucket = process.env.R2_RUNTIME_BUCKET,
    account = process.env.R2_ACCOUNT_ID;
  if (!bucket || !/^[a-f0-9]{32}$/.test(account ?? ''))
    throw new Error('Missing R2 runtime bucket/account');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-r2-'));
  const aws = (args) =>
    execFileSync(
      'aws',
      [
        '--endpoint-url',
        `https://${account}.r2.cloudflarestorage.com`,
        's3api',
        ...args,
        '--bucket',
        bucket,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  const store = {
    async get(key) {
      const file = path.join(temp, 'get');
      try {
        const metadata = JSON.parse(aws(['get-object', '--key', key, file]));
        return { bytes: fs.readFileSync(file), etag: metadata.ETag };
      } catch (error) {
        if (/NoSuchKey|\(404\)|Not Found/.test(String(error.stderr))) return null;
        throw error;
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
    async put(key, bytes, condition) {
      const file = path.join(temp, 'put');
      fs.writeFileSync(file, bytes);
      try {
        aws([
          'put-object',
          '--key',
          key,
          '--body',
          file,
          '--content-type',
          key.endsWith('.json') ? 'application/json' : 'application/gzip',
          '--cache-control',
          condition.immutable
            ? 'public,max-age=31536000,immutable'
            : 'public,max-age=60,must-revalidate',
          ...(condition.absent ? ['--if-none-match', '*'] : ['--if-match', condition.etag]),
        ]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  };
  try {
    await publishDaemonRelease({ directory, source, version, channel, store });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
