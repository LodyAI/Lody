import { readProcessTable } from '@/monitor/process-table';
import { Effect, Layer } from 'effect';
import { InboxRecoveryProbe, provesResourcesGone } from '../inbox/recovery';
export const inboxRecoveryProbeLayer = Layer.succeed(InboxRecoveryProbe, {
  released: Effect.fn('InboxRecoveryProbe.released')(function* (identity) {
    if (identity.complete !== true || identity.platform === 'win32' || !identity.roots.length)
      return false;
    const snapshot = yield* Effect.tryPromise({
      try: () => readProcessTable(identity.platform),
      catch: (cause) => cause,
    });
    return provesResourcesGone(identity, snapshot);
  }),
});
