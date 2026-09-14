import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  canonicalizeSessionLifecycleOperation,
  encodeSessionLifecycleOperation,
  parseSessionLifecycleOperation,
  SessionLifecycleAdmissionRejectedError,
  SessionLifecycleOperationConflictError,
  type SessionLifecycleAdmission,
  type SessionLifecycleAdmissionStore,
  type SessionLifecycleOperationDraft,
  type WorkspaceId,
} from '@lody/shared';
import { getLoroRepoStorageBaseDir } from './sqlite-repo-store';

type AdmissionRow = {
  operation_json: string;
  published: number;
};

type StateRow = { value: string };

type AdmissionFaults = {
  beforeWrite?: () => void;
  afterCommit?: () => void;
};

export const getSessionLifecycleSqlitePath = (workspaceId: WorkspaceId): string =>
  path.join(getLoroRepoStorageBaseDir(workspaceId), 'session-lifecycle.sqlite3');

function decodeAdmission(row: AdmissionRow): SessionLifecycleAdmission {
  return {
    operation: parseSessionLifecycleOperation(JSON.parse(row.operation_json)),
    published: row.published === 1,
  };
}

function draftMatchesAdmission(
  draft: SessionLifecycleOperationDraft,
  admission: SessionLifecycleAdmission
): boolean {
  return (
    encodeSessionLifecycleOperation(admission.operation) ===
    encodeSessionLifecycleOperation(
      canonicalizeSessionLifecycleOperation({
        version: 1,
        ...draft,
        order: admission.operation.order,
      })
    )
  );
}

export async function createSqliteSessionLifecycleAdmissionStore(options: {
  workspaceId: WorkspaceId;
  dbPath?: string;
  faults?: AdmissionFaults;
}): Promise<SessionLifecycleAdmissionStore> {
  const dbPath = options.dbPath ?? getSessionLifecycleSqlitePath(options.workspaceId);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_lifecycle_operations (
      operation_id TEXT PRIMARY KEY,
      operation_json TEXT NOT NULL,
      published INTEGER NOT NULL CHECK (published IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS session_lifecycle_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const selectOne = database.prepare<[string], AdmissionRow>(
    'SELECT operation_json, published FROM session_lifecycle_operations WHERE operation_id = ?'
  );
  const selectAll = database.prepare<[], AdmissionRow>(
    'SELECT operation_json, published FROM session_lifecycle_operations ORDER BY operation_id'
  );
  const selectState = database.prepare<[string], StateRow>(
    'SELECT value FROM session_lifecycle_state WHERE key = ?'
  );
  const insertOperation = database.prepare<[string, string]>(
    'INSERT INTO session_lifecycle_operations(operation_id, operation_json, published) VALUES (?, ?, 0)'
  );
  const upsertState = database.prepare<[string, string]>(
    'INSERT INTO session_lifecycle_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const markPublished = database.prepare<[string]>(
    'UPDATE session_lifecycle_operations SET published = 1 WHERE operation_id = ?'
  );

  const admit = database.transaction(
    (
      draft: SessionLifecycleOperationDraft,
      actorId: string,
      observedCounter: string
    ): SessionLifecycleAdmission => {
      const existingRow = selectOne.get(draft.operationId);
      if (existingRow) {
        const existing = decodeAdmission(existingRow);
        if (!draftMatchesAdmission(draft, existing)) {
          throw new SessionLifecycleOperationConflictError(draft.operationId);
        }
        return existing;
      }
      const localCounter = BigInt(selectState.get('highWater')?.value ?? '0');
      const observed = BigInt(observedCounter);
      const counter = (localCounter > observed ? localCounter : observed) + 1n;
      const operation = canonicalizeSessionLifecycleOperation({
        version: 1,
        ...draft,
        order: { counter: counter.toString(10), actorId },
      });
      insertOperation.run(operation.operationId, encodeSessionLifecycleOperation(operation));
      upsertState.run('highWater', counter.toString(10));
      return { operation, published: false };
    }
  );
  const observeCounter = database.transaction((counter: string) => {
    const current = BigInt(selectState.get('highWater')?.value ?? '0');
    const observed = BigInt(counter);
    if (observed > current) upsertState.run('highWater', counter);
  });
  const seed = database.transaction((operationJson: string, operationId: string) => {
    const existingRow = selectOne.get(operationId);
    if (existingRow) {
      const existing = decodeAdmission(existingRow);
      if (encodeSessionLifecycleOperation(existing.operation) !== operationJson) {
        throw new SessionLifecycleOperationConflictError(operationId);
      }
      return existing;
    }
    insertOperation.run(operationId, operationJson);
    return { operation: parseSessionLifecycleOperation(JSON.parse(operationJson)), published: false };
  });

  return {
    async list() {
      return selectAll.all().map(decodeAdmission);
    },
    async get(operationId) {
      const row = selectOne.get(operationId);
      return row ? decodeAdmission(row) : undefined;
    },
    async admit(draft, actorId, observedCounter) {
      let admission: SessionLifecycleAdmission;
      try {
        options.faults?.beforeWrite?.();
        admission = admit.immediate(draft, actorId, observedCounter);
      } catch (cause) {
        if (cause instanceof SessionLifecycleOperationConflictError) throw cause;
        throw new SessionLifecycleAdmissionRejectedError(
          cause instanceof Error ? cause.message : 'SQLite lifecycle admission rejected',
          { cause }
        );
      }
      options.faults?.afterCommit?.();
      return admission;
    },
    async observeCounter(counter) {
      observeCounter.immediate(counter);
    },
    async seed(operation) {
      return seed.immediate(encodeSessionLifecycleOperation(operation), operation.operationId);
    },
    async markPublished(operationId) {
      markPublished.run(operationId);
    },
    async close() {
      database.close();
    },
  };
}
