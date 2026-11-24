import { packClientBundle } from './digest';
import { pluginManifestSchema } from './manifest-schema';

import type { WorkspacePluginEntry } from './workspace-entry';
export class NpmTransportUnavailable extends Error {}
const limit = 32 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
async function bounded(stream: ReadableStream<Uint8Array>, max: number) {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw Error('npm package exceeds size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function entries(tar: Uint8Array) {
  const files = new Map<string, Uint8Array>();
  for (let start = 0; start + 512 <= tar.length;) {
    const header = tar.subarray(start, start + 512);
    if (header.every((b) => !b)) {
      if (!tar.subarray(start).every((b) => !b)) throw Error('Invalid tar trailer');
      return files;
    }
    const field = (offset: number, length: number) =>
      decoder.decode(header.subarray(offset, offset + length)).replace(/\0.*$/s, '');
    const path = field(0, 100),
      sizeText = field(124, 12).trim(),
      size = parseInt(sizeText, 8);
    if (
      !/^package\/(?:[a-zA-Z0-9_.@ -]+\/)*[a-zA-Z0-9_.@ -]+$/.test(path) ||
      path.split('/').some((s) => s === '.' || s === '..') ||
      !/^[0-7]+$/.test(sizeText) ||
      ![0, 48].includes(header[156]!) ||
      field(345, 155) ||
      files.has(path) ||
      files.size >= 1025 ||
      start + 512 + size > tar.length
    )
      throw Error('Unsupported npm package entry');
    files.set(path, tar.subarray(start + 512, start + 512 + size));
    start += 512 + Math.ceil(size / 512) * 512;
  }
  throw Error('Truncated npm package');
}
export async function fetchWorkspaceNpmRelease(
  entry: WorkspacePluginEntry,
  signal: AbortSignal,
  registry = 'https://registry.npmjs.org/',
  request: typeof fetch = fetch
) {
  const pin = entry.source;
  const base = new URL(registry);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw Error('Expected HTTPS npm registry');
  const basename = pin.package_name.split('/').at(-1)!;
  let res: Response;
  try {
    res = await request(
      `${base.href.replace(/\/$/, '')}/${pin.package_name}/-/${basename}-${pin.exact_version}.tgz`,
      { signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }
    );
  } catch (error) {
    signal.throwIfAborted();
    throw new NpmTransportUnavailable('npm registry unavailable', { cause: error });
  }
  if (!res.ok || !res.body) throw new NpmTransportUnavailable('npm package unavailable');
  const archive = await bounded(res.body, limit);
  const hash = await crypto.subtle.digest('SHA-512', archive);
  if ('sha512-' + btoa(String.fromCharCode(...new Uint8Array(hash))) !== pin.integrity)
    throw Error('npm package integrity mismatch');
  const files = entries(
    await bounded(new Blob([archive]).stream().pipeThrough(new DecompressionStream('gzip')), limit)
  );
  const read = (p: string) => {
    const file = files.get('package/' + p);
    if (!file) throw Error('Missing npm package entry');
    return file;
  };
  const manifest = pluginManifestSchema.parse(JSON.parse(decoder.decode(read('lody.plugin.json'))));
  const pkg = JSON.parse(decoder.decode(read('package.json')));
  if (
    pkg.name !== pin.package_name ||
    pkg.version !== pin.exact_version ||
    manifest.version !== pin.exact_version
  )
    throw Error('Unexpected workspace package');
  const bytes = await packClientBundle(manifest, async (p) => read(p));
  if (!bytes) throw Error('No client release');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  if (
    digest !== entry.client_digest ||
    JSON.stringify(manifest) !== JSON.stringify(entry.manifest_summary)
  )
    throw Error('Package does not match workspace pin');
  signal.throwIfAborted();
  return {
    npm: entry,
    manifest,
    bytes,
    digest,
    local: false,
    origin: 'workspace',
    preferences: {},
  };
}
