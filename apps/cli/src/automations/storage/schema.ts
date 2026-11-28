import type { SessionAutomationObservation } from '@/session/automation-observations';
import type {
  AutomationEvent,
  AutomationReceipt,
  AutomationRule,
  AutomationState,
  AutomationWait,
  PendingWork,
} from '@lody/shared/automations';
import type { OrchestrationConnection } from '../../orchestration/platform/database';

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

export const TERMINAL_STATES: ReadonlySet<AutomationState> = new Set<AutomationState>([
  'settled',
  'failed',
  'cancelled',
  'superseded',
]);

export const IN_FLIGHT_STATES: ReadonlySet<AutomationState> = new Set<AutomationState>([
  'submitting',
  'queued',
  'running',
  'unknown',
]);

export const CANCELLABLE_DELIVERY_STATES: ReadonlySet<AutomationState> = new Set<AutomationState>([
  'accepted',
  'waiting',
  'resolved',
  'blocked',
  'submitting',
  'queued',
]);

export const TERMINAL_WORK_STATES: ReadonlySet<PendingWork['state']> = new Set<
  PendingWork['state']
>(['settled', 'cancelled', 'failed', 'unknown']);

/** Receipt block reasons caused by normal concurrent session or inbox activity. */
export const SESSION_BUSY_BLOCK_REASONS: ReadonlySet<string> = new Set([
  'session_work_active',
  'input_pending',
  'target_input_pending',
  'queue_pending',
  'goal_active',
  'automation_work_pending',
  'native_work_active',
  'session_admission_busy',
  'session_admission_blocked',
]);

export const NONTERMINAL_STATES_SQL = `'accepted','waiting','resolved','submitting','queued','running','blocked','unknown','cancelling'`;

export type JsonRow = { payload: string };

/** The payload is the frozen acceptance record; every queried field lives in a real column. */
export const eventColumns = (event: AutomationEvent) => ({
  type: event.type,
  source: event.source,
  subject: event.subject,
  session_id: event.scope.sessionId ?? null,
  project_id: event.scope.projectId ?? null,
  work_id: typeof event.data.workId === 'string' ? event.data.workId : null,
  observed_at: event.observedAt,
});

export const receiptColumns = (receipt: AutomationReceipt) => ({
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

export const waitColumns = (wait: AutomationWait) => ({
  session_id: wait.sessionId,
  owner_user_id: wait.ownerUserId,
  invocation_id: wait.invocationId ?? null,
  slot_key: wait.run ? null : (wait.key ?? ''),
  created_at: wait.createdAt,
  updated_at: wait.updatedAt,
  due_at: Math.min(wait.nextCheckAt, wait.expiresAt ?? Number.MAX_SAFE_INTEGER),
  run_pending: wait.run && wait.run.startedAt !== undefined && !wait.run.exit ? 1 : 0,
});

export const workColumns = (work: PendingWork) => ({
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

export const deliveryColumns = (delivery: Delivery) => ({
  rule_id: delivery.rule.id,
  owner_user_id: delivery.rule.ownerUserId,
  scope_session_id: delivery.rule.scope.sessionId ?? null,
  event_source: delivery.event.source,
  event_id: delivery.event.id,
  event_work_id: typeof delivery.event.data.workId === 'string' ? delivery.event.data.workId : null,
  updated_at: delivery.updatedAt,
});

export function initializeAutomationLedgerSchema(connection: OrchestrationConnection): void {
  const db = connection.raw;
  const version = Number(db.pragma('user_version', { simple: true }));
  if (version > 5) throw new Error('AUTOMATION_DATABASE_VERSION_UNSUPPORTED');
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
    connection.withImmediate(() => {
      db.exec('ALTER TABLE turn_observations ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0');
      db.pragma('user_version = 2');
    });
  if (version < 4) migrateQueryColumns(connection);
  if (version < 5) migrateSlotColumns(connection);
  db.exec(`
    CREATE INDEX IF NOT EXISTS turn_observations_due ON turn_observations(retry_at);
    CREATE INDEX IF NOT EXISTS events_session ON events(session_id, observed_at);
    CREATE INDEX IF NOT EXISTS events_work ON events(work_id);
    DROP INDEX IF EXISTS receipts_due;
    CREATE INDEX IF NOT EXISTS receipts_due_active ON receipts(retry_at)
    WHERE state IN (${NONTERMINAL_STATES_SQL});
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
    CREATE INDEX IF NOT EXISTS waits_slot ON waits(session_id, slot_key, state);
    CREATE INDEX IF NOT EXISTS waits_terminal ON waits(updated_at)
    WHERE state IN ('cancelled','expired','failed','superseded');
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
}

/** v3/v4 lifts every predicate out of the payload into real columns, backfilled by writer projections. */
function migrateQueryColumns(connection: OrchestrationConnection): void {
  const db = connection.raw;
  connection.withImmediate(() => {
    const addColumns = (table: string, columns: Record<string, string>) => {
      const existing = new Set(
        (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
      );
      for (const [name, declaration] of Object.entries(columns))
        if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
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
      slot_key: 'TEXT',
      created_at: 'INTEGER',
      updated_at: 'INTEGER',
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
      `UPDATE waits SET session_id=?,owner_user_id=?,invocation_id=?,slot_key=?,created_at=?,updated_at=?,due_at=?,run_pending=?
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
        c.slot_key,
        c.created_at,
        c.updated_at,
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

/** v5 projects slot ownership and update time for supersession and terminal retirement. */
function migrateSlotColumns(connection: OrchestrationConnection): void {
  const db = connection.raw;
  connection.withImmediate(() => {
    const existing = new Set(
      (db.pragma('table_info(waits)') as Array<{ name: string }>).map((c) => c.name)
    );
    if (!existing.has('slot_key')) db.exec('ALTER TABLE waits ADD COLUMN slot_key TEXT');
    if (!existing.has('updated_at')) db.exec('ALTER TABLE waits ADD COLUMN updated_at INTEGER');
    const update = db.prepare('UPDATE waits SET slot_key=?,updated_at=? WHERE id=?');
    const rows = db.prepare('SELECT rowid,id,payload FROM waits').all() as Array<
      JsonRow & { rowid: number; id: string }
    >;
    for (const row of rows) {
      const wait = JSON.parse(row.payload) as AutomationWait;
      const c = waitColumns(wait);
      update.run(c.slot_key, c.updated_at, row.id);
    }
    db.pragma('user_version = 5');
  });
}
