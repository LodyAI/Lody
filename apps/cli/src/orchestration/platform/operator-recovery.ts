import {
  acquireLocalCliHostLease,
  type LocalCliHostEndpoint,
} from '@lody/shared/node/local-cli-host-lease';
import { Effect, Semaphore } from 'effect';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readProcessTable } from '@/monitor/process-table';
import { knownOperatorResourcesGone } from '../inbox/recovery';
import { getLodyOperationStorePath, LodyOperationStore } from '../operation-store';
import type { InboxOperatorRecoveryPorts } from '../inbox/operator-recovery';
import { InboxSqlite } from '../inbox/sqlite';

/** Read-only owner; the command composes this only after acquiring the Host lease. */
export const openInboxInspection = (filename: string) => {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const version = db
      .prepare("SELECT value FROM orchestration_meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    if (version?.value !== '2') throw new Error('Unsupported Inbox schema version');
    // Compile every observation query even for an empty workspace. Missing columns/tables
    // must not be mistaken for evidence that there is nothing to recover.
    db.prepare(
      'SELECT user_id,revision,paused,blocked,active_execution,active_input FROM inbox_sessions LIMIT 0'
    );
    db.prepare(
      'SELECT execution_id,user_id,identity_json,state,cause FROM inbox_resources LIMIT 0'
    );
    db.prepare('SELECT input_id,canceled,finished,revision FROM inbox_inputs LIMIT 0');
    db.prepare('SELECT batch_id,input_id,user_id,revision,owner,state FROM inbox_batches LIMIT 0');
    db.prepare('SELECT intent_id,state,batch_id FROM inbox_intents LIMIT 0');
    if (db.prepare('SELECT 1 FROM inbox_modes WHERE protocol<>2 LIMIT 1').get())
      throw new Error('Unsupported Inbox protocol');
  } catch (cause) {
    db.close();
    throw new Error(
      'Inbox inspection does not support this store schema. Use the Lody version that owns this store; no migration or recovery was performed.',
      { cause }
    );
  }
  return { inbox: new InboxSqlite(db), close: () => db.close() };
};

/** Scoped local operator adapter. Hold the Host lease BEFORE opening or migrating SQLite. */
export const makeInboxOperatorRecovery = Effect.fn('Inbox.operatorRecoveryPlatform')(function* (
  machineId: string,
  workspaceId: string,
  options: { filename?: string; endpoint?: LocalCliHostEndpoint; inspectOnly?: boolean } = {}
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
      if (options.inspectOnly) return openInboxInspection(filename);
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
      const identities = record.resources.flatMap((resource) =>
        resource.identity ? [resource.identity] : []
      );
      if (identities.some((identity) => identity.platform !== process.platform)) return false;
      if (identities.length === 0) return true;
      const snapshot = yield* Effect.tryPromise({
        try: () => readProcessTable(process.platform),
        catch: (cause) => cause,
      });
      return knownOperatorResourcesGone(record, process.platform, snapshot);
    }),
    confirm: (record) =>
      Effect.try(() =>
        record.executionId === null
          ? sql.recoverOrphanedBlock(record.scope, record.snapshotToken)
          : sql.recoverBlocked(record.scope, record.executionId, record.snapshotToken)
      ),
  } satisfies InboxOperatorRecoveryPorts;
});
