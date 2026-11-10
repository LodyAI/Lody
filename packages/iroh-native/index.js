// Loader for the optional Node-API iroh transport. Hosts treat `undefined` as
// "no iroh capability" and keep encrypted Streams RPC and durable dispatch.
// The module file is located explicitly by the host (packaged resources, or the
// path its parent process passes); nothing is searched implicitly.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** File name of the module built for `platform`/`arch`. */
export function nativeFileName(platform = process.platform, arch = process.arch) {
  return `lody-iroh.${platform}-${arch}.node`;
}

/** Development build location inside this package. */
export function developmentNativePath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), nativeFileName());
}

const require = createRequire(import.meta.url);
const cache = new Map();

/**
 * Loads the module at `file` once per process. Returns `undefined` when `file` is
 * unset, missing or fails to load; the reason is kept in `loadError(file)`.
 */
export function loadIrohNative(file) {
  if (!file) return undefined;
  const resolved = path.resolve(file);
  const hit = cache.get(resolved);
  if (hit) return hit.native;
  let entry;
  if (!existsSync(resolved)) entry = { native: undefined, error: 'missing' };
  else
    try {
      entry = { native: require(resolved), error: undefined };
    } catch (error) {
      entry = { native: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  cache.set(resolved, entry);
  return entry.native;
}

/** Why loading `file` returned `undefined`, if it did. */
export function loadError(file) {
  return file ? cache.get(path.resolve(file))?.error : 'unset';
}

/** ALPN of the Lody encrypted RPC protocol carried by this module. */
export const IROH_RPC_ALPN = 'lody/e2ee-rpc/1';
