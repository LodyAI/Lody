import { getLogger } from '@/utils/logger';
import type { StoredLodyOperation } from '@lody/shared';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OrchestrationConnection } from '../platform/database';
import {
  batchDepth,
  type InboxBatch,
  type InboxInput,
  type InboxMember,
  type InboxRelease,
  type InboxScope,
} from './model';
import { canFenceBatch, inputAcceptance, operationInboxCompletion } from './rules';

const StateRow = z.object({
  revision: z.number(),
  paused: z.number(),
  active_execution: z.string().nullable(),
  active_input: z.string().nullable(),
});
const BatchRow = z.object({
  batch_id: z.string(),
  workspace_id: z.string(),
  session_id: z.string(),
  user_id: z.string(),
  input_id: z.string(),
  kind: z.enum(['human', 'task', 'automatic', 'automation']),
  config_json: z.string(),
  revision: z.number(),
  owner: z.string(),
  watermark: z.number(),
  member_count: z.number().positive(),
  chain_depth: z.number(),
  state: z.enum(['prepared', 'submitting', 'submitted', 'unknown', 'settled', 'superseded']),
});
const MemberRow = z.object({
  sequence: z.number(),
  operation_id: z.string(),
  operation_kind: z.enum([
    'session_create',
    'session_create_many',
    'session_chat',
    'session_chat_many',
  ]),
  source_turn_id: z.string().nullable(),
  created_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  chain_depth: z.number(),
  completion_json: z.string(),
});

