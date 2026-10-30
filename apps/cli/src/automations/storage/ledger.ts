import type { SessionAutomationObservation } from '@/session/automation-observations';
import { createHash, randomUUID } from 'node:crypto';
import {
  automationResultSchema,
  automationRegistrationSchema,
  type AutomationRegistration,
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

export const automationIdentity = (...parts: Array<string | number>): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const terminal = new Set<AutomationState>(['settled', 'failed', 'cancelled', 'superseded']);
type JsonRow = { payload: string };
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
      if (version > 2) throw new Error('AUTOMATION_DATABASE_VERSION_UNSUPPORTED');
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
        CREATE INDEX IF NOT EXISTS waits_due ON waits(state,next_check_at);
        CREATE TABLE IF NOT EXISTS turn_observations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      `);
      if (version < 2)
        this.connection.withImmediate(() => {
          db.exec('ALTER TABLE turn_observations ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0');
          db.pragma('user_version = 2');
        });
      db.exec('CREATE INDEX IF NOT EXISTS turn_observations_due ON turn_observations(retry_at)');
    } catch (cause) {
      this.close();
      throw cause;
    }
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
  private writeWait(wait: AutomationWait): void {
    this.connection.raw
      .prepare(`INSERT INTO waits VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      state=excluded.state,next_check_at=excluded.next_check_at,payload=excluded.payload`)
      .run(wait.id, wait.state, wait.nextCheckAt, JSON.stringify(wait));
  }
  wait(id: string): AutomationWait | undefined {
    return this.read('waits', id);
  }
  waits(userId: string, sessionId?: string): AutomationWait[] {
    return (
      this.connection.raw
        .prepare(`SELECT payload FROM waits WHERE json_extract(payload,'$.ownerUserId')=?
      AND (? IS NULL OR json_extract(payload,'$.sessionId')=?) ORDER BY json_extract(payload,'$.createdAt') DESC,id`)
        .all(userId, sessionId ?? null, sessionId ?? null) as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as AutomationWait);
  }
  dueWaits(now: number, limit = 4): AutomationWait[] {
    return (
      this.connection.raw
        .prepare(`SELECT payload FROM waits WHERE state IN ('waiting','checking')
      AND (next_check_at<=? OR json_extract(payload,'$.expiresAt')<=?) ORDER BY next_check_at,id LIMIT ?`)
        .all(now, now, limit) as JsonRow[]
    ).map((row) => JSON.parse(row.payload) as AutomationWait);
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
  wantsRead(resource: string, sessionId?: string): boolean {
    return !!this.connection.raw
      .prepare(`SELECT 1 FROM waits,json_each(waits.payload,'$.reads') AS dependency
      WHERE (waits.state IN ('waiting','checking') OR (waits.state='matched' AND EXISTS
        (SELECT 1 FROM receipts WHERE receipts.id=json_extract(waits.payload,'$.invocationId')
        AND receipts.state NOT IN ('settled','failed','cancelled','superseded')))) AND dependency.value=?
      AND (? IS NULL OR json_extract(waits.payload,'$.sessionId')=?) LIMIT 1`)
      .get(resource, sessionId ?? null, sessionId ?? null);
  }
  invalidateReads(resource: string, sessionId: string, now: number): void {
    const waits = this.connection.raw
      .prepare(`SELECT waits.payload FROM waits,json_each(waits.payload,'$.reads') AS dependency
      WHERE waits.state='waiting' AND dependency.value=? AND json_extract(waits.payload,'$.sessionId')=?`)
      .all(resource, sessionId) as JsonRow[];
    for (const row of waits) {
      const wait = JSON.parse(row.payload) as AutomationWait;
      this.updateWait(wait.id, 'waiting', { nextCheckAt: Math.min(wait.nextCheckAt, now) }, now);
    }
  }
  sessionEvents(sessionId: string, since: number, limit: number): AutomationEvent[] {
    return (
      this.connection.raw
        .prepare(`SELECT payload FROM events
      WHERE json_extract(payload,'$.scope.sessionId')=? AND json_extract(payload,'$.observedAt')>=?
      ORDER BY sequence DESC LIMIT ?`)
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
            nextCheckAt: now + wait.intervalMs,
            consecutiveErrors: 0,
            lastError: undefined,
          },
          now
        );
      // Completion-to-resume is fixed Host policy. Programs cannot author rules or target another Session.
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
          `INSERT INTO turn_observations (id,payload) VALUES (?,?)
          ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,retry_at=0`
        )
        .run(id, JSON.stringify(fact));
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
      const result = this.connection.raw
        .prepare('INSERT OR IGNORE INTO events(event_key,payload) VALUES (?,?)')
        .run(key, JSON.stringify(event));
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
        this.connection.raw
          .prepare('INSERT INTO deliveries VALUES (?,?,?)')
          .run(delivery.id, delivery.state, JSON.stringify(delivery));
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
      .prepare("UPDATE deliveries SET state=?,payload=? WHERE id=? AND state='accepted'")
      .run(next.state, JSON.stringify(next), next.id);
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
        WHERE json_extract(payload,'$.rule.id')=? AND state NOT IN ('settled','failed','cancelled','superseded')`)
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
          WHERE json_extract(payload,'$.rule.id')=?
          AND json_extract(payload,'$.intent.action.kind') = 'agent.invoke'
          AND COALESCE(json_extract(payload,'$.event.correlationId'),json_extract(payload,'$.deliveryId'))=?`)
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
      this.connection.raw
        .prepare('INSERT INTO receipts VALUES (?,?,?,?,?)')
        .run(id, delivery.id, receipt.state, now, JSON.stringify(receipt));
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
      .prepare(`SELECT 1 FROM receipts WHERE state NOT IN ('settled','failed','cancelled','superseded')
      AND id<>? AND json_extract(payload,'$.intent.action.kind') IN ('agent.invoke','session.compact')
      AND (json_extract(payload,'$.sessionId')=? OR json_extract(payload,'$.intent.action.parameters.target.sessionId')=?
        OR json_extract(payload,'$.intent.action.parameters.sessionId')=?) LIMIT 1`)
      .get(excludingInvocationId ?? '', sessionId, sessionId, sessionId);
    const work = this.connection.raw
      .prepare(`SELECT 1 FROM work WHERE json_extract(payload,'$.sessionId')=?
      AND json_extract(payload,'$.state') NOT IN ('settled','cancelled','failed')
      AND (? IS NULL OR COALESCE(json_extract(payload,'$.invocationId'),'')<>?) LIMIT 1`)
      .get(sessionId, excludingInvocationId ?? null, excludingInvocationId ?? null);
    const wait = this.connection.raw
      .prepare(`SELECT 1 FROM waits WHERE state IN ('waiting','checking','matched')
      AND id<>? AND json_extract(payload,'$.sessionId')=? AND (? IS NULL OR COALESCE(json_extract(payload,'$.invocationId'),'')<>?)
      AND (state<>'matched' OR EXISTS (SELECT 1 FROM receipts WHERE receipts.id=json_extract(waits.payload,'$.invocationId')
        AND receipts.state NOT IN ('settled','failed','cancelled','superseded'))) LIMIT 1`)
      .get(
        excludingInvocationId ?? '',
        sessionId,
        excludingInvocationId ?? null,
        excludingInvocationId ?? null
      );
    return !!receipt || !!work || !!wait;
  }
  activityPage(
    userId: string,
    sessionId: string | undefined,
    limit: number,
    before?: { updatedAt: number; id: string }
  ) {
    const rows = this.connection.raw
      .prepare(`SELECT * FROM (
      SELECT 'action' AS kind,id,updated_at AS updatedAt,payload FROM receipts
      UNION ALL SELECT 'handler' AS kind,id,COALESCE(json_extract(payload,'$.updatedAt'),0) AS updatedAt,payload FROM deliveries
      UNION ALL SELECT 'work' AS kind,id,COALESCE(json_extract(payload,'$.updatedAt'),0) AS updatedAt,payload FROM work
      UNION ALL SELECT 'release' AS kind,id,json_extract(payload,'$.observedAt') AS updatedAt,payload FROM turn_observations
    ) WHERE COALESCE(json_extract(payload,'$.rule.ownerUserId'),json_extract(payload,'$.ownerUserId'),json_extract(payload,'$.userId'))=?
      AND (? IS NULL OR COALESCE(json_extract(payload,'$.rule.scope.sessionId'),json_extract(payload,'$.sessionId'))=?)
      AND (updatedAt<? OR (updatedAt=? AND id>?)) ORDER BY updatedAt DESC,id LIMIT ?`)
      .all(
        userId,
        sessionId ?? null,
        sessionId ?? null,
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
        .prepare(`SELECT payload FROM receipts WHERE state NOT IN ('settled','failed','cancelled','superseded')
      AND COALESCE(json_extract(payload,'$.retryAt'),0)<=? ORDER BY updated_at,id LIMIT ?`)
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
      this.connection.raw
        .prepare('UPDATE receipts SET state=?,updated_at=?,payload=? WHERE id=?')
        .run(next.state, now, JSON.stringify(next), id);
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
  recordCapacity(observation: CapacityObservation, event?: AutomationEvent): void {
    this.connection.withImmediate(() => {
      this.putCapacity(observation);
      if (event) this.publish(event);
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
        .prepare(`SELECT payload FROM work WHERE json_extract(payload,'$.sessionId')=?
        AND json_extract(payload,'$.turnId')<>? AND json_extract(payload,'$.state') IN ('blocked_on_capacity','queued')
        AND (? IS NULL OR COALESCE(json_extract(payload,'$.invocationId'),'')<>?)`)
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
  sessionWork(sessionId: string, userId: string): PendingWork[] {
    return (
      this.connection.raw
        .prepare(
          "SELECT payload FROM work WHERE json_extract(payload,'$.sessionId')=? AND json_extract(payload,'$.ownerUserId')=? ORDER BY json_extract(payload,'$.updatedAt') DESC"
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
    this.connection.raw
      .prepare(
        'INSERT INTO work VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
      )
      .run(work.id, JSON.stringify(work));
  }
}
