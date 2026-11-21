import type { SessionAutomationObservation } from '@/session/automation-observations';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  automationResultSchema,
  automationRegistrationSchema,
  automationRunSchema,
  type AutomationRegistration,
  type AutomationRun,
  type AutomationRunExit,
  type AutomationWait,
  type AutomationResult,
  type AutomationEvidence,
} from '@lody/shared/automations';
import { isDeepStrictEqual } from 'node:util';
import type {
  AutomationEvent,
  AutomationReceipt,
  AutomationRule,
  AutomationRuleDraft,
  AutomationContinuation,
  AutomationState,
  CapacityObservation,
  PendingWork,
} from '@lody/shared/automations';
import {
  automationEventSchema,
  automationRuleDraftSchema,
  automationContinuationSchema,
  automationInvocationSchema,
} from '@lody/shared/automations';
import {
  OrchestrationConnection,
  type DatabaseLocation,
} from '../../orchestration/platform/database';
import { evaluateCapacity } from '../runtime/capacity';

export const automationIdentity = (...parts: Array<string | number>): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const terminal = new Set<AutomationState>(['settled', 'failed', 'cancelled', 'superseded']);
const nonterminal = `'accepted','waiting','resolved','submitting','queued','running','blocked','unknown','cancelling'`;
type JsonRow = { payload: string };

/** The payload is the frozen acceptance record; every queried field lives in a real column. */
const eventColumns = (event: AutomationEvent) => ({
  type: event.type,
  source: event.source,
  subject: event.subject,
  session_id: event.scope.sessionId ?? null,
  project_id: event.scope.projectId ?? null,
  work_id: typeof event.data.workId === 'string' ? event.data.workId : null,
  observed_at: event.observedAt,
});
const receiptColumns = (receipt: AutomationReceipt) => ({
  session_id: receipt.sessionId,
  scope_session_id: receipt.rule.scope.sessionId ?? receipt.sessionId,
  owner_user_id: receipt.rule.ownerUserId,
  rule_id: receipt.rule.id,
  action_kind: receipt.intent.action.kind,
  event_type: receipt.event.type,
  event_source: receipt.event.source,
  event_id: receipt.event.id,
  correlation_key: receipt.event.correlationId ?? receipt.deliveryId,
  policy: receipt.rule.handler.kind === 'policy' ? receipt.rule.handler.policy : null,
  work_id: typeof receipt.event.data.workId === 'string' ? receipt.event.data.workId : null,
  retry_at: receipt.retryAt ?? 0,
});
const waitColumns = (wait: AutomationWait) => ({
  session_id: wait.sessionId,
  owner_user_id: wait.ownerUserId,
  invocation_id: wait.invocationId ?? null,
  created_at: wait.createdAt,
  due_at: Math.min(wait.nextCheckAt, wait.expiresAt ?? Number.MAX_SAFE_INTEGER),
  run_pending: wait.run && wait.run.startedAt !== undefined && !wait.run.exit ? 1 : 0,
});
const workColumns = (work: PendingWork) => ({
  session_id: work.sessionId,
  owner_user_id: work.ownerUserId,
  state: work.state,
  turn_id: work.turnId,
  invocation_id: work.invocationId ?? null,
  updated_at: work.updatedAt,
  binding_id: work.bindingId,
  fingerprint: work.fingerprint,
  model_id: work.modelId ?? null,
});
const deliveryColumns = (delivery: Delivery) => ({
  rule_id: delivery.rule.id,
  owner_user_id: delivery.rule.ownerUserId,
  scope_session_id: delivery.rule.scope.sessionId ?? null,
  event_source: delivery.event.source,
  event_id: delivery.event.id,
  event_work_id: typeof delivery.event.data.workId === 'string' ? delivery.event.data.workId : null,
  updated_at: delivery.updatedAt,
});
export type Delivery = {
  id: string;
  rule: AutomationRule;
  event: AutomationEvent;
  state: 'accepted' | 'settled' | 'failed';
  reason?: string;
  updatedAt: number;
};
export type SourceCheckpoint = {
  revision: string;
  observedAt: number;
  data: Record<string, unknown>;
};

