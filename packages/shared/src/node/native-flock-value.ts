/**
 * Published Repo 0.1.0 can round Flock integers outside JS's safe range on its
 * JSON projection. Never write such a projected row back over its raw storage.
 * Binary leaves and finite fractional JSON numbers remain supported.
 */
export function assertNativeFlockRewriteValue(
  value: unknown,
  compatibility?: { readonly losslessWireI64?: true }
): void {
  if (typeof value === 'bigint') {
    if (compatibility?.losslessWireI64 === true) {
      if (value < -(1n << 63n) || value > (1n << 63n) - 1n)
        throw new Error('Native Flock rewrite refused: integer outside signed i64');
      return;
    }
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Native Flock rewrite refused: unsafe integer projection');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new Error('Native Flock rewrite refused: unsafe integer projection');
    return;
  }
  if (value instanceof Uint8Array || value === null || typeof value !== 'object') return;
  for (const nested of Object.values(value)) assertNativeFlockRewriteValue(nested, compatibility);
}
