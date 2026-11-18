import { assertNativeFlockRewriteValue } from '@lody/shared/node/native-flock-value';

export { assertNativeFlockRewriteValue as assertLosslessNativeFlockValue };

/** Patch materialization already traverses containers; use the same compatibility
 * rule at its scalar leaves without repeatedly rescanning nested values. */
export function assertLosslessNativeWireInteger(
  value: unknown,
  compatibility?: Parameters<typeof assertNativeFlockRewriteValue>[1]
): void {
  if (typeof value === 'number' || typeof value === 'bigint')
    assertNativeFlockRewriteValue(value, compatibility);
}
