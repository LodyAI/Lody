export const REQUIRED_NODE_API_VERSION = 10;

/** Exported for tests: `undefined`/unparsable napi fails closed. */
export function isNodeApiVersionSupported(napi: string | undefined): boolean {
  const parsed = Number.parseInt(napi ?? '', 10);
  return Number.isFinite(parsed) && parsed >= REQUIRED_NODE_API_VERSION;
}

/** Standalone Node floors from the October 2026 security release; Electron backports differ. */
export function isNodeSecurityVersionSupported(nodeVersion: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const floors: Record<number, readonly [number, number]> = {
    22: [23, 4],
    24: [22, 1],
    26: [12, 1],
  };
  const floor = floors[major];
  return floor !== undefined && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]));
}
