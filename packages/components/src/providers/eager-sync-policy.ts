export interface EagerSyncPolicy {
  concurrency: number;
  batchSize: number;
  batchCooldownMs: number;
  freshnessTtlMs: number;
  maxWarmDocs: number;
  candidateWindow: number;
  prefetchTimeoutMs: number;
}

export type EagerSyncSurface = 'web' | 'desktop' | 'mobile';

export const WEB_EAGER_SYNC_CANDIDATE_WINDOW = 20;
export const FULL_EAGER_SYNC_CANDIDATE_WINDOW = Number.POSITIVE_INFINITY;

export const WEB_EAGER_SYNC_POLICY: EagerSyncPolicy = {
  concurrency: 2,
  batchSize: 4,
  batchCooldownMs: 1_500,
  freshnessTtlMs: 15_000,
  maxWarmDocs: 20,
  candidateWindow: WEB_EAGER_SYNC_CANDIDATE_WINDOW,
  prefetchTimeoutMs: 20_000,
};

export const FULL_EAGER_SYNC_POLICY: EagerSyncPolicy = {
  concurrency: 3,
  batchSize: 8,
  batchCooldownMs: 750,
  freshnessTtlMs: 15_000,
  maxWarmDocs: 96,
  candidateWindow: FULL_EAGER_SYNC_CANDIDATE_WINDOW,
  prefetchTimeoutMs: 20_000,
};

export const MOBILE_EAGER_SYNC_POLICY: EagerSyncPolicy = {
  concurrency: 1,
  batchSize: 3,
  batchCooldownMs: 3_000,
  freshnessTtlMs: 15_000,
  maxWarmDocs: 12,
  candidateWindow: FULL_EAGER_SYNC_CANDIDATE_WINDOW,
  prefetchTimeoutMs: 20_000,
};

export const DEFAULT_EAGER_SYNC_POLICY = WEB_EAGER_SYNC_POLICY;

export const resolveEagerSyncPolicy = (surface: EagerSyncSurface): EagerSyncPolicy => {
  if (surface === 'web') return WEB_EAGER_SYNC_POLICY;
  if (surface === 'mobile') return MOBILE_EAGER_SYNC_POLICY;
  return FULL_EAGER_SYNC_POLICY;
};
