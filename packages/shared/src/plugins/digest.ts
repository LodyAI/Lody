import type { PluginManifest } from './manifest-schema';
const encoder = new TextEncoder();
export const MAX_PACKED_CLIENT_BUNDLE_BYTES = 4 * 1024 * 1024;
/** Paths sort by JS code units. Each UTF-8 path and file body has a uint32 big-endian byte length. */
export async function computeClientDigest(
  manifest: PluginManifest,
  read: (relativePath: string) => Promise<Uint8Array>
): Promise<string | undefined> {
  if (!manifest.client && !manifest.themes?.length && !manifest.styles?.length) return undefined;
  const paths = new Set([
    ...(manifest.client ? [manifest.client] : []),
    ...(manifest.themes ?? []).flatMap((t) => ('path' in t ? [t.path] : [])),
    ...(manifest.styles ?? []),
    ...(manifest.assets ?? []),
  ]);
  const parts: Uint8Array[] = [encoder.encode('lody-client-bundle-v1\0')];
  let total = 0;
  for (const path of [...paths].sort()) {
    const bytes = await read(path);
    total += bytes.length;
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
  const hash = await crypto.subtle.digest('SHA-256', framed);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
