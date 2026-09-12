import { describe, expect, it } from 'vitest';

import { resolveEagerSyncPolicy } from '../src/providers/eager-sync-policy';

describe('resolveEagerSyncPolicy', () => {
  it('uses a bounded web policy, full desktop policy, and paced mobile policy', () => {
    expect(resolveEagerSyncPolicy('web')).toMatchObject({
      concurrency: 2,
      batchSize: 4,
      batchCooldownMs: 1_500,
      candidateWindow: 20,
      maxWarmDocs: 20,
    });
    expect(resolveEagerSyncPolicy('desktop')).toMatchObject({
      concurrency: 3,
      batchSize: 8,
      batchCooldownMs: 750,
      candidateWindow: Number.POSITIVE_INFINITY,
      maxWarmDocs: 96,
    });
    expect(resolveEagerSyncPolicy('mobile')).toMatchObject({
      concurrency: 1,
      batchSize: 3,
      batchCooldownMs: 3_000,
      candidateWindow: Number.POSITIVE_INFINITY,
      maxWarmDocs: 12,
    });
  });
});
