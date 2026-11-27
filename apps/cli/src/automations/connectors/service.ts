import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  ConnectorTriggerConfigSchema,
  CoordinatorTriggerPolicySchema,
  formatConnectorTriggerSummary,
  formatCoordinatorTriggerWakePrompt,
  getServerNow,
  getSessionRoomId,
  isCoordinatorSession,
  isLoroRepoDocDeleted,
  normalizeSessionTurnInputConfig,
  schedulePolicyTriggerId,
  type ConnectorPluginId,
  type ConnectorTriggerConfig,
  type CoordinatorConnectorStatusSummary,
  type CoordinatorTriggerAction,
  type CoordinatorTriggerDoc,
  type CoordinatorTriggerPolicy,
  type MachineId,
  type NormalizedTriggerEvent,
  type SessionCoordinatorTriggersResponse,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { resolveTurnDispatchDefaultsFromHistory } from '@/commands/session';
import { listAliveSessionMetas } from '@/lib/command-runtime';
import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import type { ResolvedGitHubCredential } from '@/lib/pr-poller/github-credential-resolver';
import { OrchestrationConnection, type DatabaseLocation } from '@/orchestration/platform/database';
import { createSessionBackend } from '@/session/session-backend';
import type { Logger } from '@/utils/logger';
import { githubConnectorPlugin, type GitHubConnectorCursor } from './github';
import type { ConnectorHostContext, ConnectorPluginRuntime } from './types';

const COALESCE_WINDOW_MS = 10_000;
const TICK_MIN_SLEEP_MS = 2_000;
const TICK_IDLE_SLEEP_MS = 30_000;
const MAX_PENDING_EVENTS_PER_BATCH = 25;

type StoredTriggerRow = {
  id: string;
  coordinator_session_id: string;
  owner_user_id: string;
  plugin_id: string;
  schedule_id: string | null;
  title: string;
  enabled: number;
  config_json: string | null;
  instruction: string;
  policy_json: string;
  cursor_json: string | null;
  pending_events_json: string;
  coalesce_due_at: number;
  next_poll_at: number;
  last_check_at: number | null;
  last_triggered_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

type StoredTurnPolicyRow = {
  user_turn_id: string;
  coordinator_session_id: string;
  trigger_id: string;
  policy_json: string;
  dispatched_children: number;
  created_at: number;
};

const CONNECTOR_RUNTIMES: Partial<
  Record<ConnectorPluginId, ConnectorPluginRuntime<ConnectorTriggerConfig, unknown>>
> = {
  github: githubConnectorPlugin as unknown as ConnectorPluginRuntime<
    ConnectorTriggerConfig,
    unknown
  >,
};

function parsePolicy(raw: string | null | undefined): CoordinatorTriggerPolicy {
  if (!raw) return { mode: 'summarize_and_notify', maxChildrenPerRun: 2 };
  try {
    const parsed = CoordinatorTriggerPolicySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { mode: 'summarize_and_notify', maxChildrenPerRun: 2 };
  } catch {
    return { mode: 'summarize_and_notify', maxChildrenPerRun: 2 };
  }
}

function parsePendingEvents(raw: string | null | undefined): NormalizedTriggerEvent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NormalizedTriggerEvent[]) : [];
  } catch {
    return [];
  }
}

