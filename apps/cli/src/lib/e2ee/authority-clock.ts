/** Two clocks, so a changed wall clock cannot extend a limit and a suspend cannot hide inside one. */
export type AuthorityStamp = { readonly wall: number; readonly monotonic: bigint };

/** Allowed drift between the clocks. More than this means a suspend or a clock change. */
const AUTHORITY_CLOCK_SKEW_MS = 60_000;

export const authorityStamp = (): AuthorityStamp => ({
  wall: Date.now(),
  monotonic: process.hrtime.bigint(),
});

const elapsed = (start: AuthorityStamp, now: AuthorityStamp) => ({
  wall: now.wall - start.wall,
  monotonic: Number((now.monotonic - start.monotonic) / 1_000_000n),
});

/** False after a clock rollback, a suspend or a clock change since `start`. */
export const authorityClocksAgree = (start: AuthorityStamp, now: AuthorityStamp): boolean => {
  const { wall, monotonic } = elapsed(start, now);
  return wall >= 0 && monotonic >= 0 && Math.abs(wall - monotonic) < AUTHORITY_CLOCK_SKEW_MS;
};

export const withinAuthorityLimit = (
  start: AuthorityStamp,
  now: AuthorityStamp,
  limitMs: number
): boolean => {
  const { wall, monotonic } = elapsed(start, now);
  return authorityClocksAgree(start, now) && wall < limitMs && monotonic < limitMs;
};

/** Time left under {@link withinAuthorityLimit}, assuming the clocks stay in step. */
export const authorityTimeLeft = (
  start: AuthorityStamp,
  now: AuthorityStamp,
  limitMs: number
): number => {
  const { wall, monotonic } = elapsed(start, now);
  return limitMs - Math.max(wall, monotonic);
};
