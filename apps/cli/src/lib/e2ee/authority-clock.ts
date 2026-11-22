/** Use the greater elapsed time to tolerate wall-clock correction and paused suspend clocks. */
export type AuthorityStamp = { readonly wall: number; readonly monotonic: bigint };

export const authorityStamp = (): AuthorityStamp => ({
  wall: Date.now(),
  monotonic: process.hrtime.bigint(),
});

const elapsed = (start: AuthorityStamp, now: AuthorityStamp) => ({
  wall: now.wall - start.wall,
  monotonic: Number((now.monotonic - start.monotonic) / 1_000_000n),
});

export const withinAuthorityLimit = (
  start: AuthorityStamp,
  now: AuthorityStamp,
  limitMs: number
): boolean => {
  const { wall, monotonic } = elapsed(start, now);
  return monotonic >= 0 && Math.max(wall, monotonic) < limitMs;
};

/** Time left under {@link withinAuthorityLimit}, using the greater elapsed time. */
export const authorityTimeLeft = (
  start: AuthorityStamp,
  now: AuthorityStamp,
  limitMs: number
): number => {
  const { wall, monotonic } = elapsed(start, now);
  return limitMs - Math.max(wall, monotonic);
};