function toTriggerDoc(row: StoredTriggerRow): CoordinatorTriggerDoc {
  const config = row.config_json
    ? ConnectorTriggerConfigSchema.safeParse(JSON.parse(row.config_json))
    : null;
  const policy = parsePolicy(row.policy_json);
  return {
    id: row.id,
    pluginId: row.plugin_id as ConnectorPluginId,
    ...(row.schedule_id ? { scheduleId: row.schedule_id } : {}),
    title: row.title,
    enabled: row.enabled !== 0,
    ...(config?.success ? { summary: formatConnectorTriggerSummary(config.data) } : {}),
    ...(row.config_json ? { configJson: row.config_json } : {}),
    instruction: row.instruction,
    policyMode: policy.mode,
    ...(policy.allowedRoleIds?.length ? { allowedRoleIds: policy.allowedRoleIds } : {}),
    ...(policy.maxChildrenPerRun !== undefined
      ? { maxChildrenPerRun: policy.maxChildrenPerRun }
      : {}),
    ...(row.last_check_at !== null ? { lastCheckAt: row.last_check_at } : {}),
    ...(row.last_triggered_at !== null ? { lastTriggeredAt: row.last_triggered_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CoordinatorTriggerServiceDeps {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  userId: string;
  manager: LoroDocumentManager;
  logger: Logger;
  location?: DatabaseLocation;
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
  resolveGitHubCredential(repoFullName: string): Promise<ResolvedGitHubCredential | null>;
  invalidateGitHubCredential(repoFullName: string, credential: ResolvedGitHubCredential): void;
}

export class CoordinatorTriggerService {
  private readonly connection: OrchestrationConnection;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private runningPass = false;
  private started = false;
  private disposed = false;

  constructor(private readonly deps: CoordinatorTriggerServiceDeps) {
    this.now = deps.nowMs ?? getServerNow;
    const hash = createHash('sha256')
      .update(JSON.stringify([deps.machineId, deps.workspaceId]))
      .digest('hex')
      .slice(0, 24);
    const location: DatabaseLocation = deps.location ?? {
      kind: 'disk',
      path: path.join(getLodyDataDir(), 'automations', `coordinator-triggers-${hash}.sqlite`),
    };
    this.connection = new OrchestrationConnection(location);
    this.connection.raw.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_triggers (
        id TEXT PRIMARY KEY,
        coordinator_session_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        schedule_id TEXT,
        title TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT,
        instruction TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        cursor_json TEXT,
        pending_events_json TEXT NOT NULL DEFAULT '[]',
        coalesce_due_at INTEGER NOT NULL DEFAULT 0,
        next_poll_at INTEGER NOT NULL DEFAULT 0,
        last_check_at INTEGER,
        last_triggered_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coordinator_triggers_session
        ON coordinator_triggers(coordinator_session_id);
      CREATE INDEX IF NOT EXISTS coordinator_triggers_due
        ON coordinator_triggers(enabled, next_poll_at);
      CREATE INDEX IF NOT EXISTS coordinator_triggers_coalesce
        ON coordinator_triggers(enabled, coalesce_due_at);

      CREATE TABLE IF NOT EXISTS coordinator_trigger_turns (
        user_turn_id TEXT PRIMARY KEY,
        coordinator_session_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        dispatched_children INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
  }

  start(): void {
    if (this.disposed) return;
    this.started = true;
    this.scheduleNextTick(1_000);
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.connection.close();
  }

  private hostContext(): ConnectorHostContext {
    return {
      workspaceId: this.deps.workspaceId,
      machineId: this.deps.machineId,
      userId: this.deps.userId,
      resolveGitHubCredential: (repo) => this.deps.resolveGitHubCredential(repo),
      invalidateGitHubCredential: (repo, cred) => this.deps.invalidateGitHubCredential(repo, cred),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    };
  }

  listForSession(coordinatorSessionId: string): CoordinatorTriggerDoc[] {
    const rows = this.connection.raw
      .prepare(
        `SELECT * FROM coordinator_triggers WHERE coordinator_session_id = ? ORDER BY created_at ASC`
      )
      .all(coordinatorSessionId) as StoredTriggerRow[];
    return rows.map(toTriggerDoc);
  }

  private getRow(triggerId: string): StoredTriggerRow | undefined {
    return this.connection.raw
      .prepare(`SELECT * FROM coordinator_triggers WHERE id = ?`)
      .get(triggerId) as StoredTriggerRow | undefined;
  }

  private async syncTriggerDoc(row: StoredTriggerRow): Promise<void> {
    try {
      const doc = await this.deps.manager.getOrCreateSessionDoc(
        row.coordinator_session_id as SessionId
      );
      doc.upsertCoordinatorTrigger(row.id, toTriggerDoc(row));
    } catch (error) {
      this.deps.logger.debug(
        `[coordinator-triggers] Failed to project trigger ${row.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async removeTriggerDoc(coordinatorSessionId: string, triggerId: string): Promise<void> {
    try {
      const doc = await this.deps.manager.getOrCreateSessionDoc(coordinatorSessionId as SessionId);
      doc.deleteCoordinatorTrigger(triggerId);
    } catch {
      return;
    }
  }

  async handleAction(
    coordinatorSessionId: SessionId,
    action: CoordinatorTriggerAction
  ): Promise<SessionCoordinatorTriggersResponse> {
    try {
      switch (action.kind) {
        case 'status': {
          const connectors = await this.readConnectorStatuses(coordinatorSessionId);
          return {
            type: 'session/coordinator-triggers_response',
            sessionId: coordinatorSessionId,
            ok: true,
            connectors,
          };
        }

        case 'upsert': {
          const { payload } = action;
          const runtime = CONNECTOR_RUNTIMES[payload.config.pluginId];
          if (!runtime) {
            throw new Error(`Unsupported connector plugin: ${payload.config.pluginId}`);
          }
          const now = this.now();
          const triggerId = payload.triggerId ?? `trg_${randomUUID().slice(0, 12)}`;
          const existing = this.getRow(triggerId);
          if (existing && existing.coordinator_session_id !== coordinatorSessionId) {
            throw new Error('Trigger belongs to another coordinator session');
          }
          const configChanged =
            !existing || existing.config_json !== JSON.stringify(payload.config);
          const cursor =
            existing && !configChanged && existing.cursor_json
              ? JSON.parse(existing.cursor_json)
              : runtime.seedCursor(payload.config, now);
          const pollMs =
            payload.config.pluginId === 'github' ? payload.config.pollIntervalSec * 1_000 : 60_000;

          const row: StoredTriggerRow = {
            id: triggerId,
            coordinator_session_id: coordinatorSessionId,
            owner_user_id: this.deps.userId,
            plugin_id: payload.config.pluginId,
            schedule_id: null,
            title: payload.title,
            enabled: payload.enabled ? 1 : 0,
            config_json: JSON.stringify(payload.config),
            instruction: payload.instruction,
            policy_json: JSON.stringify(payload.policy),
            cursor_json: JSON.stringify(cursor),
            pending_events_json: '[]',
            coalesce_due_at: 0,
            next_poll_at: payload.enabled ? now + pollMs : 0,
            last_check_at: existing?.last_check_at ?? null,
            last_triggered_at: existing?.last_triggered_at ?? null,
            last_error: null,
            created_at: existing?.created_at ?? now,
            updated_at: now,
          };

          this.connection.withImmediate(() => {
            this.connection.raw
              .prepare(
                `INSERT INTO coordinator_triggers (
                  id, coordinator_session_id, owner_user_id, plugin_id, schedule_id, title,
                  enabled, config_json, instruction, policy_json, cursor_json,
                  pending_events_json, coalesce_due_at, next_poll_at, last_check_at,
                  last_triggered_at, last_error, created_at, updated_at
                ) VALUES (
                  @id, @coordinator_session_id, @owner_user_id, @plugin_id, @schedule_id, @title,
                  @enabled, @config_json, @instruction, @policy_json, @cursor_json,
                  @pending_events_json, @coalesce_due_at, @next_poll_at, @last_check_at,
                  @last_triggered_at, @last_error, @created_at, @updated_at
                )
                ON CONFLICT(id) DO UPDATE SET
                  title = excluded.title,
                  enabled = excluded.enabled,
                  config_json = excluded.config_json,
                  instruction = excluded.instruction,
                  policy_json = excluded.policy_json,
                  cursor_json = excluded.cursor_json,
                  pending_events_json = excluded.pending_events_json,
                  coalesce_due_at = excluded.coalesce_due_at,
                  next_poll_at = excluded.next_poll_at,
                  last_error = excluded.last_error,
                  updated_at = excluded.updated_at`
              )
              .run(row);
          });

          await this.syncTriggerDoc(row);
          this.scheduleNextTick(TICK_MIN_SLEEP_MS);
          return {
            type: 'session/coordinator-triggers_response',
            sessionId: coordinatorSessionId,
            ok: true,
            triggerId,
          };
        }

        case 'toggle': {
          const existing = this.getRow(action.triggerId);
          if (!existing || existing.coordinator_session_id !== coordinatorSessionId) {
            throw new Error('Trigger not found');
          }
          const now = this.now();
          let cursorJson = existing.cursor_json;
          if (action.enabled && existing.config_json) {
            const parsed = ConnectorTriggerConfigSchema.safeParse(JSON.parse(existing.config_json));
            const runtime = parsed.success ? CONNECTOR_RUNTIMES[parsed.data.pluginId] : undefined;
            if (runtime && parsed.success && !cursorJson) {
              cursorJson = JSON.stringify(runtime.seedCursor(parsed.data, now));
            }
          }
          this.connection.withImmediate(() => {
            this.connection.raw
              .prepare(
                `UPDATE coordinator_triggers
                 SET enabled = ?, cursor_json = ?, next_poll_at = ?, coalesce_due_at = 0, pending_events_json = '[]', updated_at = ?
                 WHERE id = ?`
              )
              .run(
                action.enabled ? 1 : 0,
                cursorJson,
                action.enabled ? now + 5_000 : 0,
                now,
                existing.id
              );
          });
          const updated = this.getRow(existing.id)!;
          await this.syncTriggerDoc(updated);
          if (action.enabled) this.scheduleNextTick(TICK_MIN_SLEEP_MS);
          return {
            type: 'session/coordinator-triggers_response',
            sessionId: coordinatorSessionId,
            ok: true,
            triggerId: existing.id,
          };
        }

        case 'delete': {
          const existing = this.getRow(action.triggerId);
          if (existing && existing.coordinator_session_id !== coordinatorSessionId) {
            throw new Error('Trigger belongs to another coordinator session');
          }
          this.connection.withImmediate(() => {
            this.connection.raw
              .prepare(`DELETE FROM coordinator_triggers WHERE id = ?`)
              .run(action.triggerId);
          });
          await this.removeTriggerDoc(coordinatorSessionId, action.triggerId);
          return {
            type: 'session/coordinator-triggers_response',
            sessionId: coordinatorSessionId,
            ok: true,
            triggerId: action.triggerId,
          };
        }

        case 'set_policy': {
          const now = this.now();
          const id = action.scheduleId
            ? schedulePolicyTriggerId(action.scheduleId)
            : action.triggerId;
          const existing = this.getRow(id);
          if (existing && existing.coordinator_session_id !== coordinatorSessionId) {
            throw new Error('Trigger belongs to another coordinator session');
          }
          if (existing) {
            this.connection.withImmediate(() => {
              this.connection.raw
                .prepare(
                  `UPDATE coordinator_triggers SET policy_json = ?, updated_at = ? WHERE id = ?`
                )
                .run(JSON.stringify(action.policy), now, id);
            });
          } else if (action.scheduleId) {
            const schedRow: StoredTriggerRow = {
              id,
              coordinator_session_id: coordinatorSessionId,
              owner_user_id: this.deps.userId,
              plugin_id: 'schedule',
              schedule_id: action.scheduleId,
              title: action.title ?? 'Schedule',
              enabled: 1,
              config_json: null,
              instruction: '',
              policy_json: JSON.stringify(action.policy),
              cursor_json: null,
              pending_events_json: '[]',
              coalesce_due_at: 0,
              next_poll_at: 0,
              last_check_at: null,
              last_triggered_at: null,
              last_error: null,
              created_at: now,
              updated_at: now,
            };
            this.connection.withImmediate(() => {
              this.connection.raw
                .prepare(
                  `INSERT INTO coordinator_triggers (
                    id, coordinator_session_id, owner_user_id, plugin_id, schedule_id, title,
                    enabled, config_json, instruction, policy_json, cursor_json,
                    pending_events_json, coalesce_due_at, next_poll_at, last_check_at,
                    last_triggered_at, last_error, created_at, updated_at
                  ) VALUES (
                    @id, @coordinator_session_id, @owner_user_id, @plugin_id, @schedule_id, @title,
                    @enabled, @config_json, @instruction, @policy_json, @cursor_json,
                    @pending_events_json, @coalesce_due_at, @next_poll_at, @last_check_at,
                    @last_triggered_at, @last_error, @created_at, @updated_at
                  )`
                )
                .run(schedRow);
            });
          } else {
            throw new Error('Trigger not found');
          }
          const updated = this.getRow(id)!;
          await this.syncTriggerDoc(updated);
          return {
            type: 'session/coordinator-triggers_response',
            sessionId: coordinatorSessionId,
            ok: true,
            triggerId: id,
          };
        }

        case 'run_now': {
          const existing = this.getRow(action.triggerId);
          if (!existing || existing.coordinator_session_id !== coordinatorSessionId) {
            throw new Error('Trigger not found');
          }
          const matchedCount = await this.evaluateTriggerRow(existing, { immediateFlush: true });
          return {
            type: 'session/coordinator-triggers_response',
            sessionId: coordinatorSessionId,
            ok: true,
            triggerId: existing.id,
            matchedCount,
          };
        }
      }
    } catch (error) {
      return {
        type: 'session/coordinator-triggers_response',
        sessionId: coordinatorSessionId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readConnectorStatuses(
    coordinatorSessionId: SessionId
  ): Promise<CoordinatorConnectorStatusSummary> {
    const alive = await listAliveSessionMetas(this.deps.manager);
    const repos = new Set<string>();
    const coordRecord = await this.deps.manager.repo.getDocMeta(
      getSessionRoomId(coordinatorSessionId)
    );
    const coordMeta = coordRecord?.meta as SessionMeta | undefined;
    const addRepoFromMeta = (meta: SessionMeta | undefined) => {
      if (!meta) return;
      if (meta.project?.kind === 'github' && meta.project.repoFullName) {
        repos.add(meta.project.repoFullName);
      }
      if (typeof meta.repoFullName === 'string' && meta.repoFullName.includes('/')) {
        repos.add(meta.repoFullName);
      }
    };
    addRepoFromMeta(coordMeta);
    for (const row of alive) {
      addRepoFromMeta(row.meta);
    }
    const suggestedRepos = [...repos];
    const authInfo = await githubConnectorPlugin.checkAuth(
      this.hostContext(),
      suggestedRepos[0] ?? 'LodyAI/Lody'
    );
    return {
      github: {
        status: authInfo.status,
        ...(authInfo.source ? { source: authInfo.source } : {}),
        suggestedRepos,
      },
    };
  }

  private scheduleNextTick(delayMs?: number): void {
    if (this.disposed || !this.started) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.now();
    let computedDelay = delayMs;
    if (computedDelay === undefined) {
      const nextPoll = this.connection.raw
        .prepare(
          `SELECT MIN(next_poll_at) AS due FROM coordinator_triggers WHERE enabled = 1 AND next_poll_at > 0`
        )
        .get() as { due: number | null } | undefined;
      const nextCoalesce = this.connection.raw
        .prepare(
          `SELECT MIN(coalesce_due_at) AS due FROM coordinator_triggers WHERE enabled = 1 AND coalesce_due_at > 0`
        )
        .get() as { due: number | null } | undefined;
      const candidates = [nextPoll?.due, nextCoalesce?.due].filter(
        (v): v is number => typeof v === 'number' && v > 0
      );
      computedDelay =
        candidates.length > 0
          ? Math.max(TICK_MIN_SLEEP_MS, Math.min(...candidates) - now)
          : TICK_IDLE_SLEEP_MS;
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.runPass();
      },
      Math.min(TICK_IDLE_SLEEP_MS, Math.max(250, computedDelay))
    );
  }

  async runPass(): Promise<void> {
    if (this.disposed || this.runningPass) return;
    this.runningPass = true;
    try {
      const now = this.now();
      const duePolls = this.connection.raw
        .prepare(
          `SELECT * FROM coordinator_triggers WHERE enabled = 1 AND next_poll_at > 0 AND next_poll_at <= ? ORDER BY next_poll_at ASC LIMIT 16`
        )
        .all(now) as StoredTriggerRow[];

      for (const row of duePolls) {
        if (this.disposed) return;
        try {
          await this.evaluateTriggerRow(row, { immediateFlush: false });
        } catch (error) {
          this.deps.logger.debug(
            `[coordinator-triggers] Poll pass failed for ${row.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      const flushTime = this.now();
      const dueBatches = this.connection.raw
        .prepare(
          `SELECT * FROM coordinator_triggers WHERE enabled = 1 AND coalesce_due_at > 0 AND coalesce_due_at <= ? ORDER BY coalesce_due_at ASC LIMIT 16`
        )
        .all(flushTime) as StoredTriggerRow[];

      for (const row of dueBatches) {
        if (this.disposed) return;
        await this.flushPendingBatch(row);
      }
    } finally {
      this.runningPass = false;
      if (!this.disposed) {
        this.scheduleNextTick();
      }
    }
  }

  private async evaluateTriggerRow(
    row: StoredTriggerRow,
    options: { immediateFlush: boolean }
  ): Promise<number> {
    if (!row.config_json) return 0;
    const configParsed = ConnectorTriggerConfigSchema.safeParse(JSON.parse(row.config_json));
    if (!configParsed.success) return 0;
    const config = configParsed.data;
    const runtime = CONNECTOR_RUNTIMES[config.pluginId];
    if (!runtime) return 0;

    const now = this.now();
    const pollIntervalMs = config.pluginId === 'github' ? config.pollIntervalSec * 1_000 : 60_000;
    const prevCursor = row.cursor_json ? (JSON.parse(row.cursor_json) as unknown) : null;

    try {
      const { events, nextCursor } = await runtime.pollDelta(
        this.hostContext(),
        config,
        prevCursor,
        now
      );

      const existingPending = parsePendingEvents(row.pending_events_json);
      const seenDedup = new Set(existingPending.map((ev) => ev.dedupKey));
      const merged = [...existingPending];
      for (const ev of events) {
        if (!seenDedup.has(ev.dedupKey)) {
          seenDedup.add(ev.dedupKey);
          merged.push(ev);
        }
      }
      const bounded = merged.slice(-MAX_PENDING_EVENTS_PER_BATCH);
      const coalesceDue =
        bounded.length === 0
          ? 0
          : options.immediateFlush
            ? now
            : row.coalesce_due_at > 0
              ? row.coalesce_due_at
              : now + COALESCE_WINDOW_MS;

      this.connection.withImmediate(() => {
        this.connection.raw
          .prepare(
            `UPDATE coordinator_triggers
             SET cursor_json = ?, pending_events_json = ?, coalesce_due_at = ?, next_poll_at = ?, last_check_at = ?, last_error = NULL, updated_at = ?
             WHERE id = ?`
          )
          .run(
            JSON.stringify(nextCursor),
            JSON.stringify(bounded),
            coalesceDue,
            row.enabled ? now + pollIntervalMs : 0,
            now,
            now,
            row.id
          );
      });

      const refreshed = this.getRow(row.id);
      if (refreshed) {
        await this.syncTriggerDoc(refreshed);
        if (options.immediateFlush && bounded.length > 0) {
          await this.flushPendingBatch(refreshed);
        }
      }
      return events.length;
    } catch (error) {
      const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.connection.withImmediate(() => {
        this.connection.raw
          .prepare(
            `UPDATE coordinator_triggers
             SET next_poll_at = ?, last_check_at = ?, last_error = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(row.enabled ? now + pollIntervalMs : 0, now, errMsg, now, row.id);
      });
      const refreshed = this.getRow(row.id);
      if (refreshed) await this.syncTriggerDoc(refreshed);
      throw error;
    }
  }

  private async flushPendingBatch(row: StoredTriggerRow): Promise<void> {
    const pending = parsePendingEvents(row.pending_events_json);
    if (pending.length === 0) {
      this.connection.withImmediate(() => {
        this.connection.raw
          .prepare(`UPDATE coordinator_triggers SET coalesce_due_at = 0 WHERE id = ?`)
          .run(row.id);
      });
      return;
    }

    const sessionId = row.coordinator_session_id as SessionId;
    const roomId = getSessionRoomId(sessionId);
    const record = await this.deps.manager.repo.getDocMeta(roomId);
    const meta = record?.meta as SessionMeta | undefined;

    if (!record || !meta || isLoroRepoDocDeleted(record) || meta.isArchived) {
      const now = this.now();
      this.connection.withImmediate(() => {
        this.connection.raw
          .prepare(
            `UPDATE coordinator_triggers
             SET enabled = 0, next_poll_at = 0, coalesce_due_at = 0, last_error = 'Coordinator session archived or unavailable', updated_at = ?
             WHERE id = ?`
          )
          .run(now, row.id);
      });
      return;
    }

    if (meta.collaborationStopped) {
      this.connection.withImmediate(() => {
        this.connection.raw
          .prepare(`UPDATE coordinator_triggers SET coalesce_due_at = ? WHERE id = ?`)
          .run(this.now() + 15_000, row.id);
      });
      return;
    }

    const policy = parsePolicy(row.policy_json);
    const config = row.config_json
      ? ConnectorTriggerConfigSchema.safeParse(JSON.parse(row.config_json))
      : null;
    const summary = config?.success ? formatConnectorTriggerSummary(config.data) : undefined;
    const prompt = formatCoordinatorTriggerWakePrompt({
      triggerId: row.id,
      pluginId: row.plugin_id as ConnectorPluginId,
      title: row.title,
      ...(summary ? { summary } : {}),
      policy,
      instruction: row.instruction,
      events: pending,
    });

    const doc = await this.deps.manager.getOrCreateSessionDoc(sessionId);
    const backend = await createSessionBackend(doc, meta);
    const historyCount = await backend.readHistoryCount();
    const startIdx = Math.max(0, historyCount - 12);
    const recentRows = await backend.readHistoryDirectory(startIdx, historyCount);
    const defaults = resolveTurnDispatchDefaultsFromHistory(
      recentRows.flatMap((entry) =>
        entry.scalars?.role === 'user'
          ? [
              {
                role: 'user' as const,
                inputConfig: normalizeSessionTurnInputConfig(entry.inputConfig),
              },
            ]
          : []
      ),
      meta
    );

    const cliType = meta.cliType;
    const agentType = meta.agentType;
    if (!cliType || !agentType) {
      throw new Error('Coordinator session runtime configuration unavailable');
    }

    const now = this.now();
    const userTurnId = randomUUID();
    const acpSessionConfig = {
      ...normalizeSessionTurnInputConfig(defaults),
      prompt,
      inputBlocks: [{ type: 'text' as const, text: prompt }],
      cliType,
      agentType,
      ...(meta.acpSessionId ? { resume: meta.acpSessionId } : {}),
    };

    const e2eeIntent = this.deps.manager.isEncryptedWorkspace()
      ? await this.deps.manager.signMachineInput({
          sessionId,
          targetMachineId: this.deps.machineId,
          userTurnId,
          inputConfig: acpSessionConfig,
        })
      : undefined;

    this.connection.withImmediate(() => {
      this.connection.raw
        .prepare(
          `INSERT OR REPLACE INTO coordinator_trigger_turns (
            user_turn_id, coordinator_session_id, trigger_id, policy_json, dispatched_children, created_at
          ) VALUES (?, ?, ?, ?, 0, ?)`
        )
        .run(userTurnId, sessionId, row.id, JSON.stringify(policy), now);
      this.connection.raw
        .prepare(
          `UPDATE coordinator_triggers
           SET pending_events_json = '[]', coalesce_due_at = 0, last_triggered_at = ?, last_error = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(now, now, row.id);
    });

    await doc.pushMessageQueue({
      task: prompt,
      userId: row.owner_user_id,
      userTurnId,
      operationId: `trigger:${row.id}:${userTurnId}`,
      timestamp: new Date(now).toISOString(),
      isEditing: false,
      editingStartedAt: undefined,
      project: meta.project,
      acpSessionConfig,
      e2eeIntent,
    });
    await this.signalQueue(doc, meta);

    const refreshed = this.getRow(row.id);
    if (refreshed) await this.syncTriggerDoc(refreshed);
  }

  private async signalQueue(doc: SessionDocument, meta: SessionMeta): Promise<void> {
    if (!doc.handle) return;
    const frontiers = doc.handle.doc.frontiers();
    const updatedAt = Math.max(
      this.now(),
      (meta.messageQueueUpdatedAt ?? 0) + 1,
      (meta.messageQueueCheckedAt ?? 0) + 1
    );
    await this.deps.manager.repo.upsertDocMeta(doc.roomId, {
      messageQueueUpdatedAt: updatedAt,
      messageQueueUpdateVersion: { updatedAt, frontiers },
    });
    await this.deps.manager.repo.flush();
  }

  async assertDelegationAllowed(args: {
    sessionId: SessionId;
    sourceTurnId: string | undefined;
    requestedCount: number;
    requestedRoleIds?: readonly string[];
    requireRoleWhenAllowlisted?: boolean;
  }): Promise<void> {
    const {
      sessionId,
      sourceTurnId,
      requestedCount,
      requestedRoleIds = [],
      requireRoleWhenAllowlisted = true,
    } = args;
    if (!sourceTurnId) return;

    const record = await this.deps.manager.repo.getDocMeta(getSessionRoomId(sessionId));
    const meta = record?.meta as SessionMeta | undefined;
    if (!meta || !isCoordinatorSession(meta)) return;

    let policy: CoordinatorTriggerPolicy | null = null;
    let triggerIdForPrompt: string | undefined;
    let turnPolicyRow = this.connection.raw
      .prepare(`SELECT * FROM coordinator_trigger_turns WHERE user_turn_id = ?`)
      .get(sourceTurnId) as StoredTurnPolicyRow | undefined;

    if (turnPolicyRow) {
      policy = parsePolicy(turnPolicyRow.policy_json);
      triggerIdForPrompt = turnPolicyRow.trigger_id;
    } else {
      const doc = await this.deps.manager.getOrCreateSessionDoc(sessionId);
      const backend = await createSessionBackend(doc, meta);
      const read = await backend.readTurn(sourceTurnId);
      const schedRun =
        read.state === 'ready' && read.turn.scheduleRun && typeof read.turn.scheduleRun === 'object'
          ? (read.turn.scheduleRun as { scheduleId?: unknown })
          : null;
      if (schedRun && typeof schedRun.scheduleId === 'string' && schedRun.scheduleId) {
        const schedTriggerId = schedulePolicyTriggerId(schedRun.scheduleId);
        triggerIdForPrompt = schedTriggerId;
        const schedPolicyRow = this.getRow(schedTriggerId);
        policy = schedPolicyRow
          ? parsePolicy(schedPolicyRow.policy_json)
          : { mode: 'summarize_and_notify', maxChildrenPerRun: 2 };
      }
    }

    if (!policy) return;

    if (policy.mode === 'summarize_and_notify') {
      const upgradeHint = triggerIdForPrompt
        ? ` Attach a card with { kind: "coordinator_prompt", prompt: "..." } to handle once, or { kind: "client_command", command: "trigger.grant_delegate", params: { triggerId: "${triggerIdForPrompt}", prompt: "..." } } so the user can allow automatic child creation next time.`
        : '';
      throw new Error(
        `TRIGGER_NOTIFY_ONLY: This trigger is configured for Notify-Only (summarize_and_notify) and cannot create or message child conversations automatically. Send a concise summary to the user via lody_coordinator_send_message instead.${upgradeHint}`
      );
    }

    if (requireRoleWhenAllowlisted && policy.allowedRoleIds && policy.allowedRoleIds.length > 0) {
      if (requestedRoleIds.length < requestedCount) {
        throw new Error(
          `TRIGGER_ROLE_NOT_ALLOWED: This trigger restricts child creation to Role IDs (${policy.allowedRoleIds.join(', ')}); pass agentRoleId explicitly.`
        );
      }
      const allowed = new Set(policy.allowedRoleIds);
      for (const roleId of requestedRoleIds) {
        if (!allowed.has(roleId)) {
          throw new Error(
            `TRIGGER_ROLE_NOT_ALLOWED: Role "${roleId}" is outside this trigger's allowedRoleIds (${policy.allowedRoleIds.join(', ')}).`
          );
        }
      }
    }

    const cap = policy.maxChildrenPerRun ?? 2;
    const alreadyDispatched = turnPolicyRow?.dispatched_children ?? 0;
    if (alreadyDispatched + requestedCount > cap) {
      throw new Error(
        `TRIGGER_BUDGET_EXCEEDED: This trigger allows at most ${cap} child dispatch(es) per run (already used: ${alreadyDispatched}).`
      );
    }

    const now = this.now();
    this.connection.withImmediate(() => {
      if (turnPolicyRow) {
        this.connection.raw
          .prepare(
            `UPDATE coordinator_trigger_turns SET dispatched_children = dispatched_children + ? WHERE user_turn_id = ?`
          )
          .run(requestedCount, sourceTurnId);
      } else {
        this.connection.raw
          .prepare(
            `INSERT INTO coordinator_trigger_turns (
              user_turn_id, coordinator_session_id, trigger_id, policy_json, dispatched_children, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            sourceTurnId,
            sessionId,
            triggerIdForPrompt ?? 'schedule',
            JSON.stringify(policy),
            requestedCount,
            now
          );
      }
    });
  }
}
