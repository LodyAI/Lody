import { makeE2eeRpcClient } from './e2ee-client';
import { nativeRpcStore } from './e2ee-node-adapter';
import type { E2eeRpcOriginals } from './e2ee-node-store';
export { E2eeRpcOriginals } from './e2ee-node-store';
export { e2eeRpcDigest } from './e2ee-client';
/** Existing native entry: the shared portable workflow over the unchanged SQLite originals. */
export function makeE2eeRpcNative(
  options: Omit<Parameters<typeof makeE2eeRpcClient>[0], 'originals'> & {
    originals: E2eeRpcOriginals;
  }
) {
  return makeE2eeRpcClient({ ...options, originals: nativeRpcStore(options.originals) });
}