/** Uses the Operation connection; completion is indexed in its existing transaction. */
export class InboxSqlite {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly connection?: OrchestrationConnection
  ) {}

  static migrate(db: Database.Database): void {
    if (
      (
        db.prepare("SELECT sql FROM sqlite_master WHERE name='inbox_modes'").get() as
          | { sql: string }
          | undefined
      )?.sql.includes('protocol=2') &&
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='inbox_resources'").get() &&
      (db.prepare('PRAGMA table_info(inbox_sessions)').all() as { name: string }[]).some(
        (c) => c.name === 'active_input'
      ) &&
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='inbox_stops'").get() &&
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='inbox_recoveries'").get() &&
      (db.prepare('PRAGMA table_info(inbox_resources)').all() as { name: string }[]).some(
        (c) => c.name === 'generation'
      ) &&
      (db.prepare('PRAGMA table_info(inbox_results)').all() as { name: string }[]).some(
        (c) => c.name === 'consumed_at'
      ) &&
      (db.prepare('PRAGMA table_info(inbox_inputs)').all() as { name: string }[]).some(
        (c) => c.name === 'cancellation_reason'
      )
    )
      return;
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS inbox_recoveries(
          workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, snapshot_token TEXT NOT NULL,
          execution_id TEXT, recovered_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id,session_id,snapshot_token));
        CREATE TABLE IF NOT EXISTS inbox_stops(
          workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, cancel_id TEXT NOT NULL,
          execution_id TEXT NOT NULL, user_id TEXT NOT NULL, revision INTEGER NOT NULL,
          PRIMARY KEY(workspace_id,session_id,cancel_id));
        CREATE TABLE IF NOT EXISTS inbox_resources(
          workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
          execution_id TEXT NOT NULL, identity_json TEXT, state TEXT NOT NULL DEFAULT 'active', cause TEXT, generation INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(workspace_id,session_id,execution_id));
        CREATE TABLE IF NOT EXISTS inbox_modes(workspace_id TEXT PRIMARY KEY, owner TEXT NOT NULL, protocol INTEGER NOT NULL CHECK(protocol=2));
        CREATE TABLE IF NOT EXISTS inbox_sessions(
          workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
          blocked INTEGER NOT NULL DEFAULT 0, active_execution TEXT, active_input TEXT, config_json TEXT,
          PRIMARY KEY(workspace_id,session_id,user_id));
        CREATE TABLE IF NOT EXISTS inbox_results(
          sequence INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
          user_id TEXT NOT NULL, operation_id TEXT NOT NULL, operation_kind TEXT NOT NULL, source_turn_id TEXT, created_at TEXT, completed_at TEXT,
          chain_depth INTEGER NOT NULL, completion_json TEXT NOT NULL,
          automatic_eligible INTEGER NOT NULL DEFAULT 1, claim TEXT, consumed INTEGER NOT NULL DEFAULT 0, consumed_at TEXT,
          UNIQUE(session_id,operation_id));
        CREATE TABLE IF NOT EXISTS inbox_inputs(
          workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
          input_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
          canceled INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(workspace_id,session_id,input_id));
        CREATE TABLE IF NOT EXISTS inbox_releases(
          workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
          execution_id TEXT NOT NULL, outcome TEXT NOT NULL, watermark INTEGER NOT NULL,
          PRIMARY KEY(workspace_id,session_id,execution_id));
        CREATE TABLE IF NOT EXISTS inbox_intents(
          intent_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
          user_id TEXT NOT NULL, execution_id TEXT NOT NULL, watermark INTEGER NOT NULL,
          input_json TEXT NOT NULL, batch_id TEXT, state TEXT NOT NULL DEFAULT 'pending',
          UNIQUE(workspace_id,session_id,execution_id));
        CREATE TABLE IF NOT EXISTS inbox_batches(
          batch_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
          user_id TEXT NOT NULL, input_id TEXT NOT NULL, kind TEXT NOT NULL,
          config_json TEXT NOT NULL, revision INTEGER NOT NULL, owner TEXT NOT NULL,
          watermark INTEGER NOT NULL, member_count INTEGER NOT NULL CHECK(member_count>0),
          chain_depth INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'prepared', cause TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS inbox_live_input ON inbox_batches(workspace_id,session_id,input_id)
          WHERE state IN ('prepared','submitting','submitted','unknown');
        CREATE TABLE IF NOT EXISTS inbox_members(
          batch_id TEXT NOT NULL REFERENCES inbox_batches(batch_id), sequence INTEGER NOT NULL REFERENCES inbox_results(sequence),
          PRIMARY KEY(batch_id,sequence));
      `);
      if (
        !(db.prepare('PRAGMA table_info(inbox_resources)').all() as { name: string }[]).some(
          (c) => c.name === 'generation'
        )
      )
        db.exec('ALTER TABLE inbox_resources ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
      if (
        !(db.prepare('PRAGMA table_info(inbox_inputs)').all() as { name: string }[]).some(
          (c) => c.name === 'cancellation_reason'
        )
      )
        db.exec('ALTER TABLE inbox_inputs ADD COLUMN cancellation_reason TEXT');
      const modesSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name='inbox_modes'").get() as {
          sql: string;
        }
      ).sql;
      if (!modesSql.includes('protocol=2')) {
        db.exec(`ALTER TABLE inbox_modes RENAME TO inbox_modes_v1;
          CREATE TABLE inbox_modes(workspace_id TEXT PRIMARY KEY,owner TEXT NOT NULL,protocol INTEGER NOT NULL CHECK(protocol=2));
          INSERT INTO inbox_modes SELECT workspace_id,owner,2 FROM inbox_modes_v1;
          DROP TABLE inbox_modes_v1;`);
      }
      if (
        !(db.prepare('PRAGMA table_info(inbox_results)').all() as { name: string }[]).some(
          (c) => c.name === 'consumed_at'
        )
      ) {
        db.exec('ALTER TABLE inbox_results ADD COLUMN consumed_at TEXT');
        db.exec('UPDATE inbox_results SET consumed_at=completed_at WHERE consumed=1');
      }
      if (
        !(db.prepare('PRAGMA table_info(inbox_sessions)').all() as { name: string }[]).some(
          (c) => c.name === 'active_input'
        )
      )
        db.exec('ALTER TABLE inbox_sessions ADD COLUMN active_input TEXT');
    }).immediate();
  }

  /** Persist the receipt and idle wake intent in the same Operation completion transaction. */
  indexCompletion(operation: StoredLodyOperation): void {
    if (!operation.completion || !operation.finishedAt) throw new Error('Missing completion');
    if (
      this.db
        .prepare('SELECT 1 FROM inbox_results WHERE session_id=? AND operation_id=?')
        .get(operation.requesterSessionId, operation.operationId)
    )
      return;
    const receipt = operationInboxCompletion(operation.completion);
    const { value } = this.db
      .prepare(
        "UPDATE orchestration_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='inbox_sequence' RETURNING CAST(value AS INTEGER) AS value"
      )
      .get() as { value: number };
    this.db
      .prepare(`INSERT INTO inbox_results(sequence,workspace_id,session_id,user_id,operation_id,operation_kind,source_turn_id,created_at,completed_at,chain_depth,completion_json,automatic_eligible,consumed,consumed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
      .run(
        value,
        operation.workspaceId,
        operation.requesterSessionId,
        operation.requesterUserId,
        operation.operationId,
        operation.kind,
        operation.frozenContinuationConfig.sourceTurnId ?? null,
        operation.createdAt,
        operation.finishedAt,
        operation.initiatorChainDepth,
        JSON.stringify(receipt ?? operation.completion),
        receipt ? 0 : 1,
        receipt ? null : this.now()
      );
    if (!receipt) return;
    this.requestAutomatic(
      {
        workspaceId: operation.workspaceId,
        sessionId: operation.requesterSessionId,
        userId: operation.requesterUserId,
      },
      operation.frozenContinuationConfig.inputConfig ?? {},
      `completion:${value}`
    );
  }
  private requestAutomatic(
    scope: InboxScope,
    config: InboxInput['config'],
    executionId: string
  ): void {
    this.ensure(scope);
    if (
      this.db
        .prepare(
          'SELECT 1 FROM inbox_sessions WHERE workspace_id=? AND session_id=? AND (paused=1 OR active_execution IS NOT NULL)'
        )
        .get(scope.workspaceId, scope.sessionId)
    )
      return;
    if (
      this.db
        .prepare(
          'SELECT 1 FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND canceled=0 AND finished=0'
        )
        .get(scope.workspaceId, scope.sessionId)
    )
      return;
    if (
      this.db
        .prepare(
          "SELECT 1 FROM inbox_intents WHERE workspace_id=? AND session_id=? AND state IN ('pending','prepared')"
        )
        .get(scope.workspaceId, scope.sessionId)
    )
      return;
    const watermark = this.watermark(scope);
    if (!this.available(scope, watermark, true).length) return;
    const input: InboxInput = {
      ...scope,
      config,
      kind: 'automatic',
      inputId: `inbox:${executionId}`,
    };
    this.db
      .prepare(
        "INSERT INTO inbox_intents(intent_id,workspace_id,session_id,user_id,execution_id,watermark,input_json,state) VALUES(?,?,?,?,?,?,?,'pending')"
      )
      .run(
        randomUUID(),
        scope.workspaceId,
        scope.sessionId,
        scope.userId,
        executionId,
        watermark,
        JSON.stringify(input)
      );
  }
  hasRunnableWork(workspaceId: string, sessionId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM inbox_sessions s WHERE s.workspace_id=? AND s.session_id=? AND
      (s.active_execution IS NOT NULL OR (s.paused=0 AND EXISTS(
        SELECT 1 FROM inbox_intents i WHERE i.workspace_id=s.workspace_id AND i.session_id=s.session_id AND i.user_id=s.user_id AND i.state IN ('pending','prepared')))) LIMIT 1`)
      .get(workspaceId, sessionId);
  }
  closeConnection(): void {
    if (this.db.open) this.db.close();
  }
  /** Called in the Operation retention transaction. Never expire live claims. */
  cleanupExpired(): void {
    const expired = this.db
      .prepare(`SELECT b.batch_id FROM inbox_batches b
      WHERE b.state IN ('settled','unknown','superseded') AND NOT EXISTS(
        SELECT 1 FROM inbox_members m JOIN inbox_results r USING(sequence)
        JOIN operations o ON o.requester_session_id=r.session_id AND o.operation_id=r.operation_id
        WHERE m.batch_id=b.batch_id)`)
      .all() as { batch_id: string }[];
    for (const { batch_id } of expired) {
      this.db.prepare('DELETE FROM inbox_members WHERE batch_id=?').run(batch_id);
      this.db.prepare('DELETE FROM inbox_intents WHERE batch_id=?').run(batch_id);
      this.db.prepare('DELETE FROM inbox_batches WHERE batch_id=?').run(batch_id);
    }
    this.db.exec(`DELETE FROM inbox_results WHERE consumed=1
      AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.requester_session_id=inbox_results.session_id AND o.operation_id=inbox_results.operation_id)
      AND NOT EXISTS(SELECT 1 FROM inbox_members m WHERE m.sequence=inbox_results.sequence);
      UPDATE inbox_intents SET input_json='{}' WHERE state NOT IN ('pending','prepared');`);
  }
  /** Permanent session deletion removes all copied user data, including passive results. */
  deleteSession(sessionId: string): void {
    this.db
      .prepare(
        'DELETE FROM inbox_members WHERE batch_id IN(SELECT batch_id FROM inbox_batches WHERE session_id=?)'
      )
      .run(sessionId);
    for (const table of [
      'inbox_batches',
      'inbox_results',
      'inbox_intents',
      'inbox_releases',
      'inbox_inputs',
      'inbox_resources',
      'inbox_stops',
      'inbox_recoveries',
      'inbox_sessions',
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
    }
  }
  private transaction<A>(f: () => A): A {
    return this.connection
      ? (this.connection.withImmediate(f as () => never) as A)
      : this.db.transaction(f).immediate();
  }
  private ensure(s: InboxScope): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO inbox_sessions(workspace_id,session_id,user_id,paused) SELECT ?,?,?,COALESCE(MAX(paused),0) FROM inbox_sessions WHERE workspace_id=? AND session_id=?'
      )
      .run(s.workspaceId, s.sessionId, s.userId, s.workspaceId, s.sessionId);
  }
  private state(s: InboxScope) {
    this.ensure(s);
    return StateRow.parse(
      this.db
        .prepare(
          'SELECT revision,paused,active_execution,active_input FROM inbox_sessions WHERE workspace_id=? AND session_id=? AND user_id=?'
        )
        .get(s.workspaceId, s.sessionId, s.userId)
    );
  }
  private currentOwner(workspaceId: string, owner: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM inbox_modes WHERE workspace_id=? AND owner=? AND protocol=2')
      .get(workspaceId, owner);
  }
  activate(workspaceId: string, owner: string): void {
    this.transaction(() => {
      const prior = this.db
        .prepare('SELECT protocol FROM inbox_modes WHERE workspace_id=?')
        .get(workspaceId) as { protocol: number } | undefined;
      if (prior && prior.protocol !== 2) throw new Error('INBOX_PROTOCOL_REQUIRED');
      // The host lease/process-exit barrier is required before changing the owner.
      this.db
        .prepare(
          'INSERT INTO inbox_modes VALUES(?,?,2) ON CONFLICT(workspace_id) DO UPDATE SET owner=excluded.owner'
        )
        .run(workspaceId, owner);
      const uncertain = this.db
        .prepare(
          "SELECT * FROM inbox_batches WHERE workspace_id=? AND owner<>? AND state IN ('submitting','submitted')"
        )
        .all(workspaceId, owner);
      for (const row of uncertain)
        this.settle(
          this.decodeBatch(row),
          'unknown',
          'Previous owner exited without a final receipt'
        );
      this.db
        .prepare("UPDATE inbox_batches SET owner=? WHERE workspace_id=? AND state='prepared'")
        .run(owner, workspaceId);
      const interrupted = this.db
        .prepare(
          'SELECT workspace_id,session_id,user_id,active_execution,active_input FROM inbox_sessions WHERE workspace_id=? AND (active_execution IS NOT NULL OR blocked=1)'
        )
        .all(workspaceId) as Array<{
        workspace_id: string;
        session_id: string;
        user_id: string;
        active_execution: string | null;
        active_input: string | null;
      }>;
      for (const row of interrupted) {
        if (row.active_input) {
          this.supersedeInput(workspaceId, row.session_id, row.active_input);
          this.db
            .prepare(
              'UPDATE inbox_inputs SET finished=1 WHERE workspace_id=? AND session_id=? AND input_id=?'
            )
            .run(workspaceId, row.session_id, row.active_input);
        }
        this.writeDiagnostic(() => {
          if (row.active_execution)
            this.db
              .prepare('INSERT OR IGNORE INTO inbox_releases VALUES(?,?,?,?,?,?)')
              .run(
                workspaceId,
                row.session_id,
                row.user_id,
                row.active_execution,
                'failed',
                this.watermark({ workspaceId, sessionId: row.session_id, userId: row.user_id })
              );
        });
        getLogger('inbox').warn(
          `[${row.session_id}] Previous run was interrupted when Lody exited; result unknown, not retried`
        );
      }
      // `blocked` is no longer written; clearing it only repairs pre-#2067 stores.
      this.db
        .prepare(
          'UPDATE inbox_sessions SET blocked=0,active_execution=NULL,active_input=NULL,revision=revision+1 WHERE workspace_id=? AND (active_execution IS NOT NULL OR blocked=1)'
        )
        .run(workspaceId);
    });
  }
  deactivate(workspaceId: string, owner: string): void {
    this.db
      .prepare("UPDATE inbox_modes SET owner='' WHERE workspace_id=? AND owner=?")
      .run(workspaceId, owner);
  }
  accept(input: InboxInput): boolean {
    if (input.kind === 'automatic') throw new Error('Automatic work cannot authorize recovery');
    return this.transaction(() => {
      const current = this.state(input);
      if (input.kind === 'automation' && current.paused) return false;
      const old = this.db
        .prepare(
          'SELECT canceled FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND input_id=?'
        )
        .get(input.workspaceId, input.sessionId, input.inputId) as { canceled: number } | undefined;
      const decision = inputAcceptance(old ? old.canceled !== 0 : undefined);
      if (decision !== 'accept') return decision === 'duplicate';
      this.db
        .prepare(
          'UPDATE inbox_sessions SET revision=revision+1 WHERE workspace_id=? AND session_id=? AND user_id<>?'
        )
        .run(input.workspaceId, input.sessionId, input.userId);
      if (input.kind !== 'automation') {
        this.db
          .prepare('UPDATE inbox_sessions SET paused=0 WHERE workspace_id=? AND session_id=?')
          .run(input.workspaceId, input.sessionId);
      }
      const revision = current.revision + 1;
      this.db
        .prepare(
          'INSERT INTO inbox_inputs(workspace_id,session_id,user_id,input_id,kind,revision) VALUES(?,?,?,?,?,?)'
        )
        .run(input.workspaceId, input.sessionId, input.userId, input.inputId, input.kind, revision);
      this.db
        .prepare(
          'UPDATE inbox_sessions SET revision=? WHERE workspace_id=? AND session_id=? AND user_id=?'
        )
        .run(revision, input.workspaceId, input.sessionId, input.userId);
      const replaceAutomatic = !!this.db
        .prepare(
          "SELECT 1 FROM inbox_batches WHERE workspace_id=? AND session_id=? AND kind='automatic' AND state='prepared'"
        )
        .get(input.workspaceId, input.sessionId);
      this.supersedePrepared(input, true);
      if (replaceAutomatic) {
        const mode = this.db
          .prepare('SELECT owner FROM inbox_modes WHERE workspace_id=?')
          .get(input.workspaceId) as { owner: string } | undefined;
        if (mode?.owner) this.prepare(input, mode.owner);
      }
      return true;
    });
  }
  adoptExecution(previous: InboxInput, next: InboxInput, executionId: string): boolean {
    return this.transaction(() => {
      const current = this.state(previous);
      if (
        current.active_execution !== executionId ||
        current.active_input !== previous.inputId ||
        this.inputCanceled(previous.workspaceId, previous.sessionId, previous.inputId) ||
        current.paused
      )
        return false;
      if (!this.accept(next)) return false;
      this.db
        .prepare(
          'UPDATE inbox_inputs SET finished=1 WHERE workspace_id=? AND session_id=? AND input_id=?'
        )
        .run(previous.workspaceId, previous.sessionId, previous.inputId);
      this.db
        .prepare(
          'UPDATE inbox_sessions SET active_execution=NULL,active_input=NULL WHERE workspace_id=? AND session_id=? AND active_execution=?'
        )
        .run(previous.workspaceId, previous.sessionId, executionId);
      this.db
        .prepare(
          'UPDATE inbox_sessions SET active_execution=?,active_input=? WHERE workspace_id=? AND session_id=? AND user_id=?'
        )
        .run(executionId, next.inputId, next.workspaceId, next.sessionId, next.userId);
      return true;
    });
  }
  inputKind(scope: InboxScope, inputId: string): 'human' | 'task' | 'automation' | undefined {
    const row = this.db
      .prepare(
        'SELECT kind FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND user_id=? AND input_id=? AND canceled=0'
      )
      .get(scope.workspaceId, scope.sessionId, scope.userId, inputId) as
      | { kind: 'human' | 'task' | 'automation' }
      | undefined;
    return row?.kind;
  }
  acceptedAutomationInput(scope: InboxScope, inputId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND user_id=? AND input_id=? AND kind='automation'"
        )
        .get(scope.workspaceId, scope.sessionId, scope.userId, inputId) !== undefined
    );
  }
  preferredHumanInput(workspaceId: string, sessionId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT input_id FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND kind='human' AND canceled=0 AND finished=0 ORDER BY revision LIMIT 1"
      )
      .get(workspaceId, sessionId) as { input_id: string } | undefined;
    return row?.input_id;
  }
  inputCancellationReason(
    workspaceId: string,
    sessionId: string,
    inputId: string
  ): 'user_stop' | undefined {
    const row = this.db
      .prepare(
        'SELECT cancellation_reason FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND input_id=?'
      )
      .get(workspaceId, sessionId, inputId) as { cancellation_reason: string | null } | undefined;
    return row?.cancellation_reason === 'user_stop' ? 'user_stop' : undefined;
  }
  executionRelease(scope: InboxScope, executionId: string): InboxRelease['outcome'] | undefined {
    const row = this.db
      .prepare(
        'SELECT outcome FROM inbox_releases WHERE workspace_id=? AND session_id=? AND user_id=? AND execution_id=?'
      )
      .get(scope.workspaceId, scope.sessionId, scope.userId, executionId) as
      | { outcome: InboxRelease['outcome'] }
      | undefined;
    return row?.outcome;
  }
  /** True once an input finished or was canceled; `begin` never admits it again. */
  inputEnded(workspaceId: string, sessionId: string, inputId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT canceled,finished FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND input_id=?'
      )
      .get(workspaceId, sessionId, inputId) as { canceled: number; finished: number } | undefined;
    return row?.canceled === 1 || row?.finished === 1;
  }
  inputCanceled(workspaceId: string, sessionId: string, inputId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT canceled FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND input_id=?'
      )
      .get(workspaceId, sessionId, inputId) as { canceled: number } | undefined;
    return row?.canceled === 1;
  }
  canSubmit(scope: InboxScope, executionId: string, owner: string): boolean {
    const current = this.state(scope);
    return (
      this.currentOwner(scope.workspaceId, owner) &&
      !current.paused &&
      current.active_execution === executionId &&
      !!current.active_input &&
      !this.inputCanceled(scope.workspaceId, scope.sessionId, current.active_input)
    );
  }
  private supersedePrepared(s: InboxScope, automaticOnly = false): void {
    const filter = automaticOnly ? " AND kind='automatic'" : '';
    this.db
      .prepare(
        `UPDATE inbox_results SET claim=NULL WHERE claim IN(SELECT batch_id FROM inbox_batches WHERE workspace_id=? AND session_id=? AND state='prepared'${filter})`
      )
      .run(s.workspaceId, s.sessionId);
    this.db
      .prepare(
        `UPDATE inbox_batches SET state='superseded' WHERE workspace_id=? AND session_id=? AND state='prepared'${filter}`
      )
      .run(s.workspaceId, s.sessionId);
    this.db
      .prepare(
        "UPDATE inbox_intents SET state='superseded' WHERE workspace_id=? AND session_id=? AND state IN ('pending','prepared')"
      )
      .run(s.workspaceId, s.sessionId);
  }
  pauseTarget(
    workspaceId: string,
    sessionId: string,
    requestedId: string
  ): (InboxScope & { executionId: string }) | undefined {
    const active = this.db
      .prepare(
        'SELECT user_id,active_execution,active_input FROM inbox_sessions WHERE workspace_id=? AND session_id=? AND active_execution IS NOT NULL'
      )
      .get(workspaceId, sessionId) as
      | { user_id: string; active_execution: string; active_input: string | null }
      | undefined;
    if (active) {
      if (active.active_execution !== requestedId && active.active_input !== `inbox:${requestedId}`)
        return undefined;
      return { workspaceId, sessionId, userId: active.user_id, executionId: requestedId };
    }
    const release = this.db
      .prepare(
        'SELECT user_id,execution_id FROM inbox_releases WHERE workspace_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1'
      )
      .get(workspaceId, sessionId) as { user_id: string; execution_id: string } | undefined;
    return release?.execution_id === requestedId
      ? { workspaceId, sessionId, userId: release.user_id, executionId: requestedId }
      : undefined;
  }
  pause(
    s: InboxScope,
    executionId: string,
    pendingIds: readonly string[] = [],
    cancelId = `execution:${executionId}`
  ): boolean {
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          'SELECT execution_id,user_id FROM inbox_stops WHERE workspace_id=? AND session_id=? AND cancel_id=?'
        )
        .get(s.workspaceId, s.sessionId, cancelId) as
        | { execution_id: string; user_id: string }
        | undefined;
      if (prior) {
        if (prior.execution_id !== executionId || prior.user_id !== s.userId)
          throw new Error('CONFLICTING_STOP_RECEIPT');
        return true;
      }
      const current = this.state(s);
      const target = this.pauseTarget(s.workspaceId, s.sessionId, executionId);
      if (!target || target.userId !== s.userId) return false;
      this.db
        .prepare('INSERT INTO inbox_stops VALUES(?,?,?,?,?,?)')
        .run(s.workspaceId, s.sessionId, cancelId, executionId, s.userId, current.revision);
      this.supersedePrepared(s);
      for (const id of pendingIds)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO inbox_inputs(workspace_id,session_id,user_id,input_id,kind,revision,canceled) VALUES(?,?,?,?,'task',?,1)"
          )
          .run(s.workspaceId, s.sessionId, s.userId, id, current.revision);
      this.db
        .prepare(
          "UPDATE inbox_inputs SET canceled=1,cancellation_reason='user_stop' WHERE workspace_id=? AND session_id=? AND finished=0"
        )
        .run(s.workspaceId, s.sessionId);
      this.db
        .prepare(
          'UPDATE inbox_sessions SET paused=1,revision=revision+1 WHERE workspace_id=? AND session_id=?'
        )
        .run(s.workspaceId, s.sessionId);
      return true;
    });
  }
  cancelExecution(s: InboxScope, executionId: string, reason?: 'user_stop'): boolean {
    return this.transaction(() => {
      const state = this.state(s);
      if (state.active_execution !== executionId || !state.active_input) return false;
      this.db
        .prepare(
          "INSERT OR IGNORE INTO inbox_inputs(workspace_id,session_id,user_id,input_id,kind,revision,canceled) VALUES(?,?,?,?,'task',?,1)"
        )
        .run(s.workspaceId, s.sessionId, s.userId, state.active_input, state.revision);
      this.db
        .prepare(
          'UPDATE inbox_inputs SET canceled=1,cancellation_reason=COALESCE(?,cancellation_reason) WHERE workspace_id=? AND session_id=? AND input_id=?'
        )
        .run(reason ?? null, s.workspaceId, s.sessionId, state.active_input);
      return true;
    });
  }
  abandonInput(
    workspaceId: string,
    sessionId: string,
    inputId: string,
    unlessActive = false
  ): void {
    this.transaction(() => {
      // Admission rejection did not acquire the old owner. Preserve all of its
      // input evidence if a restart reuses that active input's deterministic ID.
      if (
        unlessActive &&
        this.db
          .prepare(
            'SELECT 1 FROM inbox_sessions WHERE workspace_id=? AND session_id=? AND active_input=?'
          )
          .get(workspaceId, sessionId, inputId)
      )
        return;
      this.db
        .prepare(
          'UPDATE inbox_inputs SET finished=1,canceled=CASE WHEN EXISTS(SELECT 1 FROM inbox_sessions WHERE workspace_id=? AND session_id=? AND active_input=?) THEN canceled ELSE 1 END WHERE workspace_id=? AND session_id=? AND input_id=?'
        )
        .run(workspaceId, sessionId, inputId, workspaceId, sessionId, inputId);
      if (
        !this.db
          .prepare(
            'SELECT 1 FROM inbox_sessions WHERE workspace_id=? AND session_id=? AND active_input=?'
          )
          .get(workspaceId, sessionId, inputId)
      )
        this.supersedeInput(workspaceId, sessionId, inputId);
    });
  }
  private supersedeInput(workspaceId: string, sessionId: string, inputId: string): void {
    this.db
      .prepare(
        "UPDATE inbox_results SET claim=NULL WHERE claim IN(SELECT batch_id FROM inbox_batches WHERE workspace_id=? AND session_id=? AND input_id=? AND state='prepared')"
      )
      .run(workspaceId, sessionId, inputId);
    this.db
      .prepare(
        "UPDATE inbox_batches SET state='superseded' WHERE workspace_id=? AND session_id=? AND input_id=? AND state='prepared'"
      )
      .run(workspaceId, sessionId, inputId);
    this.db
      .prepare(
        "UPDATE inbox_intents SET state='superseded' WHERE batch_id IN(SELECT batch_id FROM inbox_batches WHERE workspace_id=? AND session_id=? AND input_id=? AND state='superseded') AND state='prepared'"
      )
      .run(workspaceId, sessionId, inputId);
  }
  begin(s: InboxScope, executionId: string, owner?: string): boolean {
    return this.transaction(() => {
      const current = this.state(s);
      if (owner && !this.currentOwner(s.workspaceId, owner)) return false;
      if (!('inputId' in s) || typeof s.inputId !== 'string') return false;
      const input = this.db
        .prepare(
          'SELECT canceled,finished,kind FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND user_id=? AND input_id=?'
        )
        .get(s.workspaceId, s.sessionId, s.userId, s.inputId) as
        | { canceled: number; finished: number; kind: string }
        | undefined;
      if (
        input
          ? input.canceled || input.finished
          : !this.db
              .prepare(
                "SELECT 1 FROM inbox_batches WHERE workspace_id=? AND session_id=? AND user_id=? AND input_id=? AND kind='automatic' AND state='prepared' AND revision=?"
              )
              .get(s.workspaceId, s.sessionId, s.userId, s.inputId, current.revision)
      )
        return false;
      if (
        current.paused ||
        (input?.kind === 'automation' && this.preferredHumanInput(s.workspaceId, s.sessionId)) ||
        this.db
          .prepare(
            'SELECT 1 FROM inbox_sessions WHERE workspace_id=? AND session_id=? AND active_execution IS NOT NULL'
          )
          .get(s.workspaceId, s.sessionId)
      )
        return false;
      return (
        this.db
          .prepare(
            'UPDATE inbox_sessions SET active_execution=?,active_input=? WHERE workspace_id=? AND session_id=? AND user_id=? AND active_execution IS NULL'
          )
          .run(executionId, 'inputId' in s ? s.inputId : null, s.workspaceId, s.sessionId, s.userId)
          .changes === 1
      );
    });
  }
  /**
   * Undo `begin` for an execution that submitted nothing and acquired nothing,
   * such as a turn whose machine access is still unverified. No release receipt is
   * written and the input stays unfinished, so the same execution id may begin it
   * again; prepared batch claims stay with the input.
   */
  withdraw(s: InboxScope & { inputId: string }, executionId: string): boolean {
    return this.transaction(() => {
      const current = this.state(s);
      if (current.active_execution !== executionId || current.active_input !== s.inputId)
        return false;
      const used = this.db
        .prepare(
          `SELECT 1 FROM inbox_releases WHERE workspace_id=? AND session_id=? AND execution_id=?
           UNION ALL SELECT 1 FROM inbox_batches WHERE workspace_id=? AND session_id=? AND input_id=? AND state NOT IN ('prepared','superseded')`
        )
        .get(s.workspaceId, s.sessionId, executionId, s.workspaceId, s.sessionId, s.inputId);
      if (used) return false;
      return (
        this.db
          .prepare(
            'UPDATE inbox_sessions SET active_execution=NULL WHERE workspace_id=? AND session_id=? AND active_execution=?'
          )
          .run(s.workspaceId, s.sessionId, executionId).changes === 1
      );
    });
  }
  activeExecution(
    workspaceId: string,
    sessionId: string
  ): (InboxScope & { inputId: string; executionId: string }) | undefined {
    const row = this.db
      .prepare(
        'SELECT user_id,active_input,active_execution FROM inbox_sessions WHERE workspace_id=? AND session_id=? AND active_execution IS NOT NULL'
      )
      .get(workspaceId, sessionId) as
      | { user_id: string; active_input: string | null; active_execution: string }
      | undefined;
    return row
      ? {
          workspaceId,
          sessionId,
          userId: row.user_id,
          inputId: row.active_input ?? '',
          executionId: row.active_execution,
        }
      : undefined;
  }
  release(event: InboxRelease): void {
    this.transaction(() => {
      const existing = this.db
        .prepare(
          'SELECT outcome,user_id FROM inbox_releases WHERE workspace_id=? AND session_id=? AND execution_id=?'
        )
        .get(event.workspaceId, event.sessionId, event.executionId) as
        | { outcome: string; user_id: string }
        | undefined;
      if (existing) {
        if (existing.outcome !== event.outcome || existing.user_id !== event.userId)
          getLogger('inbox').warn(
            `[${event.sessionId}] Conflicting release receipt ignored; keeping the first receipt`
          );
        return;
      }
      const current = this.state(event);
      if (current.active_execution !== event.executionId) return;
      const watermark = (event.releaseWatermark ??= this.watermark(event));
      this.supersedeInput(event.workspaceId, event.sessionId, event.inputId);
      this.writeDiagnostic(() => {
        this.db
          .prepare('INSERT INTO inbox_releases VALUES(?,?,?,?,?,?)')
          .run(
            event.workspaceId,
            event.sessionId,
            event.userId,
            event.executionId,
            event.outcome,
            watermark
          );
      });
      this.db
        .prepare(
          'UPDATE inbox_sessions SET active_execution=NULL,active_input=NULL WHERE workspace_id=? AND session_id=? AND user_id=?'
        )
        .run(event.workspaceId, event.sessionId, event.userId);
      this.db
        .prepare(
          'UPDATE inbox_inputs SET finished=1 WHERE workspace_id=? AND session_id=? AND input_id=?'
        )
        .run(event.workspaceId, event.sessionId, event.inputId);
      const accepted = this.db
        .prepare(
          'SELECT revision FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND input_id=?'
        )
        .get(event.workspaceId, event.sessionId, event.inputId) as { revision: number } | undefined;
      const prepared = this.db
        .prepare(
          'SELECT revision FROM inbox_batches WHERE workspace_id=? AND session_id=? AND input_id=?'
        )
        .get(event.workspaceId, event.sessionId, event.inputId) as { revision: number } | undefined;
      if (
        event.outcome !== 'normal' ||
        current.paused ||
        (accepted ?? prepared)?.revision !== current.revision
      )
        return;
      this.requestAutomatic(event, event.config, event.executionId);
    });
  }
  private writeDiagnostic(write: () => void): void {
    try {
      write();
    } catch (cause) {
      getLogger('inbox').warn(`Inbox diagnostic write failed; continuing: ${String(cause)}`);
    }
  }
  private watermark(s: InboxScope): number {
    return (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence),0) AS value FROM inbox_results WHERE workspace_id=? AND session_id=? AND user_id=?'
        )
        .get(s.workspaceId, s.sessionId, s.userId) as { value: number }
    ).value;
  }
  private available(s: InboxScope, watermark: number, automatic: boolean): InboxMember[] {
    return this.db
      .prepare(
        `SELECT sequence,operation_id,operation_kind,source_turn_id,created_at,completed_at,chain_depth,completion_json FROM inbox_results WHERE workspace_id=? AND session_id=? AND user_id=? AND sequence<=? AND consumed=0 AND claim IS NULL ${automatic ? 'AND automatic_eligible=1' : ''} ORDER BY sequence`
      )
      .all(s.workspaceId, s.sessionId, s.userId, watermark)
      .map((row) => this.decodeMember(row));
  }
  private decodeMember(row: unknown): InboxMember {
    const r = MemberRow.parse(row);
    return {
      sequence: r.sequence,
      operationId: r.operation_id,
      operationKind: r.operation_kind,
      ...(r.created_at ? { createdAt: r.created_at } : {}),
      ...(r.completed_at ? { completedAt: r.completed_at } : {}),
      ...(r.source_turn_id ? { sourceTurnId: r.source_turn_id } : {}),
      chainDepth: r.chain_depth,
      completion: JSON.parse(r.completion_json),
    };
  }
  pending(workspaceId: string): Array<{ intentId: string; input: InboxInput }> {
    return this.db
      .prepare(
        "SELECT intent_id,input_json FROM inbox_intents WHERE workspace_id=? AND state IN ('pending','prepared') ORDER BY rowid"
      )
      .all(workspaceId)
      .map((row) => {
        const r = row as { intent_id: string; input_json: string };
        return { intentId: r.intent_id, input: JSON.parse(r.input_json) as InboxInput };
      });
  }
  prepare(input: InboxInput, owner: string, intentId?: string): InboxBatch | undefined {
    return this.transaction(() => {
      if (!this.currentOwner(input.workspaceId, owner)) return undefined;
      const current = this.state(input);
      if (current.paused) return undefined;
      const existing = this.db
        .prepare(
          "SELECT * FROM inbox_batches WHERE workspace_id=? AND session_id=? AND input_id=? AND state<>'superseded'"
        )
        .get(input.workspaceId, input.sessionId, input.inputId);
      if (existing) {
        const batch = this.decodeBatch(existing);
        return batch.state === 'prepared' ? batch : undefined;
      }
      const intent = intentId
        ? (this.db
            .prepare("SELECT watermark FROM inbox_intents WHERE intent_id=? AND state='pending'")
            .get(intentId) as { watermark: number } | undefined)
        : undefined;
      if (
        input.kind !== 'automatic' &&
        !this.db
          .prepare(
            'SELECT 1 FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND input_id=? AND user_id=? AND canceled=0 AND finished=0'
          )
          .get(input.workspaceId, input.sessionId, input.inputId, input.userId)
      )
        return undefined;
      if (
        input.kind === 'automatic' &&
        (!intent ||
          current.active_execution ||
          this.db
            .prepare(
              'SELECT 1 FROM inbox_inputs WHERE workspace_id=? AND session_id=? AND canceled=0 AND finished=0'
            )
            .get(input.workspaceId, input.sessionId))
      )
        return undefined;
      // Wake eligibility triggers admission; membership includes the whole available queue.
      // Freeze the watermark only when the batch is claimed, never at intent creation.
      const watermark = this.watermark(input);
      const members =
        input.kind === 'automatic' && !this.available(input, watermark, true).length
          ? []
          : this.available(input, watermark, false);
      if (!members.length) {
        if (intentId)
          this.db
            .prepare(
              "UPDATE inbox_intents SET state='settled_empty' WHERE intent_id=? AND state='pending'"
            )
            .run(intentId);
        return undefined;
      }
      const chainDepth = batchDepth(
        input,
        members.map((m) => m.chainDepth)
      );
      if (input.kind === 'automatic' && chainDepth >= 16) {
        this.db
          .prepare("UPDATE inbox_intents SET state='depth_limited' WHERE intent_id=?")
          .run(intentId);
        return undefined;
      }
      const batchId = randomUUID();
      this.db
        .prepare(
          'INSERT INTO inbox_batches(batch_id,workspace_id,session_id,user_id,input_id,kind,config_json,revision,owner,watermark,member_count,chain_depth) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          batchId,
          input.workspaceId,
          input.sessionId,
          input.userId,
          input.inputId,
          input.kind,
          JSON.stringify(input.config),
          current.revision,
          owner,
          watermark,
          members.length,
          chainDepth
        );
      for (const member of members) {
        this.db.prepare('INSERT INTO inbox_members VALUES(?,?)').run(batchId, member.sequence);
        if (
          this.db
            .prepare(
              'UPDATE inbox_results SET claim=? WHERE sequence=? AND claim IS NULL AND consumed=0'
            )
            .run(batchId, member.sequence).changes !== 1
        )
          throw new Error('Inbox claim lost');
      }
      if (intentId)
        this.db
          .prepare(
            "UPDATE inbox_intents SET state='prepared',batch_id=?,watermark=? WHERE intent_id=?"
          )
          .run(batchId, watermark, intentId);
      return this.getBatch(batchId, input);
    });
  }
  fence(batch: InboxBatch, executionId: string): boolean {
    return this.transaction(() => {
      const current = this.state(batch);
      const count = (
        this.db
          .prepare('SELECT COUNT(*) AS value FROM inbox_results WHERE claim=? AND consumed=0')
          .get(batch.batchId) as { value: number }
      ).value;
      if (
        !canFenceBatch(
          current,
          batch,
          executionId,
          this.currentOwner(batch.workspaceId, batch.owner),
          this.inputCanceled(batch.workspaceId, batch.sessionId, batch.inputId),
          count
        )
      )
        return false;
      return (
        this.db
          .prepare(
            "UPDATE inbox_batches SET state='submitting' WHERE batch_id=? AND state='prepared' AND owner=? AND revision=? AND member_count=?"
          )
          .run(batch.batchId, batch.owner, batch.revision, count).changes === 1
      );
    });
  }
  settle(batch: InboxBatch, outcome: 'submitted' | 'unknown' | 'settled', cause?: string): void {
    this.transaction(() => {
      const before = this.getBatch(batch.batchId, batch);
      if (!before || before.state === 'superseded' || before.state === 'prepared') return;
      if (before.state === 'unknown' || before.state === 'settled') return;
      this.db
        .prepare('UPDATE inbox_batches SET state=?,cause=COALESCE(?,cause) WHERE batch_id=?')
        .run(outcome, cause ?? null, batch.batchId);
      this.db
        .prepare(
          'UPDATE inbox_results SET consumed=1,consumed_at=COALESCE(consumed_at,?) WHERE claim=?'
        )
        .run(this.now(), batch.batchId);
      this.db
        .prepare("UPDATE inbox_intents SET state='settled' WHERE batch_id=? AND state='prepared'")
        .run(batch.batchId);
    });
  }
  getBatch(id: string, scope: InboxScope): InboxBatch | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM inbox_batches WHERE batch_id=? AND workspace_id=? AND session_id=? AND user_id=?'
      )
      .get(id, scope.workspaceId, scope.sessionId, scope.userId);
    return row ? this.decodeBatch(row) : undefined;
  }
  historyReceipts(workspaceId: string): InboxBatch[] {
    return this.db
      .prepare(
        "SELECT * FROM inbox_batches WHERE workspace_id=? AND state IN ('submitted','unknown','settled','superseded')"
      )
      .all(workspaceId)
      .map((row) => this.decodeBatch(row));
  }
  members(batch: InboxBatch, after = 0, limit = 50): InboxMember[] {
    return this.db
      .prepare(
        'SELECT r.sequence,r.operation_id,r.operation_kind,r.source_turn_id,r.created_at,r.completed_at,r.chain_depth,r.completion_json FROM inbox_results r JOIN inbox_members m USING(sequence) WHERE m.batch_id=? AND r.sequence>? ORDER BY r.sequence LIMIT ?'
      )
      .all(batch.batchId, after, limit)
      .map((row) => this.decodeMember(row));
  }
  private decodeBatch(row: unknown): InboxBatch {
    const r = BatchRow.parse(row);
    return {
      workspaceId: r.workspace_id,
      sessionId: r.session_id,
      userId: r.user_id,
      inputId: r.input_id,
      kind: r.kind,
      config: JSON.parse(r.config_json),
      batchId: r.batch_id,
      revision: r.revision,
      owner: r.owner,
      watermark: r.watermark,
      memberCount: r.member_count,
      chainDepth: r.chain_depth,
      state: r.state,
    };
  }
}
