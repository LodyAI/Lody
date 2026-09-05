import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  evaluateSchedule,
  manualScheduleRunKey,
  scheduleRunIds,
  scheduleRunKey,
  SCHEDULE_RETRY_DELAYS_MS,
  type ScheduleDefinition,
  type ScheduleDocument,
  type ScheduleRunState,
  type ScheduleEvaluation,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

export type ScheduleRun<Prepared = unknown> = {
  runKey: string;
  workspaceId: string;
  scheduleId: string;
  activationId: string;
  machineId: string;
  agentConfigId: string;
  scheduledFor: number;
  plannedAt: number;
  definitionFingerprint: string;
  state: ScheduleRunState;
  manual: boolean;
  sessionId: string;
  userTurnId: string;
  sourceEntryId: string;
  attempts: number;
  retryAt?: number;
  errorCode?: string;
  definition: ScheduleDefinition;
  prompt: string;
  prepared?: Prepared;
};

const terminal = new Set<ScheduleRunState>(['finished', 'failed', 'skipped']);

/** A Host-owned ledger. Every cursor advance and selected run share one SQLite commit. */
export class ScheduleStore<Prepared = unknown> {
  private readonly db: Database.Database;

  constructor(filename = path.join(getLodyDataDir(), 'schedules.sqlite')) {
    if (filename !== ':memory:')
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1) {
      this.db.close();
      throw new Error('Schedule database requires a newer CLI');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_cursors (
        workspace_id TEXT NOT NULL, schedule_id TEXT NOT NULL, activation_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, last_slot INTEGER, next_slot INTEGER, updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, schedule_id, activation_id)
      );
      CREATE TABLE IF NOT EXISTS schedule_runs (
        run_key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, schedule_id TEXT NOT NULL,
        state TEXT NOT NULL, planned_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedule_runs_workspace_state ON schedule_runs(workspace_id, state);
      CREATE INDEX IF NOT EXISTS schedule_runs_history ON schedule_runs(workspace_id, schedule_id, planned_at DESC);
    `);
    this.db.pragma('user_version = 1');
  }

  planningState(
    workspaceId: string,
    scheduleId: string,
    activationId: string
  ): { fingerprint: string; nextSlot: number | null } | undefined {
    return this.db
      .prepare(
        'SELECT fingerprint, next_slot AS nextSlot FROM schedule_cursors WHERE workspace_id=? AND schedule_id=? AND activation_id=?'
      )
      .get(workspaceId, scheduleId, activationId) as
      | { fingerprint: string; nextSlot: number | null }
      | undefined;
  }
  close(): void {
    this.db.close();
  }
  get(runKey: string): ScheduleRun<Prepared> | undefined {
    const row = this.db
      .prepare('SELECT payload FROM schedule_runs WHERE run_key = ?')
      .get(runKey) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  unfinished(workspaceId: string): ScheduleRun<Prepared>[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM schedule_runs WHERE workspace_id = ? AND state NOT IN ('finished','failed','skipped') ORDER BY planned_at,run_key"
        )
        .all(workspaceId) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload));
  }
  history(workspaceId: string, scheduleId: string, limit = 50): ScheduleRun<Prepared>[] {
    return (
      this.db
        .prepare(
          'SELECT payload FROM schedule_runs WHERE workspace_id = ? AND schedule_id = ? ORDER BY planned_at DESC,run_key LIMIT ?'
        )
        .all(workspaceId, scheduleId, Math.max(1, Math.min(100, limit))) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload));
  }
  private put(run: ScheduleRun<Prepared>): void {
    this.db
      .prepare(
        'INSERT INTO schedule_runs VALUES (?,?,?,?,?,?) ON CONFLICT(run_key) DO UPDATE SET state=excluded.state,payload=excluded.payload'
      )
      .run(
        run.runKey,
        run.workspaceId,
        run.scheduleId,
        run.state,
        run.plannedAt,
        JSON.stringify(run)
      );
  }

  plan(
    workspaceId: string,
    document: ScheduleDocument,
    fingerprint: string,
    now: number
  ): ScheduleEvaluation {
    return this.db
      .transaction(() => {
        const d = document.definition;
        const cursor = this.db
          .prepare(
            'SELECT last_slot AS lastSlot, fingerprint FROM schedule_cursors WHERE workspace_id=? AND schedule_id=? AND activation_id=?'
          )
          .get(workspaceId, d.scheduleId, d.activationId) as
          | { lastSlot: number | null; fingerprint: string }
          | undefined;
        if (cursor && cursor.fingerprint !== fingerprint)
          throw new Error('Activation fingerprint changed without a new activation');
        const evaluation = evaluateSchedule(d, cursor?.lastSlot ?? undefined, now);
        if (evaluation.due) {
          const runKey = scheduleRunKey(d.scheduleId, d.activationId, evaluation.due.scheduledFor);
          if (!this.get(runKey)) {
            const existing = this.unfinished(workspaceId).filter(
              (run) => run.scheduleId === d.scheduleId && !run.manual
            );
            const unprepared = existing.filter(
              (run) => run.state === 'pending' && run.prepared === undefined
            );
            const overlapSkip = d.overlapPolicy === 'skip' && existing.length > 0;
            if (d.overlapPolicy === 'queue_one') {
              for (const prior of unprepared)
                this.put({ ...prior, state: 'skipped', errorCode: 'SUPERSEDED' });
            }
            this.put({
              ...scheduleRunIds(runKey),
              runKey,
              workspaceId,
              scheduleId: d.scheduleId,
              activationId: d.activationId,
              machineId: d.machineId,
              agentConfigId: d.agent.agentConfigId,
              definitionFingerprint: fingerprint,
              scheduledFor: evaluation.due.scheduledFor,
              plannedAt: now,
              state: evaluation.due.disposition === 'skip' || overlapSkip ? 'skipped' : 'pending',
              ...(evaluation.due.disposition === 'skip'
                ? { errorCode: 'MISFIRE' }
                : overlapSkip
                  ? { errorCode: 'OVERLAP' }
                  : {}),
              attempts: 0,
              manual: false,
              definition: d,
              prompt: document.prompt,
            });
          }
        }
        this.db
          .prepare(
            'INSERT INTO schedule_cursors VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,schedule_id,activation_id) DO UPDATE SET last_slot=excluded.last_slot,next_slot=excluded.next_slot,updated_at=excluded.updated_at'
          )
          .run(
            workspaceId,
            d.scheduleId,
            d.activationId,
            fingerprint,
            evaluation.evaluatedThrough ?? null,
            evaluation.nextScheduledAt ?? null,
            now
          );
        return evaluation;
      })
      .immediate();
  }

  planManual(
    workspaceId: string,
    document: ScheduleDocument,
    fingerprint: string,
    manualRunId: string,
    now: number
  ): ScheduleRun<Prepared> {
    return this.db
      .transaction(() => {
        const d = document.definition;
        const runKey = manualScheduleRunKey(d.scheduleId, manualRunId);
        const existing = this.get(runKey);
        if (existing) return existing;
        const run: ScheduleRun<Prepared> = {
          ...scheduleRunIds(runKey),
          runKey,
          workspaceId,
          scheduleId: d.scheduleId,
          activationId: d.activationId,
          machineId: d.machineId,
          agentConfigId: d.agent.agentConfigId,
          definitionFingerprint: fingerprint,
          scheduledFor: now,
          plannedAt: now,
          state: 'pending',
          attempts: 0,
          manual: true,
          definition: d,
          prompt: document.prompt,
        };
        this.put(run);
        return run;
      })
      .immediate();
  }

  transition(
    runKey: string,
    from: readonly ScheduleRunState[],
    patch: Partial<
      Pick<ScheduleRun<Prepared>, 'state' | 'prepared' | 'attempts' | 'retryAt' | 'errorCode'>
    >
  ): ScheduleRun<Prepared> {
    return this.db
      .transaction(() => {
        const run = this.get(runKey);
        if (!run || !from.includes(run.state)) throw new Error('Schedule run state changed');
        const updated = { ...run, ...patch };
        this.put(updated);
        return updated;
      })
      .immediate();
  }

  failAttempt(runKey: string, errorCode: string, now: number): void {
    const run = this.get(runKey);
    if (!run || terminal.has(run.state) || run.state === 'dispatched') return;
    const exhausted =
      run.attempts >= run.definition.retryPolicy.dispatchMaxAttempts ||
      now - run.plannedAt >= run.definition.retryPolicy.dispatchMaxAgeMs;
    this.transition(runKey, [run.state], {
      state: exhausted ? 'failed' : 'retry_wait',
      errorCode,
      retryAt: exhausted
        ? undefined
        : now + SCHEDULE_RETRY_DELAYS_MS[Math.max(0, Math.min(run.attempts - 1, 3))]!,
    });
  }
}
