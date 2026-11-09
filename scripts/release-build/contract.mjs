import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TARGETS = ['mac', 'win', 'linux', 'linux-arm64', 'cli'];
export const BUILD_ENV_KEYS = [
  'VITE_LODY_ENV',
  'VITE_SERVER_URL',
  'VITE_CONVEX_SITE_URL',
  'VITE_CONVEX_DEPLOY_URL',
  'VITE_SITE_URL',
  'VITE_SESSION_SHARE_ORIGIN',
  'VITE_PUBLIC_POSTHOG_HOST',
  'VITE_PUBLIC_POSTHOG_KEY',
  'VITE_ELECTRON_UPDATE_URL',
  'VITE_ELECTRON_UPDATE_CHANNEL',
  'VITE_API_BASE_URL',
  'VITE_LORO_STREAMS_BASE_URL',
];
export const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(',')}}`;
};
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function exact(value, keys) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join() !== keys.split(' ').sort().join()
  )
    throw new Error('Unexpected build fields');
}
const text = (value, pattern) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Invalid build value');
};
export function safePath(value) {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    value !== value.normalize('NFC') ||
    value
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          /[\\:<>"|?*\x00-\x1f\x7f]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)
      )
  )
    throw new Error('Unsafe build path');
  return value;
}
export function validateRequest(r) {
  exact(
    r,
    'schemaVersion requestId sourceSha profile cliVersion embeddedCliVersion builtAt targets env csp'
  );
  if (r.schemaVersion !== 1) throw new Error('Unsupported build schema');
  text(r.requestId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/);
  text(r.sourceSha, /^[a-f0-9]{40}$/);
  text(r.cliVersion, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  text(r.embeddedCliVersion, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  if (typeof r.builtAt !== 'string' || new Date(r.builtAt).toISOString() !== r.builtAt)
    throw new Error('Invalid build time');
  if (
    !Array.isArray(r.targets) ||
    !r.targets.length ||
    new Set(r.targets).size !== r.targets.length ||
    r.targets.some((t) => !TARGETS.includes(t))
  )
    throw new Error('Invalid build targets');
  const p = r.profile;
  if (!p || !['nightly', 'stable', 'staging'].includes(p.channel))
    throw new Error('Invalid build channel');
  exact(
    p,
    p.channel === 'nightly'
      ? 'channel version buildNumber nativeVersion privateSha ossSha builtAt runId'
      : 'channel version'
  );
  text(p.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  if (p.channel === 'nightly') {
    for (const name of ['privateSha', 'ossSha']) text(p[name], /^[a-f0-9]{40}$/);
    for (const name of ['buildNumber', 'runId']) text(p[name], /^[1-9]\d{0,15}$/);
    text(p.nativeVersion, /^\d+\.\d+\.\d+$/);
    if (p.ossSha !== r.sourceSha || p.builtAt !== r.builtAt)
      throw new Error('Build identity differs');
  }
  if (
    !r.env ||
    Object.getPrototypeOf(r.env) !== Object.prototype ||
    Object.keys(r.env).some((k) => !BUILD_ENV_KEYS.includes(k))
  )
    throw new Error('Build environment is not allowlisted');
  for (const [key, value] of Object.entries(r.env)) {
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))
      throw new Error('Invalid build environment');
    if (key.endsWith('_URL') || key.endsWith('_HOST') || key.endsWith('_ORIGIN')) {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
        throw new Error('Build URLs must use credential-free HTTPS');
    }
  }
  const channel = p.channel === 'stable' ? 'latest' : p.channel === 'staging' ? 'next' : 'nightly';
  if (
    r.env.VITE_ELECTRON_UPDATE_CHANNEL !== channel ||
    r.env.VITE_LODY_ENV !== (p.channel === 'staging' ? 'staging' : 'production')
  )
    throw new Error('Build environment/channel differs');
  for (const key of [
    'VITE_SERVER_URL',
    'VITE_CONVEX_SITE_URL',
    'VITE_CONVEX_DEPLOY_URL',
    'VITE_SITE_URL',
    'VITE_SESSION_SHARE_ORIGIN',
    'VITE_ELECTRON_UPDATE_URL',
  ])
    if (!r.env[key]) throw new Error(`Missing ${key}`);
  if (new URL(r.env.VITE_SESSION_SHARE_ORIGIN).pathname !== '/')
    throw new Error('Sharing requires an origin');
  const nightly = new URL(r.env.VITE_ELECTRON_UPDATE_URL).pathname.split('/').includes('nightly');
  if (nightly !== (p.channel === 'nightly')) throw new Error('Update path/channel differs');
  exact(r.csp, 'connect-src img-src frame-src');
  for (const values of Object.values(r.csp)) {
    if (!Array.isArray(values) || values.length > 32) throw new Error('Invalid CSP sources');
    for (const value of values)
      text(value, /^(?:https|wss):\/\/(?:\*\.)?[A-Za-z0-9.-]+(?::\d{1,5})?$/);
  }
  if (Buffer.byteLength(canonical(r)) > 16384) throw new Error('Build request exceeds limit');
  return r;
}
export async function readRequest(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid request file');
  const bytes = await readFile(file, 'utf8');
  const r = validateRequest(JSON.parse(bytes));
  if (bytes.trim() !== canonical(r)) throw new Error('Build request must be canonical JSON');
  return r;
}
export function payloadRoots(target) {
  return [
    'apps/cli/dist',
    'packages/code-review-viewer/dist',
    'packages/code-review-viewer/standalone.html',
    ...(target === 'cli' ? [] : ['apps/electron/out']),
  ];
}
export async function describePayload(root, target) {
  const files = [],
    names = new Set();
  let total = 0;
  async function walk(path) {
    safePath(path);
    const stat = await lstat(join(root, path));
    if (stat.isDirectory()) {
      for (const child of (await readdir(join(root, path))).sort()) await walk(`${path}/${child}`);
    } else {
      if (!stat.isFile() || names.has(path.toLowerCase())) throw new Error('Invalid payload file');
      names.add(path.toLowerCase());
      total += stat.size;
      if (files.length >= 20000 || stat.size > 512 * 2 ** 20 || total > 8 * 2 ** 30)
        throw new Error('Build payload exceeds limit');
      files.push({
        path,
        size: stat.size,
        sha256: await hashFile(join(root, path)),
        mode: stat.mode & 0o111 ? 0o755 : 0o644,
      });
    }
  }
  for (const path of payloadRoots(target)) await walk(path);
  return files;
}
export async function writeReceipt({ root, request, target, runId, runAttempt, workflowSha }) {
  if (!request.targets.includes(target)) throw new Error('Unexpected target');
  text(String(runId), /^[1-9]\d{0,15}$/);
  text(String(runAttempt), /^[1-9]\d{0,5}$/);
  text(workflowSha, /^[a-f0-9]{40}$/);
  const receipt = {
    schemaVersion: 1,
    requestSha256: digest(canonical(request)),
    sourceSha: request.sourceSha,
    target,
    runId: String(runId),
    runAttempt: Number(runAttempt),
    workflowSha,
    files: await describePayload(root, target),
  };
  await writeFile(join(root, 'request.json'), canonical(request) + '\n');
  await writeFile(join(root, 'receipt.json'), canonical(receipt) + '\n');
  return receipt;
}
