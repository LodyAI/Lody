import { makeE2eeFeatureRpcClient } from './e2ee-feature-client';
import { nativeRpcStore } from './e2ee-node-adapter';
import type { E2eeRpcOriginals } from './e2ee-node-store';
export { E2EE_FEATURE_MAX_RESULT_BYTES } from './e2ee-feature-client';
/** Native compatibility entry for the shared closed feature RPC implementation. */
export function makeE2eeFeatureRpcNative(
  options: Omit<Parameters<typeof makeE2eeFeatureRpcClient>[0], 'originals'> & {
    originals: E2eeRpcOriginals;
  }
) {
  return makeE2eeFeatureRpcClient({ ...options, originals: nativeRpcStore(options.originals) });
}
