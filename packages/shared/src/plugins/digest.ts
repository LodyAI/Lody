import type { PluginManifest } from './manifest-schema';
const encoder = new TextEncoder();
export const MAX_PACKED_CLIENT_BUNDLE_BYTES = 4 * 1024 * 1024;
/** Paths sort by JS code units. Each UTF-8 path and file body has a uint32 big-endian byte length. */
export async function packClientBundle(
  manifest: PluginManifest,
  read: (relativePath: string) => Promise<Uint8Array>
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!manifest.client && !manifest.themes?.length && !manifest.styles?.length) return undefined;
  const paths = new Set([
    ...(manifest.client ? [manifest.client] : []),
    ...(manifest.themes ?? []).flatMap((t) => ('path' in t ? [t.path] : [])),
    ...(manifest.styles ?? []),
    ...(manifest.assets ?? []),
  ]);
  const parts: Uint8Array[] = [encoder.encode('lody-client-bundle-v1\0')];
  let total = parts[0]!.length;
  for (const path of [...paths].sort()) {
    const bytes = await read(path);
    total += bytes.length + encoder.encode(path).length + 8;
    if (total > MAX_PACKED_CLIENT_BUNDLE_BYTES) throw new RangeError('Client bundle exceeds 4 MiB');
    for (const part of [encoder.encode(path), bytes]) {
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, part.length);
      parts.push(length, part);
    }
  }
  const framed = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    framed.set(part, offset);
    offset += part.length;
  }
  return framed;
}

async function hashBundle(bytes: Uint8Array<ArrayBuffer>) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeClientDigest(
  manifest: PluginManifest,
  read: (path: string) => Promise<Uint8Array>
) {
  const bytes = await packClientBundle(manifest, read);
  return bytes && hashBundle(bytes);
}

export const PLUGIN_BUNDLE_CHUNK_BYTES = 256 * 1024;

/** Only returns bytes after validating every page against the advertised bundle digest. */
export async function receiveClientBundle(
  digest: string,
  readPage: (offset: number) => Promise<{ bytes: Uint8Array; totalBytes: number }>
) {
  let buffer: Uint8Array<ArrayBuffer> | undefined;
  let offset = 0;
  do {
    const { bytes, totalBytes } = await readPage(offset);
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 1 ||
      totalBytes > MAX_PACKED_CLIENT_BUNDLE_BYTES ||
      (buffer && buffer.length !== totalBytes) ||
      bytes.length !== Math.min(PLUGIN_BUNDLE_CHUNK_BYTES, totalBytes - offset)
    )
      throw new Error('Invalid client bundle page');
    buffer ??= new Uint8Array(totalBytes);
    buffer.set(bytes, offset);
    offset += bytes.length;
  } while (offset < buffer.length);
  if ((await hashBundle(buffer)) !== digest) throw new Error('Client bundle digest mismatch');
  return buffer;
}

export function unpackClientBundle(bytes: Uint8Array): (path: string) => Uint8Array {
  const header = new TextEncoder().encode('lody-client-bundle-v1\0');
  if (!header.every((b, i) => bytes[i] === b)) throw new Error('Invalid plugin bundle');
  const files = new Map<string, Uint8Array>();
  let offset = header.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function part() {
    const length = view.getUint32(offset);
    offset += 4;
    if (length > bytes.length - offset) throw new Error('Truncated plugin bundle');
    const data = bytes.subarray(offset, offset + length);
    offset += length;
    return data;
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (offset < bytes.length) {
    const path = decoder.decode(part());
    if (files.has(path)) throw new Error('Duplicate bundle path');
    files.set(path, part());
  }
  return (path) => {
    const file = files.get(path);
    if (!file) throw new Error('Unknown bundle file');
    return file.slice();
  };
}