/** One machine owner; facts, source checkpoints and frozen deliveries commit together. */
export class AutomationLedger {
  private readonly connection: OrchestrationConnection;
  constructor(
    readonly location: DatabaseLocation,
    readonly workspaceId: string,
    readonly machineId: string
  ) {
    this.connection = new OrchestrationConnection(location);
    try {
      const db = this.connection.raw;
      const version = Number(db.pragma('user_version', { simple: true }));
      if (version > 4) throw new Error('AUTOMATION_DATABASE_VERSION_UNSUPPORTED');
      db.exec(`
        CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries (
          id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS delivery_state ON deliveries(state);
        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, state TEXT NOT NULL,
          updated_at INTEGER NOT NULL, payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS receipt_state ON receipts(state, updated_at);
        CREATE INDEX IF NOT EXISTS receipt_delivery ON receipts(delivery_id);
        CREATE TABLE IF NOT EXISTS capacity (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS work (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS waits (id TEXT PRIMARY KEY, state TEXT NOT NULL, next_check_at INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turn_observations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wait_reads (
          wait_id TEXT NOT NULL, resource TEXT NOT NULL,
          PRIMARY KEY (wait_id, resource)
        );
      `);
      if (version < 2)
        this.connection.withImmediate(() => {
          db.exec('ALTER TABLE turn_observations ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0');
          db.pragma('user_version = 2');
        });
      if (version < 4) this.migrateQueryColumns();
      db.exec(`
        CREATE INDEX IF NOT EXISTS turn_observations_due ON turn_observations(retry_at);
        CREATE INDEX IF NOT EXISTS events_session ON events(session_id, observed_at);
        CREATE INDEX IF NOT EXISTS events_work ON events(work_id);
        DROP INDEX IF EXISTS receipts_due;
        CREATE INDEX IF NOT EXISTS receipts_due_active ON receipts(retry_at)
        WHERE state IN (${nonterminal});
        CREATE INDEX IF NOT EXISTS receipts_updated ON receipts(updated_at);
        DROP INDEX IF EXISTS receipts_delivery;
        DROP INDEX IF EXISTS deliveries_state;
        CREATE INDEX IF NOT EXISTS receipts_rule ON receipts(rule_id);
        CREATE INDEX IF NOT EXISTS receipts_invocation ON receipts(rule_id, action_kind, correlation_key);
        CREATE INDEX IF NOT EXISTS receipts_session ON receipts(session_id);
        CREATE INDEX IF NOT EXISTS receipts_event ON receipts(event_source, event_id);
        CREATE INDEX IF NOT EXISTS receipts_capacity ON receipts(event_type, policy, state);
        CREATE INDEX IF NOT EXISTS receipts_owner ON receipts(owner_user_id);
        CREATE INDEX IF NOT EXISTS waits_due_at ON waits(state, due_at);
        CREATE INDEX IF NOT EXISTS waits_owner ON waits(owner_user_id, session_id);
        CREATE INDEX IF NOT EXISTS waits_session ON waits(session_id);
        CREATE INDEX IF NOT EXISTS waits_run ON waits(state, run_pending);
        CREATE INDEX IF NOT EXISTS wait_reads_resource ON wait_reads(resource, wait_id);
        CREATE INDEX IF NOT EXISTS work_session ON work(session_id, state);
        CREATE INDEX IF NOT EXISTS work_owner ON work(owner_user_id);
        CREATE INDEX IF NOT EXISTS work_binding ON work(binding_id);
        CREATE INDEX IF NOT EXISTS receipts_work ON receipts(work_id);
        CREATE INDEX IF NOT EXISTS deliveries_event ON deliveries(event_source, event_id);
        CREATE INDEX IF NOT EXISTS deliveries_work ON deliveries(event_work_id, rule_id);
        CREATE INDEX IF NOT EXISTS deliveries_owner ON deliveries(owner_user_id);
        CREATE INDEX IF NOT EXISTS turn_observations_owner ON turn_observations(user_id, observed_at);
      `);
    } catch (cause) {
      this.close();
      throw cause;
    }
  }
  /** v3 lifts every predicate out of the payload into real columns, backfilled by the writer projections. */
  private migrateQueryColumns(): void {
    const db = this.connection.raw;
    this.connection.withImmediate(() => {
      const addColumns = (table: string, columns: Record<string, string>) => {
        const existing = new Set(
          (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
        );
        for (const [name, declaration] of Object.entries(columns))
          if (!existing.has(name))
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
      };
      addColumns('events', {
        type: 'TEXT',
        source: 'TEXT',
        subject: 'TEXT',
        session_id: 'TEXT',
        project_id: 'TEXT',
        work_id: 'TEXT',
        observed_at: 'INTEGER',
      });
      addColumns('receipts', {
        session_id: 'TEXT',
        scope_session_id: 'TEXT',
        owner_user_id: 'TEXT',
        rule_id: 'TEXT',
        action_kind: 'TEXT',
        event_type: 'TEXT',
        event_source: 'TEXT',
        event_id: 'TEXT',
        correlation_key: 'TEXT',
        policy: 'TEXT',
        work_id: 'TEXT',
        retry_at: 'INTEGER NOT NULL DEFAULT 0',
      });
      addColumns('waits', {
        session_id: 'TEXT',
        owner_user_id: 'TEXT',
        invocation_id: 'TEXT',
        created_at: 'INTEGER',
        due_at: 'INTEGER',
        run_pending: 'INTEGER NOT NULL DEFAULT 0',
      });
      addColumns('work', {
        session_id: 'TEXT',
        owner_user_id: 'TEXT',
        state: 'TEXT',
        turn_id: 'TEXT',
        invocation_id: 'TEXT',
        updated_at: 'INTEGER',
        binding_id: 'TEXT',
        fingerprint: 'TEXT',
        model_id: 'TEXT',
      });
      addColumns('deliveries', {
        rule_id: 'TEXT',
        owner_user_id: 'TEXT',
        scope_session_id: 'TEXT',
        event_source: 'TEXT',
        event_id: 'TEXT',
        event_work_id: 'TEXT',
        updated_at: 'INTEGER',
      });
      addColumns('turn_observations', {
        user_id: 'TEXT',
        session_id: 'TEXT',
        observed_at: 'INTEGER',
      });
      db.exec('DROP INDEX IF EXISTS waits_due');
      // Rowid-keyed batches bound upgrade memory; a write cursor cannot share a reading cursor.
      const backfill = (
        select: string,
        apply: (row: JsonRow & { rowid: number; id: string }) => void
      ) => {
        const stmt = db.prepare(`${select} WHERE rowid>? ORDER BY rowid LIMIT 512`);
        let after = 0;
        for (;;) {
          const rows = stmt.all(after) as Array<JsonRow & { rowid: number; id: string }>;
          for (const row of rows) {
            apply(row);
            after = row.rowid;
          }
          if (rows.length < 512) return;
        }
      };
      const events = db.prepare(
        `UPDATE events SET type=?,source=?,subject=?,session_id=?,project_id=?,work_id=?,observed_at=?
        WHERE sequence=?`
      );
      backfill('SELECT rowid AS rowid,payload FROM events', (row) => {
        const c = eventColumns(JSON.parse(row.payload) as AutomationEvent);
        events.run(
          c.type,
          c.source,
          c.subject,
          c.session_id,
          c.project_id,
          c.work_id,
          c.observed_at,
          row.rowid
        );
      });
      const receipts = db.prepare(
        `UPDATE receipts SET session_id=?,scope_session_id=?,owner_user_id=?,rule_id=?,action_kind=?,
        event_type=?,event_source=?,event_id=?,correlation_key=?,policy=?,work_id=?,retry_at=? WHERE id=?`
      );
      backfill('SELECT rowid,id,payload FROM receipts', (row) => {
        const c = receiptColumns(JSON.parse(row.payload) as AutomationReceipt);
        receipts.run(
          c.session_id,
          c.scope_session_id,
          c.owner_user_id,
          c.rule_id,
          c.action_kind,
          c.event_type,
          c.event_source,
          c.event_id,
          c.correlation_key,
          c.policy,
          c.work_id,
          c.retry_at,
          row.id
        );
      });
      const waits = db.prepare(
        `UPDATE waits SET session_id=?,owner_user_id=?,invocation_id=?,created_at=?,due_at=?,run_pending=?
        WHERE id=?`
      );
      const insertRead = db.prepare('INSERT OR IGNORE INTO wait_reads VALUES (?,?)');
      backfill('SELECT rowid,id,payload FROM waits', (row) => {
        const wait = JSON.parse(row.payload) as AutomationWait;
        const c = waitColumns(wait);
        waits.run(
          c.session_id,
          c.owner_user_id,
          c.invocation_id,
          c.created_at,
          c.due_at,
          c.run_pending,
          row.id
        );
        for (const resource of wait.reads ?? []) insertRead.run(row.id, resource);
      });
      const work = db.prepare(
        `UPDATE work SET session_id=?,owner_user_id=?,state=?,turn_id=?,invocation_id=?,updated_at=?,
        binding_id=?,fingerprint=?,model_id=? WHERE id=?`
      );
      backfill('SELECT rowid,id,payload FROM work', (row) => {
        const c = workColumns(JSON.parse(row.payload) as PendingWork);
        work.run(
          c.session_id,
          c.owner_user_id,
          c.state,
          c.turn_id,
          c.invocation_id,
          c.updated_at,
          c.binding_id,
          c.fingerprint,
          c.model_id,
          row.id
        );
      });
      const deliveries = db.prepare(
        `UPDATE deliveries SET rule_id=?,owner_user_id=?,scope_session_id=?,event_source=?,event_id=?,
        event_work_id=?,updated_at=? WHERE id=?`
      );
      backfill('SELECT rowid,id,payload FROM deliveries', (row) => {
        const c = deliveryColumns(JSON.parse(row.payload) as Delivery);
        deliveries.run(
          c.rule_id,
          c.owner_user_id,
          c.scope_session_id,
          c.event_source,
          c.event_id,
          c.event_work_id,
          c.updated_at,
          row.id
        );
      });
      const turns = db.prepare(
        'UPDATE turn_observations SET user_id=?,session_id=?,observed_at=? WHERE id=?'
      );
      backfill('SELECT rowid,id,payload FROM turn_observations', (row) => {
        const fact = JSON.parse(row.payload) as SessionAutomationObservation;
        turns.run(fact.userId, fact.sessionId, fact.observedAt, row.id);
      });
      db.pragma('user_version = 4');
    });
  }
  registerWait(
    input: AutomationRegistration,
    sessionId: string,
    userId: string,
    now: number
  ): AutomationWait {
    const registration = automationRegistrationSchema.parse(input);
    return this.connection.withImmediate(() => {
      const existing = this.waits(userId, sessionId).find(
        (wait) =>
          ['waiting', 'checking', 'matched'].includes(wait.state) &&
          (!wait.invocationId ||
            !terminal.has(this.receipt(wait.invocationId)?.state ?? 'accepted')) &&
          wait.program === registration.program &&
          wait.intervalMs === registration.intervalMs &&
          wait.expiresAt === registration.expiresAt &&
          wait.reason === registration.reason
      );
      if (existing) return existing;
      const wait: AutomationWait = {
        ...registration,
        id: randomUUID(),
        sessionId,
        workspaceId: this.workspaceId,
        ownerUserId: userId,
        ownerMachineId: this.machineId,
        state: 'waiting',
        createdAt: now,
        updatedAt: now,
        nextCheckAt: now,
        checks: 0,
        consecutiveErrors: 0,
      };
      this.writeWait(wait);
      return wait;
    });
  }
  /** Matching unfinished runs deduplicate, so a repeated request never starts a second process. */
  registerRun(
    input: AutomationRun,
    sessionId: string,
    userId: string,
    logDirectory: string,
    now: number
  ): AutomationWait {
    const { reason, ...run } = automationRunSchema.parse(input);
    return this.connection.withImmediate(() => {
      const existing = this.waits(userId, sessionId).find(
        (wait) =>
          ['waiting', 'checking'].includes(wait.state) &&
          wait.run &&
          !wait.run.exit &&
          isDeepStrictEqual(
            {
              command: wait.run.command,
              args: wait.run.args,
              cwd: wait.run.cwd,
              env: wait.run.env,
            },
            { command: run.command, args: run.args, cwd: run.cwd, env: run.env }
          )
      );
      if (existing) return existing;
      const id = randomUUID();
      const wait: AutomationWait = {
        id,
        sessionId,
        workspaceId: this.workspaceId,
        ownerUserId: userId,
        ownerMachineId: this.machineId,
        reason: reason ?? [run.command, ...run.args].join(' ').slice(0, 2000),
        // Exit wakes the check at once; the interval only bounds a missed wake.
        intervalMs: 60_000,
        run: { ...run, logPath: path.join(logDirectory, `${id}.log`) },
        state: 'waiting',
        createdAt: now,
        updatedAt: now,
        nextCheckAt: now,
        checks: 0,
        consecutiveErrors: 0,
      };
      this.writeWait(wait);
      return wait;
    });
  }
  /** Claims the only start of a run. A claimed run without a live owner reports interruption. */
  claimRunStart(id: string, now: number): AutomationWait | undefined {
    return this.connection.withImmediate(() => {
      const prior = this.wait(id);
      if (prior?.state !== 'checking' || !prior.run || prior.run.startedAt !== undefined)
        return undefined;
      const next = { ...prior, run: { ...prior.run, startedAt: now }, updatedAt: now };
      this.writeWait(next);
      return next;
    });
  }
  /** A new owner holds no runs: started, unfinished runs are due for an interruption report. */
  orphanStartedRuns(now: number): void {
    this.connection.withImmediate(() => {
      const rows = this.connection.raw
        .prepare(
          `SELECT payload FROM waits WHERE state IN ('waiting','checking') AND run_pending=1`
        )
        .all() as JsonRow[];
      for (const row of rows) {
        const wait = JSON.parse(row.payload) as AutomationWait;
        this.writeWait({ ...wait, state: 'waiting', nextCheckAt: now, updatedAt: now });
      }
    });
  }
  recordRunPid(id: string, pid: number, now: number): void {
    this.connection.withImmediate(() => {
      const prior = this.wait(id);
      if (!prior?.run || prior.run.exit) return;
      this.writeWait({ ...prior, run: { ...prior.run, pid }, updatedAt: now });
    });
  }
  /** First observed exit wins and makes the wait due; terminal waits ignore late exits. */
  recordRunExit(id: string, exit: AutomationRunExit, now: number): AutomationWait | undefined {
    return this.connection.withImmediate(() => {
      const prior = this.wait(id);
      if (!prior?.run || prior.run.exit || !['waiting', 'checking'].includes(prior.state))
        return undefined;
      const next = {
        ...prior,
        run: { ...prior.run, exit },
        nextCheckAt: Math.min(prior.nextCheckAt, now),
        updatedAt: now,
      };
      this.writeWait(next);
      return next;
    });
  }
  private writeWait(wait: AutomationWait): void {
    const c = waitColumns(wait);
    this.connection.raw
      .prepare(`INSERT INTO waits
      (id,state,next_check_at,session_id,owner_user_id,invocation_id,created_at,due_at,run_pending,payload)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,next_check_at=excluded.next_check_at,
      session_id=excluded.session_id,owner_user_id=excluded.owner_user_id,
      invocation_id=excluded.invocation_id,created_at=excluded.created_at,due_at=excluded.due_at,
      run_pending=excluded.run_pending,payload=excluded.payload`)
      .run(
        wait.id,
        wait.state,
        wait.nextCheckAt,
        c.session_id,
        c.owner_user_id,
        c.invocation_id,
        c.created_at,
        c.due_at,
        c.run_pending,
        JSON.stringify(wait)
      );
    this.connection.raw.prepare('DELETE FROM wait_reads WHERE wait_id=?').run(wait.id);
    const insert = this.connection.raw.prepare('INSERT OR IGNORE INTO wait_reads VALUES (?,?)');
    for (const resource of wait.reads ?? []) insert.run(wait.id, resource);
  }
  wait(id: string): AutomationWait | undefined {
    return this.read('waits', id);
  }
  waits(userId: string | undefined, sessionId?: string): AutomationWait[] {
    const filters = [
      ...(userId === undefined ? [] : ['owner_user_id=?']),
      ...(sessionId === undefined ? [] : ['session_id=?']),
    ];
    const args = [userId, sessionId].filter((value): value is string => value !== undefined);
    return (
      this.connection.raw
        .prepare(
          `SELECT payload FROM waits ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC,id`
        )
        .all(...args) as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as AutomationWait);
  }
  dueWaits(now: number, limit = 4): AutomationWait[] {
    return (
      this.connection.raw
        .prepare(`SELECT payload FROM waits WHERE state IN ('waiting','checking')
      AND due_at<=? ORDER BY due_at,id LIMIT ?`)
        .all(now, limit) as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as AutomationWait);
  }
  /** Earliest durable deadline; an accepted delivery is always due at once. */
  nextDueAt(now: number): number | undefined {
    let next: number | undefined;
    const track = (sql: string) => {
      const { due } = this.connection.raw.prepare(sql).get() as { due: number | null };
      if (due !== null && (next === undefined || due < next)) next = due;
    };
    track(`SELECT MIN(due_at) AS due FROM waits WHERE state IN ('waiting','checking')`);
    track(`SELECT MIN(retry_at) AS due FROM receipts WHERE state IN (${nonterminal})`);
    track('SELECT MIN(retry_at) AS due FROM turn_observations');
    if (
      this.connection.raw.prepare(`SELECT 1 FROM deliveries WHERE state='accepted' LIMIT 1`).get()
    )
      return now;
    return next;
  }
  updateWait(
    id: string,
    expected: AutomationWait['state'],
    patch: Partial<AutomationWait>,
    now: number
  ): AutomationWait | undefined {
    return this.connection.withImmediate(() => {
      const prior = this.wait(id);
      if (!prior || prior.state !== expected) return undefined;
      const next = { ...prior, ...patch, id: prior.id, updatedAt: now };
      this.writeWait(next);
      return next;
    });
  }
  recordRead(id: string, resource: string, evidence: AutomationEvidence[], now: number): void {
    this.connection.withImmediate(() => {
      const wait = this.wait(id);
      if (!wait || wait.state !== 'checking') throw new Error('AUTOMATION_WAIT_INACTIVE');
      this.updateWait(
        id,
        'checking',
        {
          reads: [...new Set([...(wait.reads ?? []), resource])],
          evidence: [...(wait.evidence ?? []), ...evidence].filter(
            (item, index, all) =>
              all.findIndex(
                (other) =>
                  other.sourceId === item.sourceId &&
                  other.revision === item.revision &&
                  other.prUrl === item.prUrl
              ) === index
          ),
        },
        now
      );
    });
  }
  private wantsReadSql = `SELECT 1 FROM waits JOIN wait_reads ON wait_reads.wait_id=waits.id
    WHERE wait_reads.resource=? AND (waits.state IN ('waiting','checking') OR (waits.state='matched'
      AND EXISTS (SELECT 1 FROM receipts WHERE receipts.id=waits.invocation_id
      AND receipts.state IN (${nonterminal}))))`;
  wantsRead(resource: string, sessionId?: string): boolean {
    return sessionId === undefined
      ? !!this.connection.raw.prepare(`${this.wantsReadSql} LIMIT 1`).get(resource)
      : !!this.connection.raw
          .prepare(`${this.wantsReadSql} AND waits.session_id=? LIMIT 1`)
          .get(resource, sessionId);
  }
  wantsReadSessions(resource: string): Set<string> {
    return new Set(
      (
        this.connection.raw
          .prepare(`SELECT DISTINCT waits.session_id FROM waits
        JOIN wait_reads ON wait_reads.wait_id=waits.id
        WHERE wait_reads.resource=? AND waits.session_id IS NOT NULL
        AND (waits.state IN ('waiting','checking') OR (waits.state='matched'
          AND EXISTS (SELECT 1 FROM receipts WHERE receipts.id=waits.invocation_id
          AND receipts.state IN (${nonterminal}))))`)
          .all(resource) as Array<{ session_id: string }>
      ).map((row) => row.session_id)
    );
  }
  invalidateReads(resource: string, sessionId: string, now: number): void {
    const waits = this.connection.raw
      .prepare(`SELECT waits.id,waits.payload FROM waits
      JOIN wait_reads ON wait_reads.wait_id=waits.id
      WHERE waits.state='waiting' AND wait_reads.resource=? AND waits.session_id=?`)
      .all(resource, sessionId) as Array<JsonRow & { id: string }>;
    for (const row of waits) {
      const wait = JSON.parse(row.payload) as AutomationWait;
      this.updateWait(wait.id, 'waiting', { nextCheckAt: Math.min(wait.nextCheckAt, now) }, now);
    }
  }
  sessionEvents(sessionId: string, since: number, limit: number): AutomationEvent[] {
    return (
      this.connection.raw
        .prepare(`SELECT payload FROM events
      WHERE session_id=? AND observed_at>=? ORDER BY sequence DESC LIMIT ?`)
        .all(sessionId, since, limit) as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as AutomationEvent);
  }
  finishWait(
    wait: AutomationWait,
    result: AutomationResult,
    now: number
  ): AutomationWait | undefined {
    result = automationResultSchema.parse(result);
    return this.connection.withImmediate(() => {
      const current = this.wait(wait.id);
      if (!current || current.state !== 'checking') return undefined;
      if (current.expiresAt !== undefined && current.expiresAt <= now)
        return this.updateWait(wait.id, 'checking', { state: 'expired' }, now);
      if (result === false)
        return this.updateWait(
          wait.id,
          'checking',
          {
            state: 'waiting',
            nextCheckAt: current.run?.exit ? now : now + wait.intervalMs,
            consecutiveErrors: 0,
            lastError: undefined,
          },
          now
        );
      const invocation = {
        target: {
          kind: 'existing' as const,
          sessionId: wait.sessionId,
          onUnavailable: 'blocked' as const,
        },
        input: { kind: 'external_event' as const, ref: wait.id },
        ifBusy: 'enqueue' as const,
      };
      const rule = this.upsert(
        {
          id: wait.id,
          name: wait.reason?.slice(0, 200) || 'Session condition',
          scope: { workspaceId: this.workspaceId, sessionId: wait.sessionId },
          selector: {
            types: ['automation.condition.completed'],
            sources: [`automation/${wait.id}`],
          },
          enabled: true,
          handler: { kind: 'agent', invocation },
          grants: {
            actions: ['agent.invoke'],
            sessionIds: [wait.sessionId],
            agentRoleIds: [],
            bindingIds: [],
            allowLinkedSession: false,
            allowCapacityAttempt: false,
          },
          budget: {
            maxActionsPerEvent: 1,
            maxInvocationsPerCorrelation: 1,
            maxPendingActions: 1,
            maxDepth: 1,
          },
        },
        wait.ownerUserId,
        now
      );
      const event: AutomationEvent = {
        id: wait.id,
        source: `automation/${wait.id}`,
        type: 'automation.condition.completed',
        version: 1,
        subject: wait.id,
        observedAt: now,
        scope: rule.scope,
        data: result,
        provenance: 'callback',
        completeness: 'observed',
        depth: 0,
      };
      const eventKey = this.publish(event);
      const delivery = this.delivery(automationIdentity(eventKey, rule.id, rule.revision));
      if (!delivery) throw new Error('AUTOMATION_COMPLETION_DELIVERY_MISSING');
      const receipt = this.accept(
        delivery,
        {
          key: 'resume',
          condition: { kind: 'automation.wait.ready', parameters: { waitId: wait.id } },
          action: { kind: 'agent.invoke', parameters: invocation },
        },
        now,
        current.evidence
      );
      this.finishDelivery(delivery, undefined, now);
      return this.updateWait(
        wait.id,
        'checking',
        {
          state: 'matched',
          result,
          invocationId: receipt.id,
          consecutiveErrors: 0,
          lastError: undefined,
        },
        now
      );
    });
  }
  cancelWait(id: string, now: number): AutomationWait | undefined {
    return this.connection.withImmediate(() => {
      const prior = this.wait(id);
      if (!prior || ['cancelled', 'expired', 'failed'].includes(prior.state)) return prior;
      const rule = this.rule(id);
      if (rule) {
        const {
          revision,
          ownerUserId,
          ownerMachineId: _machine,
          activationSequence: _sequence,
          createdAt: _created,
          updatedAt: _updated,
          ...draft
        } = rule;
        this.upsert({ ...draft, enabled: false }, ownerUserId, now, revision);
      }
      return this.updateWait(id, prior.state, { state: 'cancelled' }, now);
    });
  }
  stageTurn(fact: SessionAutomationObservation): void {
    const id = automationIdentity(fact.sessionId, fact.assistantTurnId);
    this.connection.withImmediate(() => {
      const prior = this.connection.raw
        .prepare('SELECT payload FROM turn_observations WHERE id=?')
        .get(id) as JsonRow | undefined;
      if (
        prior &&
        (JSON.parse(prior.payload) as SessionAutomationObservation).released &&
        !fact.released
      )
        return;
      this.connection.raw
        .prepare(
          `INSERT INTO turn_observations (id,payload,user_id,session_id,observed_at) VALUES (?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,retry_at=0,
          user_id=excluded.user_id,session_id=excluded.session_id,observed_at=excluded.observed_at`
        )
        .run(id, JSON.stringify(fact), fact.userId, fact.sessionId, fact.observedAt);
    });
  }
  stagedTurns(now = Date.now()): Array<{ id: string; fact: SessionAutomationObservation }> {
    return (
      this.connection.raw
        .prepare(
          'SELECT id,payload FROM turn_observations WHERE retry_at<=? ORDER BY retry_at,rowid LIMIT 100'
        )
        .all(now) as Array<JsonRow & { id: string }>
    ).map(({ id, payload }) => ({ id, fact: JSON.parse(payload) as SessionAutomationObservation }));
  }
  deferTurn(id: string, retryAt: number): void {
    this.connection.raw
      .prepare('UPDATE turn_observations SET retry_at=? WHERE id=?')
      .run(retryAt, id);
  }
  acknowledgeTurn(id: string): void {
    this.connection.raw.prepare('DELETE FROM turn_observations WHERE id=?').run(id);
  }
  close(): void {
    this.connection.close();
  }
  private read<A>(
    table: 'rules' | 'sources' | 'deliveries' | 'receipts' | 'capacity' | 'work' | 'waits',
    id: string
  ): A | undefined {
    const row = this.connection.raw.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id) as
      | JsonRow
      | undefined;
    return row ? (JSON.parse(row.payload) as A) : undefined;
  }
  rule(id: string): AutomationRule | undefined {
    return this.read('rules', id);
  }
  rules(): AutomationRule[] {
    return (
      this.connection.raw.prepare('SELECT payload FROM rules ORDER BY id').all() as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as AutomationRule);
  }
  upsert(
    draft: AutomationRuleDraft,
    userId: string,
    now: number,
    expectedRevision?: number
  ): AutomationRule {
    const parsed = automationRuleDraftSchema.parse(draft);
    if (parsed.scope.workspaceId !== this.workspaceId)
      throw new Error('AUTOMATION_WORKSPACE_MISMATCH');
    return this.connection.withImmediate(() => {
      const old = this.rule(parsed.id);
      if (old && (old.ownerUserId !== userId || old.ownerMachineId !== this.machineId))
        throw new Error('AUTOMATION_OWNER_MISMATCH');
      if ((old?.revision ?? 0) !== (expectedRevision ?? 0))
        throw new Error('AUTOMATION_REVISION_CONFLICT');
      const { sequence } = this.connection.raw
        .prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events')
        .get() as { sequence: number };
      const rule: AutomationRule = {
        ...parsed,
        revision: (old?.revision ?? 0) + 1,
        ownerUserId: userId,
        ownerMachineId: this.machineId,
        activationSequence: sequence,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
      };
      this.connection.raw
        .prepare(
          'INSERT INTO rules VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
        )
        .run(rule.id, JSON.stringify(rule));
      return rule;
    });
  }
  checkpoint(source: string): SourceCheckpoint | undefined {
    return this.read('sources', source);
  }
  observe(source: string, checkpoint: SourceCheckpoint, events: AutomationEvent[]): void {
    this.connection.withImmediate(() => {
      const prior = this.checkpoint(source);
      if (prior && prior.observedAt > checkpoint.observedAt) return;
      // The initial observation is a baseline, not a fabricated historical transition.
      if (prior && prior.revision !== checkpoint.revision)
        for (const event of events) this.publish(event);
      this.connection.raw
        .prepare(
          'INSERT INTO sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
        )
        .run(source, JSON.stringify(checkpoint));
    });
  }
  publish(input: AutomationEvent): string {
    const event = automationEventSchema.parse(input);
    if (event.scope.workspaceId !== this.workspaceId)
      throw new Error('AUTOMATION_WORKSPACE_MISMATCH');
    return this.connection.withImmediate(() => {
      const key = automationIdentity(event.source, event.id);
      const c = eventColumns(event);
      const result = this.connection.raw
        .prepare(
          `INSERT OR IGNORE INTO events
          (event_key,type,source,subject,session_id,project_id,work_id,observed_at,payload)
          VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          key,
          c.type,
          c.source,
          c.subject,
          c.session_id,
          c.project_id,
          c.work_id,
          c.observed_at,
          JSON.stringify(event)
        );
      if (!result.changes) {
        const previous = this.connection.raw
          .prepare('SELECT payload FROM events WHERE event_key=?')
          .get(key) as JsonRow;
        const fact = (value: AutomationEvent) => {
          const {
            observedAt: _observed,
            provenance: _provenance,
            completeness: _completeness,
            ...identity
          } = value;
          return identity;
        };
        if (!isDeepStrictEqual(fact(JSON.parse(previous.payload) as AutomationEvent), fact(event)))
          throw new Error('AUTOMATION_EVENT_IDENTITY_CONFLICT');
        return key;
      }
      for (const rule of this.rules()) {
        if (
          !rule.enabled ||
          !rule.selector.types.includes(event.type) ||
          (rule.selector.sources && !rule.selector.sources.includes(event.source)) ||
          (rule.selector.subject && rule.selector.subject !== event.subject) ||
          (rule.scope.sessionId && rule.scope.sessionId !== event.scope.sessionId) ||
          (rule.scope.projectId && rule.scope.projectId !== event.scope.projectId)
        )
          continue;
        const delivery: Delivery = {
          id: automationIdentity(key, rule.id, rule.revision),
          rule,
          event,
          state: 'accepted',
          updatedAt: event.observedAt,
        };
        const d = deliveryColumns(delivery);
        this.connection.raw
          .prepare(
            `INSERT INTO deliveries
            (id,state,rule_id,owner_user_id,scope_session_id,event_source,event_id,event_work_id,updated_at,payload)
            VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            delivery.id,
            delivery.state,
            d.rule_id,
            d.owner_user_id,
            d.scope_session_id,
            d.event_source,
            d.event_id,
            d.event_work_id,
            d.updated_at,
            JSON.stringify(delivery)
          );
      }
      return key;
    });
  }
  delivery(id: string): Delivery | undefined {
    return this.read('deliveries', id);
  }
  deliveries(limit = 100): Delivery[] {
    return (
      this.connection.raw
        .prepare("SELECT payload FROM deliveries WHERE state='accepted' ORDER BY rowid LIMIT ?")
        .all(limit) as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as Delivery);
  }
  finishDelivery(delivery: Delivery, reason?: string, now = delivery.event.observedAt): void {
    const next: Delivery = {
      ...delivery,
      state: reason ? 'failed' : 'settled',
      reason,
      updatedAt: now,
    };
    this.connection.raw
      .prepare(
        "UPDATE deliveries SET state=?,updated_at=?,payload=? WHERE id=? AND state='accepted'"
      )
      .run(next.state, next.updatedAt, JSON.stringify(next), next.id);
  }
  accept(
    delivery: Delivery,
    input: AutomationContinuation,
    now: number,
    evidence?: AutomationEvidence[]
  ): AutomationReceipt {
    const intent = automationContinuationSchema.parse(input);
    return this.connection.withImmediate(() => {
      const id = automationIdentity(delivery.id, intent.key);
      const previous = this.receipt(id);
      if (previous) {
        if (!isDeepStrictEqual(previous.intent, intent))
          throw new Error('AUTOMATION_IDEMPOTENCY_CONFLICT');
        return previous;
      }
      const rule = this.rule(delivery.rule.id);
      if (!rule?.enabled) throw new Error('AUTOMATION_DISABLED');
      if (!delivery.rule.grants.actions.includes(intent.action.kind))
        throw new Error('AUTOMATION_ACTION_NOT_GRANTED');
      const { count } = this.connection.raw
        .prepare('SELECT COUNT(*) AS count FROM receipts WHERE delivery_id=?')
        .get(delivery.id) as { count: number };
      const { count: pending } = this.connection.raw
        .prepare(`SELECT COUNT(*) AS count FROM receipts
        WHERE rule_id=? AND state IN (${nonterminal})`)
        .get(delivery.rule.id) as { count: number };
      if (pending >= (delivery.rule.budget.maxPendingActions ?? 256))
        throw new Error('AUTOMATION_QUEUE_BUDGET_EXHAUSTED');
      if (
        count >= delivery.rule.budget.maxActionsPerEvent ||
        delivery.event.depth >= delivery.rule.budget.maxDepth
      )
        throw new Error('AUTOMATION_BUDGET_EXHAUSTED');
      if (intent.action.kind === 'agent.invoke') {
        const correlation =
          delivery.event.correlationId ??
          automationIdentity(delivery.event.source, delivery.event.id);
        const { count: invocations } = this.connection.raw
          .prepare(`SELECT COUNT(*) AS count FROM receipts
          WHERE rule_id=? AND action_kind='agent.invoke' AND correlation_key=?`)
          .get(delivery.rule.id, correlation) as { count: number };
        if (invocations >= delivery.rule.budget.maxInvocationsPerCorrelation)
          throw new Error('AUTOMATION_INVOCATION_BUDGET_EXHAUSTED');
        delivery = { ...delivery, event: { ...delivery.event, correlationId: correlation } };
      }
      const invocation =
        intent.action.kind === 'agent.invoke'
          ? automationInvocationSchema.safeParse(intent.action.parameters)
          : undefined;
      const targetSessionId =
        invocation?.success && invocation.data.target.kind === 'existing'
          ? invocation.data.target.sessionId
          : typeof intent.action.parameters.sessionId === 'string'
            ? intent.action.parameters.sessionId
            : undefined;
      const receipt: AutomationReceipt = {
        id,
        deliveryId: delivery.id,
        ...(evidence?.length ? { evidence } : {}),
        rule: delivery.rule,
        event: delivery.event,
        intent,
        state: 'accepted',
        attempts: 0,
        sessionId: targetSessionId ?? automationIdentity(id, 'session'),
        turnId: automationIdentity(id, 'turn'),
        createdAt: now,
        updatedAt: now,
      };
      const c = receiptColumns(receipt);
      this.connection.raw
        .prepare(
          `INSERT INTO receipts
          (id,delivery_id,state,updated_at,session_id,scope_session_id,owner_user_id,rule_id,
          action_kind,event_type,event_source,event_id,correlation_key,policy,work_id,retry_at,payload)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          delivery.id,
          receipt.state,
          now,
          c.session_id,
          c.scope_session_id,
          c.owner_user_id,
          c.rule_id,
          c.action_kind,
          c.event_type,
          c.event_source,
          c.event_id,
          c.correlation_key,
          c.policy,
          c.work_id,
          c.retry_at,
          JSON.stringify(receipt)
        );
      return receipt;
    });
  }
  recordDeadline(receipt: AutomationReceipt, now: number): void {
    const dueAt = receipt.intent.notBefore;
    if (dueAt === undefined || dueAt > now) return;
    this.publish({
      id: automationIdentity(receipt.id, dueAt),
      source: 'timer',
      type: 'timer.due',
      version: 1,
      subject: receipt.id,
      occurredAt: dueAt,
      observedAt: now,
      scope: receipt.rule.scope,
      data: { invocationId: receipt.id, dueAt },
      provenance: 'timer',
      completeness: 'observed',
      depth: 0,
    });
  }
  receipt(id: string): AutomationReceipt | undefined {
    return this.read('receipts', id);
  }
  /** Receipts created for one published event, across rule revisions. */
  eventReceipts(source: string, eventId: string): AutomationReceipt[] {
    return (
      this.connection.raw
        .prepare('SELECT payload FROM receipts WHERE event_source=? AND event_id=?')
        .all(source, eventId) as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as AutomationReceipt);
  }
  /** Whether a rule accepted the event and has not finished handling it. */
  hasEventDelivery(source: string, eventId: string): boolean {
    return !!this.connection.raw
      .prepare(
        "SELECT 1 FROM deliveries WHERE state='accepted' AND event_source=? AND event_id=? LIMIT 1"
      )
      .get(source, eventId);
  }
  activities(limit = 50, before?: number): AutomationReceipt[] {
    return (
      this.connection.raw
        .prepare(
          'SELECT payload FROM receipts WHERE updated_at < ? ORDER BY updated_at DESC,id LIMIT ?'
        )
        .all(before ?? Number.MAX_SAFE_INTEGER, Math.min(100, Math.max(1, limit))) as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as AutomationReceipt);
  }
  hasSessionWork(sessionId: string, excludingInvocationId?: string): boolean {
    const receipt = this.connection.raw
      .prepare(`SELECT 1 FROM receipts WHERE state IN (${nonterminal})
      AND id<>? AND action_kind IN ('agent.invoke','session.compact') AND session_id=? LIMIT 1`)
      .get(excludingInvocationId ?? '', sessionId);
    const work = this.connection.raw
      .prepare(`SELECT 1 FROM work WHERE session_id=?
      AND state NOT IN ('settled','cancelled','failed')
      AND (? IS NULL OR COALESCE(invocation_id,'')<>?) LIMIT 1`)
      .get(sessionId, excludingInvocationId ?? null, excludingInvocationId ?? null);
    const wait = this.connection.raw
      .prepare(`SELECT 1 FROM waits WHERE state IN ('waiting','checking','matched')
      AND id<>? AND session_id=? AND (? IS NULL OR COALESCE(invocation_id,'')<>?)
      AND (state<>'matched' OR EXISTS (SELECT 1 FROM receipts WHERE receipts.id=waits.invocation_id
        AND receipts.state IN (${nonterminal}))) LIMIT 1`)
      .get(
        excludingInvocationId ?? '',
        sessionId,
        excludingInvocationId ?? null,
        excludingInvocationId ?? null
      );
    return !!receipt || !!work || !!wait;
  }
  activityPage(
    userId: string | undefined,
    sessionId: string | undefined,
    limit: number,
    before?: { updatedAt: number; id: string }
  ) {
    const where = (ownerColumn: string, sessionColumn: string) => {
      const filters = [
        ...(userId === undefined ? [] : [`${ownerColumn}=?`]),
        ...(sessionId === undefined ? [] : [`${sessionColumn}=?`]),
      ];
      return filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    };
    const args = [userId, sessionId].filter((value): value is string => value !== undefined);
    const rows = this.connection.raw
      .prepare(`SELECT * FROM (
      SELECT 'action' AS kind,id,updated_at AS updatedAt,payload FROM receipts
      ${where('owner_user_id', 'scope_session_id')}
      UNION ALL
      SELECT 'handler' AS kind,id,updated_at AS updatedAt,payload FROM deliveries
      ${where('owner_user_id', 'scope_session_id')}
      UNION ALL
      SELECT 'work' AS kind,id,updated_at AS updatedAt,payload FROM work
      ${where('owner_user_id', 'session_id')}
      UNION ALL
      SELECT 'release' AS kind,id,observed_at AS updatedAt,payload FROM turn_observations
      ${where('user_id', 'session_id')}
    ) WHERE (updatedAt<? OR (updatedAt=? AND id>?)) ORDER BY updatedAt DESC,id LIMIT ?`)
      .all(
        ...args,
        ...args,
        ...args,
        ...args,
        before?.updatedAt ?? Number.MAX_SAFE_INTEGER,
        before?.updatedAt ?? Number.MAX_SAFE_INTEGER,
        before?.id ?? '',
        limit + 1
      ) as Array<
      JsonRow & {
        kind: 'action' | 'handler' | 'work' | 'release';
        id: string;
        updatedAt: number;
      }
    >;
    const items = rows.slice(0, limit).map((row) => ({
      kind: row.kind,
      id: row.id,
      ...(JSON.parse(row.payload) as
        | AutomationReceipt
        | Delivery
        | PendingWork
        | SessionAutomationObservation),
    }));
    const last = rows[limit - 1];
    return {
      items,
      ...(rows.length > limit && last
        ? { nextCursor: { updatedAt: last.updatedAt, id: last.id } }
        : {}),
    };
  }
  pending(now: number, limit = 100): AutomationReceipt[] {
    return (
      this.connection.raw
        .prepare(`SELECT payload FROM receipts WHERE state IN (${nonterminal})
      AND retry_at<=? ORDER BY updated_at,id LIMIT ?`)
        .all(now, limit) as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as AutomationReceipt);
  }
  update(
    id: string,
    expected: AutomationState,
    patch: Partial<AutomationReceipt>,
    now: number
  ): AutomationReceipt | undefined {
    return this.connection.withImmediate(() => {
      const previous = this.receipt(id);
      if (!previous || previous.state !== expected || terminal.has(previous.state))
        return undefined;
      const next = {
        ...previous,
        ...patch,
        id: previous.id,
        deliveryId: previous.deliveryId,
        rule: previous.rule,
        event: previous.event,
        intent: previous.intent,
        updatedAt: now,
      };
      const c = receiptColumns(next);
      this.connection.raw
        .prepare(`UPDATE receipts SET state=?,updated_at=?,session_id=?,scope_session_id=?,
        owner_user_id=?,rule_id=?,action_kind=?,event_type=?,event_source=?,event_id=?,
        correlation_key=?,policy=?,work_id=?,retry_at=?,payload=? WHERE id=?`)
        .run(
          next.state,
          now,
          c.session_id,
          c.scope_session_id,
          c.owner_user_id,
          c.rule_id,
          c.action_kind,
          c.event_type,
          c.event_source,
          c.event_id,
          c.correlation_key,
          c.policy,
          c.work_id,
          c.retry_at,
          JSON.stringify(next),
          id
        );
      if (terminal.has(next.state) && next.intent.action.kind === 'agent.invoke') {
        const invocation = automationInvocationSchema.safeParse(next.intent.action.parameters);
        const work =
          invocation.success && invocation.data.input.kind === 'pending_work'
            ? this.work(invocation.data.input.ref)
            : undefined;
        if (work?.invocationId === id && !['settled', 'cancelled', 'failed'].includes(work.state))
          this.putWork({
            ...work,
            state:
              next.state === 'settled'
                ? 'settled'
                : next.state === 'failed'
                  ? 'failed'
                  : 'cancelled',
            updatedAt: now,
          });
      }
      return next;
    });
  }
  cancel(id: string, now: number): boolean {
    const receipt = this.receipt(id);
    if (!receipt || terminal.has(receipt.state)) return false;
    // Submitted work requires cancellation at its resource owner, not just a ledger edit.
    if (['submitting', 'queued', 'running', 'unknown'].includes(receipt.state))
      throw new Error('AUTOMATION_CANCEL_REQUIRES_OWNER');
    return !!this.update(id, receipt.state, { state: 'cancelled', reason: 'user_cancelled' }, now);
  }
  capacity(bindingId: string, modelId?: string): CapacityObservation | undefined {
    return this.read('capacity', automationIdentity(bindingId, modelId ?? ''));
  }
  recordCapacity(observation: CapacityObservation, now: number, event?: AutomationEvent): void {
    this.connection.withImmediate(() => {
      this.putCapacity(observation);
      if (event) this.publish(event);
      // A fresh available observation is new evidence; the deadline is a recheck, never admission.
      if (evaluateCapacity(observation, observation, now).value !== 'yes') return;
      // Same-or-older evidence for this binding/model was already scanned — no new wake.
      const wakeKey = `wake/${automationIdentity(observation.bindingId, observation.modelId ?? '')}`;
      const seen = this.read('capacity', wakeKey) as { observedAt?: number } | undefined;
      if ((seen?.observedAt ?? -1) >= observation.observedAt) return;
      const rows = (
        observation.modelId === undefined
          ? this.connection.raw
              .prepare(
                `SELECT r.payload AS receipt, w.payload AS work FROM receipts r
                JOIN work w ON w.id=r.work_id AND w.binding_id=? AND w.fingerprint=?
                WHERE r.state IN ('accepted','waiting','blocked','resolved')
                AND r.event_type='provider.quota.exhausted' AND r.policy='recover-capacity'`
              )
              .all(observation.bindingId, observation.fingerprint)
          : this.connection.raw
              .prepare(
                `SELECT r.payload AS receipt, w.payload AS work FROM receipts r
                JOIN work w ON w.id=r.work_id AND w.binding_id=? AND w.fingerprint=? AND w.model_id=?
                WHERE r.state IN ('accepted','waiting','blocked','resolved')
                AND r.event_type='provider.quota.exhausted' AND r.policy='recover-capacity'`
              )
              .all(observation.bindingId, observation.fingerprint, observation.modelId)
      ) as Array<{ receipt: string; work: string }>;
      for (const row of rows) {
        const receipt = JSON.parse(row.receipt) as AutomationReceipt;
        const work = JSON.parse(row.work) as PendingWork;
        const current =
          this.capacity(work.bindingId, work.modelId) ?? this.capacity(work.bindingId);
        if (evaluateCapacity(current, work, now).value !== 'yes') continue;
        // One wake per receipt per push: a snapshot expands to one observation per model plus aggregate.
        if (receipt.retryAt === now) continue;
        this.update(
          receipt.id,
          receipt.state,
          {
            retryAt: now,
            capacityWakeRevision: (receipt.capacityWakeRevision ?? 0) + 1,
          },
          now
        );
      }
      this.connection.raw
        .prepare(
          'INSERT INTO capacity VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
        )
        .run(wakeKey, JSON.stringify({ observedAt: observation.observedAt }));
    });
  }
  recordWork(work: PendingWork, event: AutomationEvent): void {
    this.connection.withImmediate(() => {
      this.putWork(work);
      this.publish(event);
    });
  }
  putCapacity(observation: CapacityObservation): void {
    this.connection.withImmediate(() => {
      const previous = this.capacity(observation.bindingId, observation.modelId);
      if (previous && previous.observedAt > observation.observedAt) return;
      this.connection.raw
        .prepare(
          'INSERT INTO capacity VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
        )
        .run(
          automationIdentity(observation.bindingId, observation.modelId ?? ''),
          JSON.stringify(observation)
        );
    });
  }
  supersedeWork(
    sessionId: string,
    turnId: string,
    invocationId: string | undefined,
    now: number
  ): void {
    this.connection.withImmediate(() => {
      const rows = this.connection.raw
        .prepare(`SELECT payload FROM work WHERE session_id=?
        AND turn_id<>? AND state IN ('blocked_on_capacity','queued')
        AND (? IS NULL OR COALESCE(invocation_id,'')<>?)`)
        .all(sessionId, turnId, invocationId ?? null, invocationId ?? null) as JsonRow[];
      for (const row of rows)
        this.putWork({
          ...(JSON.parse(row.payload) as PendingWork),
          state: 'cancelled',
          updatedAt: now,
        });
    });
  }
  work(id: string): PendingWork | undefined {
    return this.read('work', id);
  }
  configureSession(
    action: () => void,
    sessionId: string,
    turnId: string | undefined,
    now: number
  ): void {
    this.connection.withImmediate(() => {
      action();
      if (turnId) this.activateCurrentCapacityFailure(sessionId, turnId, now);
    });
  }
  activateCurrentCapacityFailure(sessionId: string, turnId: string, now: number): void {
    this.connection.withImmediate(() => {
      const work = (
        this.connection.raw
          .prepare(
            "SELECT payload FROM work WHERE session_id=? AND state='blocked_on_capacity' AND turn_id=?"
          )
          .all(sessionId, turnId) as JsonRow[]
      )
        .map((row) => JSON.parse(row.payload) as PendingWork)
        .find((item) => !item.invocationId);
      if (!work) return;
      const existing = this.connection.raw
        .prepare('SELECT 1 FROM deliveries WHERE event_work_id=? AND rule_id=? LIMIT 1')
        .get(work.id, automationIdentity('session-policy', sessionId, 'recover-capacity'));
      if (existing) return;
      const row = this.connection.raw
        .prepare(
          `SELECT payload FROM events WHERE work_id=?
          AND type IN ('provider.quota.exhausted','provider.model.overloaded') LIMIT 1`
        )
        .get(work.id) as JsonRow | undefined;
      if (!row) return;
      const event = JSON.parse(row.payload) as AutomationEvent;
      this.publish({
        ...event,
        id: automationIdentity('enabled-capacity-recovery', work.id),
        observedAt: now,
      });
    });
  }
  sessionWork(sessionId: string, userId: string): PendingWork[] {
    return (
      this.connection.raw
        .prepare(
          'SELECT payload FROM work WHERE session_id=? AND owner_user_id=? ORDER BY updated_at DESC'
        )
        .all(sessionId, userId) as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as PendingWork);
  }
  claimWork(id: string, invocationId: string): boolean {
    return this.connection.withImmediate(() => {
      const work = this.work(id);
      if (
        !work ||
        (work.invocationId && work.invocationId !== invocationId) ||
        ['settled', 'cancelled', 'failed', 'unknown'].includes(work.state)
      )
        return false;
      this.putWork({ ...work, invocationId, state: 'queued' });
      return true;
    });
  }
  putWork(work: PendingWork): void {
    const c = workColumns(work);
    this.connection.raw
      .prepare(
        `INSERT INTO work (id,session_id,owner_user_id,state,turn_id,invocation_id,updated_at,
        binding_id,fingerprint,model_id,payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,
        owner_user_id=excluded.owner_user_id,state=excluded.state,turn_id=excluded.turn_id,
        invocation_id=excluded.invocation_id,updated_at=excluded.updated_at,
        binding_id=excluded.binding_id,fingerprint=excluded.fingerprint,model_id=excluded.model_id,
        payload=excluded.payload`
      )
      .run(
        work.id,
        c.session_id,
        c.owner_user_id,
        c.state,
        c.turn_id,
        c.invocation_id,
        c.updated_at,
        c.binding_id,
        c.fingerprint,
        c.model_id,
        JSON.stringify(work)
      );
  }
}
