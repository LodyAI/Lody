export interface EagerSyncPolicy {
  concurrency: number;
  batchSize: number;
  batchCooldownMs: number;
  freshnessTtlMs: number;
  candidateWindow: number;
  prefetchTimeoutMs: number;
}

export type EagerSyncSurface = 'web' | 'desktop' | 'mobile';

export const EAGER_SYNC_CANDIDATE_WINDOW = 20;
export const WEB_EAGER_SYNC_CANDIDATE_WINDOW = EAGER_SYNC_CANDIDATE_WINDOW;
/** @deprecated All surfaces now use a bounded candidate window. */
export const FULL_EAGER_SYNC_CANDIDATE_WINDOW = EAGER_SYNC_CANDIDATE_WINDOW;

export const WEB_EAGER_SYNC_POLICY: EagerSyncPolicy = {
  concurrency: 1,
  batchSize: 1,
  batchCooldownMs: 1_500,
  freshnessTtlMs: 15_000,
  candidateWindow: WEB_EAGER_SYNC_CANDIDATE_WINDOW,
  prefetchTimeoutMs: 20_000,
};

export const DESKTOP_EAGER_SYNC_POLICY: EagerSyncPolicy = {
  concurrency: 1,
  batchSize: 1,
  batchCooldownMs: 1_500,
  freshnessTtlMs: 15_000,
  candidateWindow: EAGER_SYNC_CANDIDATE_WINDOW,
  prefetchTimeoutMs: 20_000,
};

/** @deprecated Desktop prefetch is no longer full-history. */
export const FULL_EAGER_SYNC_POLICY = DESKTOP_EAGER_SYNC_POLICY;

export const MOBILE_EAGER_SYNC_POLICY: EagerSyncPolicy = {
  concurrency: 1,
  batchSize: 1,
  batchCooldownMs: 3_000,
  freshnessTtlMs: 15_000,
  candidateWindow: EAGER_SYNC_CANDIDATE_WINDOW,
  prefetchTimeoutMs: 20_000,
};

export const DEFAULT_EAGER_SYNC_POLICY = WEB_EAGER_SYNC_POLICY;

export const resolveEagerSyncPolicy = (surface: EagerSyncSurface): EagerSyncPolicy => {
  if (surface === 'web') return WEB_EAGER_SYNC_POLICY;
  if (surface === 'mobile') return MOBILE_EAGER_SYNC_POLICY;
  return DESKTOP_EAGER_SYNC_POLICY;
};
