import {
  acquireLocalCliHostLease,
  type LocalCliHostEndpoint,
} from '@lody/shared/node/local-cli-host-lease';
import { Effect, Semaphore } from 'effect';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readProcessTable } from '@/monitor/process-table';
import { getLodyOperationStorePath, LodyOperationStore } from '../operation-store';
import type { InboxOperatorRecoveryPorts } from '../inbox/operator-recovery';

/** Scoped local operator adapter. Hold the Host lease BEFORE opening or migrating SQLite. */
export const makeInboxOperatorRecovery = Effect.fn('Inbox.operatorRecoveryPlatform')(function* (
  machineId: string,
  workspaceId: string,
  options: { filename?: string; endpoint?: LocalCliHostEndpoint } = {}
) {
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const result = await acquireLocalCliHostLease({
          instanceId: randomUUID(),
          mode: 'foreground',
          endpoint: options.endpoint,
        });
        if (result.status !== 'acquired')
          throw new Error('Stop the local daemon and desktop before recovering Inbox resources');
        return result.lease;
      },
      catch: (cause) => cause,
    }),
    (lease) =>
      Effect.tryPromise({ try: () => lease.close(), catch: (cause) => cause }).pipe(Effect.orDie)
  );
  const filename = options.filename ?? getLodyOperationStorePath(machineId);
  const store = yield* Effect.acquireRelease(
    Effect.try(() => {
      if (!existsSync(filename)) throw new Error('Local Operation store does not exist');
      return new LodyOperationStore(filename, undefined, { maintenance: false });
    }),
    (connectionOwner) => Effect.sync(() => connectionOwner.close())
  );
  const gate = yield* Semaphore.make(1);
  const sql = store.inbox;
  return {
    blocked: Effect.try(() => sql.blockedExecutions(workspaceId)),
    exclusive: (work) => gate.withPermit(work),
    knownResourcesGone: Effect.fn('Inbox.operatorKnownResources')(function* (record) {
      const identity = record.identity;
      if (!identity) return true;
      if (identity.platform !== process.platform) return false;
      const snapshot = yield* Effect.tryPromise({
        try: () => readProcessTable(identity.platform),
        catch: (cause) => cause,
      });
      return (
        snapshot.warnings.length === 0 &&
        identity.roots.every(
          (pid) =>
            !snapshot.entries.some((entry) => entry.pid === pid || entry.processGroupId === pid)
        )
      );
    }),
    confirm: (record) => Effect.try(() => sql.recoverBlocked(record.scope, record.executionId)),
  } satisfies InboxOperatorRecoveryPorts;
});
