import {
  collectViewedSessionIdsFromPresence,
  getServerNow,
  isDirectLocalProject,
  type SessionId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { buildPrPollBatchQuery, type PrPollBatchQuery } from './graphql-batch-builder';
import type {
  GitHubGraphQlClient,
  ParsedPrPollBatch,
  PrObservation,
  PrPollQueryOutcome,
} from './github-graphql-client';
import type { PrPollerConfig } from './pr-poller-config';
import {
  applyProviderSafetyFloor,
  fullScopeQuota,
  isScopeFrozen,
  nextRepoCooldown,
  refillScopeQuota,
  scopeQuotaAvailableAtMs,
  spendScopeQuota,
} from './pr-poll-quota';
import {
  emptyPrPollerState,
  type PrPollerState,
  type PrPollerStateStore,
} from './pr-poller-state';
import { selectHighOwners } from './pr-poll-priority';
import {
  computeNextWakeAtMs,
  computeTargetDueAtMs,
  pickNextBatch,
  planDueBatches,
  prPollTargetKey,
  type PrPollBatchPlan,
  type SchedulableTarget,
} from './pr-poll-select';
import {
  computeDiscoveryFingerprint,
  enumeratePrPollTargets,
  resolveOwnerRepositoryContext,
  type AliveSessionMeta,
  type PrPollSessionEntry,
} from './pr-poll-targets';
import { planAssociation, planPullRequestMetaWrite } from './pr-poll-writeback';
import type { ResolvedGitHubCredential } from './github-credential-resolver';
import type { PrPollMetaPatch, PrPollerWorkspaceHandle } from './pr-poller-workspace';

/**
 * Thin orchestrator for the PR reconciler (spec
 * `specs/pr-status-reconciler.md`). All decisions live in the pure modules:
 * targets (`pr-poll-targets`), priority (`pr-poll-priority`), quota
 * (`pr-poll-quota`), scheduling (`pr-poll-select`), provider projection
 * (`github-graphql-client` pure exports), and write-back planning
 * (`pr-poll-writeback`). This class only wires facts → decisions → effects:
 * it subscribes to workspace facts, keeps the persisted scheduling state,
 * executes planned GitHub/association/metadata effects, and feeds results
 * back into the next pure pass.
 *
 * Dueness is recomputed from facts on every wake — nothing here stores a
 * "next poll time", so priority changes (viewing, activity) take effect on
 * the next wake without invalidation bookkeeping. A target's success stamp
 * (and a discovery fingerprint) is committed only after every effect the
 * round required (association, metadata write-back) actually succeeded;
 * failed rounds keep the target due and retry — GitHub query included — at
 * the attempt floor.
 */

/** One dynamic wake recomputes; the cap re-checks presence TTL / activity expiry. */
const MAX_WAKE_INTERVAL_MS = 30_000;
const NEW_VIEWER_DEBOUNCE_MS = 1_000;
const META_UPDATE_DEBOUNCE_MS = 2_000;
const CREDENTIAL_RETRY_MS = 60_000;
const CREDENTIAL_LOG_THROTTLE_MS = 10 * 60_000;
/** Freeze when GitHub signals a limit without a usable resetAt. */
const DEFAULT_RATE_LIMIT_FREEZE_MS = 10 * 60_000;
/**
 * Bounded wait for a workspace repo's initial meta sync. Each workspace waits
 * independently; only the post-sync enumeration enters the shared poll chain.
 * On timeout the workspace is NOT enumerated (pre-sync metas would read as
 * "no PR"); initialization is retried instead.
 */
export const INITIAL_SYNC_WAIT_MS = 60_000;
export const INITIAL_SYNC_RETRY_MS = 60_000;

export type PrPollSchedulerCounters = {
  calls: number;
  pointsSpent: number;
  corrections: number;
  discoveries: number;
  skips: number;
};

type WorkspaceRuntime = {
  handle: PrPollerWorkspaceHandle;
  sessionMetas: Map<SessionId, AliveSessionMeta>;
  entries: PrPollSessionEntry[];
  pendingSessionIds: Set<SessionId>;
  ready: boolean;
  unsubscribers: Array<() => void>;
  oneShotTimers: Set<NodeJS.Timeout>;
  metadataUpdateTimer: NodeJS.Timeout | null;
  presenceWakeTimer: NodeJS.Timeout | null;
  lastCredentialLogAtMs: number;
};

/** Per-owner effect outcome of one applied batch (gates the success stamps). */
type OwnerEffectResult = {
  statusOk: boolean;
  discoveryOk: boolean;
};

type MetadataUpdateResult = {
  changed: boolean;
  failed: boolean;
};

export type PrPollSchedulerDeps = {
  config: PrPollerConfig;
  stateStore: PrPollerStateStore;
  logger: Logger;
  client: Pick<GitHubGraphQlClient, 'executeBatch'>;
  nowMs?: () => number;
};

export class PrPollScheduler {
  readonly counters: PrPollSchedulerCounters = {
    calls: 0,
    pointsSpent: 0,
    corrections: 0,
    discoveries: 0,
    skips: 0,
  };

  private readonly nowMs: () => number;
  private readonly workspaces = new Map<string, WorkspaceRuntime>();
  private state: PrPollerState = emptyPrPollerState();
  /** In-memory attempt stamps (spacing between attempts, incl. failures). */
  private readonly lastAttemptAtMs = new Map<string, number>();
  /** Anti-starvation streak across wakes (see `pickNextBatch`). */
  private consecutiveHighDispatches = 0;
  private chain: Promise<void> = Promise.resolve();
  private wakeTimer: NodeJS.Timeout | null = null;
  private wakeAtMs: number | null = null;
  private started = false;

  constructor(private readonly deps: PrPollSchedulerDeps) {
    this.nowMs = deps.nowMs ?? getServerNow;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    try {
      this.state = this.deps.stateStore.load();
    } catch (error) {
      this.deps.logger.debug(
        `[pr-poller] Failed to load state; starting fresh: ${formatErrorMessage(error)}`
      );
      this.state = emptyPrPollerState();
    }
    this.scheduleWake();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.clearWake();
    for (const workspaceId of Array.from(this.workspaces.keys())) {
      this.unregisterWorkspace(workspaceId);
    }
    this.enqueue(async () => {
      this.deps.stateStore.close();
    });
  }

  registerWorkspace(handle: PrPollerWorkspaceHandle): void {
    if (!this.started || this.workspaces.has(handle.workspaceId)) {
      return;
    }
    const runtime: WorkspaceRuntime = {
      handle,
      sessionMetas: new Map(),
      entries: [],
      pendingSessionIds: new Set(),
      ready: false,
      unsubscribers: [],
      oneShotTimers: new Set(),
      metadataUpdateTimer: null,
      presenceWakeTimer: null,
      lastCredentialLogAtMs: 0,
    };
    this.workspaces.set(handle.workspaceId, runtime);

    const unsubscribePresence = handle.subscribePresence(() => {
      this.onPresenceChanged(runtime);
    });
    if (unsubscribePresence) {
      runtime.unsubscribers.push(unsubscribePresence);
    } else {
      this.deps.logger.debug(
        `[pr-poller] No presence room for workspace ${handle.workspaceId}; view-triggered polls disabled`
      );
    }
    const unsubscribeMeta = handle.watchSessionMetadata((sessionId) => {
      this.onSessionMetadataChanged(runtime, sessionId);
    });
    if (unsubscribeMeta) {
      runtime.unsubscribers.push(unsubscribeMeta);
    }

    this.deps.logger.debug(`[pr-poller] Registered workspace ${handle.workspaceId}`);
    // Wait for the repo's initial sync before first enumeration so a
    // not-yet-synced `pullRequests` is not misread as "no PR". The wait stays
    // outside the shared poll chain: a disconnected workspace must not delay
    // healthy workspaces while its timeout elapses.
    const initialize = (): void => {
      void (async () => {
        let synced = false;
        try {
          synced = await handle.waitForInitialSync(INITIAL_SYNC_WAIT_MS);
        } catch (error) {
          this.deps.logger.debug(
            `[pr-poller] Initial meta sync wait failed for ${handle.workspaceId}: ${formatErrorMessage(error)}`
          );
        }
        if (!this.started || this.workspaces.get(handle.workspaceId) !== runtime) {
          return;
        }
        if (!synced) {
          this.deps.logger.debug(
            `[pr-poller] Initial meta sync not confirmed for ${handle.workspaceId} within ${INITIAL_SYNC_WAIT_MS / 1000}s; retrying in ${INITIAL_SYNC_RETRY_MS / 1000}s`
          );
          const timer = setTimeout(() => {
            runtime.oneShotTimers.delete(timer);
            if (!this.started || this.workspaces.get(handle.workspaceId) !== runtime) {
              return;
            }
            initialize();
          }, INITIAL_SYNC_RETRY_MS);
          timer.unref?.();
          runtime.oneShotTimers.add(timer);
          return;
        }
        this.enqueue(async () => {
          if (!this.started || this.workspaces.get(handle.workspaceId) !== runtime) {
            return;
          }
          const projected = await this.initializeWorkspaceProjection(runtime);
          if (!projected) {
            const timer = setTimeout(() => {
              runtime.oneShotTimers.delete(timer);
              if (!this.started || this.workspaces.get(handle.workspaceId) !== runtime) {
                return;
              }
              initialize();
            }, INITIAL_SYNC_RETRY_MS);
            timer.unref?.();
            runtime.oneShotTimers.add(timer);
            return;
          }
          runtime.ready = true;
          if (runtime.pendingSessionIds.size > 0) {
            this.scheduleMetadataUpdate(runtime);
          }
          this.scheduleWake();
        });
      })();
    };
    initialize();
  }

  unregisterWorkspace(workspaceId: string): void {
    const runtime = this.workspaces.get(workspaceId);
    if (!runtime) {
      return;
    }
    this.workspaces.delete(workspaceId);
    for (const unsubscribe of runtime.unsubscribers) {
      unsubscribe();
    }
    for (const timer of runtime.oneShotTimers) {
      clearTimeout(timer);
    }
    if (runtime.metadataUpdateTimer) {
      clearTimeout(runtime.metadataUpdateTimer);
    }
    if (runtime.presenceWakeTimer) {
      clearTimeout(runtime.presenceWakeTimer);
    }
    this.deps.logger.debug(`[pr-poller] Unregistered workspace ${workspaceId}`);
  }

  /** Test/debug introspection: in-memory scheduling state. */
  peekState(): PrPollerState {
    return this.state;
  }

  /** Flush pending async work, including work appended while draining; used by tests. */
  async settle(): Promise<void> {
    let previous: Promise<void>;
    do {
      previous = this.chain;
      await previous;
    } while (this.chain !== previous);
  }

  // ------------------------------------------------------------------ facts

  /**
   * Viewing/activity only shift dueness (computed fresh on every wake), so a
   * presence change just needs a debounced wake — no state invalidation.
   */
  private onPresenceChanged(runtime: WorkspaceRuntime): void {
    if (!this.started || !runtime.ready || runtime.presenceWakeTimer) {
      return;
    }
    runtime.presenceWakeTimer = setTimeout(() => {
      runtime.presenceWakeTimer = null;
      this.enqueue(() => this.runWake());
    }, NEW_VIEWER_DEBOUNCE_MS);
    runtime.presenceWakeTimer.unref?.();
  }

  private onSessionMetadataChanged(runtime: WorkspaceRuntime, sessionId: SessionId): void {
    if (!this.started) {
      return;
    }
    runtime.pendingSessionIds.add(sessionId);
    if (runtime.ready) {
      this.scheduleMetadataUpdate(runtime);
    }
  }

  private scheduleMetadataUpdate(runtime: WorkspaceRuntime): void {
    if (!this.started || !runtime.ready || runtime.metadataUpdateTimer) {
      return;
    }
    runtime.metadataUpdateTimer = setTimeout(() => {
      runtime.metadataUpdateTimer = null;
      this.enqueue(async () => {
        if (!this.started || this.workspaces.get(runtime.handle.workspaceId) !== runtime) {
          return;
        }
        const result = await this.applyPendingSessionMetadata(runtime);
        if (result.changed) {
          await this.runWake();
        }
      });
    }, META_UPDATE_DEBOUNCE_MS);
    runtime.metadataUpdateTimer.unref?.();
  }

  private async initializeWorkspaceProjection(runtime: WorkspaceRuntime): Promise<boolean> {
    let sessions;
    try {
      sessions = await runtime.handle.listAliveSessionMetas();
    } catch (error) {
      this.deps.logger.debug(
        `[pr-poller] Failed to enumerate sessions for ${runtime.handle.workspaceId}: ${formatErrorMessage(error)}`
      );
      return false;
    }
    runtime.sessionMetas = new Map(sessions.map((session) => [session.sessionId, session]));

    // The watcher is attached before initial sync. Re-read ids changed while
    // the full snapshot was materialized so the first ready projection cannot
    // lose an update (or deletion) that raced the initial scan.
    const pendingResult = await this.applyPendingSessionMetadata(runtime);
    if (pendingResult.failed) {
      return false;
    }
    this.projectRuntimeEntries(runtime);
    return true;
  }

  private async applyPendingSessionMetadata(
    runtime: WorkspaceRuntime
  ): Promise<MetadataUpdateResult> {
    if (runtime.pendingSessionIds.size === 0) {
      return { changed: false, failed: false };
    }
    const sessionIds = Array.from(runtime.pendingSessionIds);
    runtime.pendingSessionIds.clear();
    const results = await Promise.allSettled(
      sessionIds.map((sessionId) => runtime.handle.readOwnerMeta(sessionId))
    );
    let changed = false;
    let failed = false;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const sessionId = sessionIds[index];
      if (!result || !sessionId) {
        continue;
      }
      if (result.status === 'rejected') {
        failed = true;
        runtime.pendingSessionIds.add(sessionId);
        this.deps.logger.debug(
          `[pr-poller] Failed to refresh session ${sessionId} for ${runtime.handle.workspaceId}: ${formatErrorMessage(result.reason)}`
        );
        continue;
      }
      const meta = result.value;
      if (!meta || meta.machineId !== runtime.handle.machineId) {
        changed = runtime.sessionMetas.delete(sessionId) || changed;
        continue;
      }
      runtime.sessionMetas.set(sessionId, { sessionId, meta });
      changed = true;
    }
    if (changed) {
      this.projectRuntimeEntries(runtime);
    }
    if (runtime.ready && runtime.pendingSessionIds.size > 0) {
      this.scheduleMetadataUpdate(runtime);
    }
    return { changed, failed };
  }

  private projectRuntimeEntries(runtime: WorkspaceRuntime): void {
    runtime.entries = enumeratePrPollTargets(
      Array.from(runtime.sessionMetas.values()),
      this.ownerFingerprints(runtime.handle.workspaceId)
    );
  }

  private refreshRuntimeFingerprintProjection(runtime: WorkspaceRuntime): void {
    if (runtime.ready) {
      this.projectRuntimeEntries(runtime);
    }
  }

  private ownerFingerprints(workspaceId: string): Record<string, string> {
    const prefix = `${workspaceId}:`;
    const fingerprints: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.state.discoveryFingerprints)) {
      if (key.startsWith(prefix)) {
        fingerprints[key.slice(prefix.length)] = value;
      }
    }
    return fingerprints;
  }

  /** Facts → schedulable targets: one pure pass over all ready workspaces. */
  private buildTargets(nowMs: number): SchedulableTarget[] {
    const { config } = this.deps;
    const targets: SchedulableTarget[] = [];
    for (const runtime of this.workspaces.values()) {
      if (!runtime.ready) {
        continue;
      }
      const viewed = collectViewedSessionIdsFromPresence(
        runtime.handle.getPresenceStates() ?? {},
        nowMs
      );
      const highOwners = selectHighOwners(runtime.entries, viewed, nowMs, {
        activityWindowMs: config.activityWindowMs,
        highOwnerCap: config.highOwnerCap,
      });
      for (const entry of runtime.entries) {
        const lane = highOwners.has(entry.ownerSessionId) ? 'high' : 'low';
        for (const statusTarget of entry.statusTargets) {
          targets.push(
            this.makeTarget(runtime, entry, {
              kind: 'status',
              repoFullName: statusTarget.repoFullName,
              lane,
              desiredIntervalMs:
                lane === 'high' ? config.highIntervalMs : config.lowStatusIntervalMs,
              qualifier: String(statusTarget.prNumber),
              status: statusTarget,
            })
          );
        }
        if (entry.discoveryTarget) {
          // A discovery target with open/draft PRs rides the status cadence
          // (same batch, zero extra requests); a bare discovery target uses
          // the slower discovery cadence.
          const lowIntervalMs =
            entry.statusTargets.length > 0
              ? config.lowStatusIntervalMs
              : config.lowDiscoveryIntervalMs;
          targets.push(
            this.makeTarget(runtime, entry, {
              kind: 'discovery',
              repoFullName: entry.discoveryTarget.repoFullName,
              lane,
              desiredIntervalMs: lane === 'high' ? config.highIntervalMs : lowIntervalMs,
              qualifier: entry.discoveryTarget.branch,
              discovery: entry.discoveryTarget,
            })
          );
        }
      }
    }
    return targets;
  }

  private makeTarget(
    runtime: WorkspaceRuntime,
    entry: PrPollSessionEntry,
    args: Pick<
      SchedulableTarget,
      'kind' | 'repoFullName' | 'lane' | 'desiredIntervalMs' | 'status' | 'discovery'
    > & { qualifier: string }
  ): SchedulableTarget {
    const { qualifier, ...target } = args;
    const key = prPollTargetKey(
      runtime.handle.workspaceId,
      entry.ownerSessionId,
      args.repoFullName,
      args.kind,
      qualifier
    );
    return {
      ...target,
      key,
      workspaceId: runtime.handle.workspaceId,
      ownerSessionId: entry.ownerSessionId,
      minIntervalMs:
        args.lane === 'high' ? this.deps.config.highIntervalMs : this.deps.config.lowMinIntervalMs,
      lastSuccessAtMs: this.state.targets[key]?.lastSuccessAtMs ?? null,
      lastAttemptAtMs: this.lastAttemptAtMs.get(key) ?? null,
    };
  }

  // -------------------------------------------------------------- wake loop

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((error: unknown) => {
      this.deps.logger.debug(`[pr-poller] Poll chain error: ${formatErrorMessage(error)}`);
    });
  }

  private clearWake(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.wakeAtMs = null;
  }

  private scheduleWake(): void {
    if (!this.started) {
      return;
    }
    const nowMs = this.nowMs();
    const targets = this.buildTargets(nowMs);
    // Already-due targets (fresh registration, restart catch-up) run now;
    // otherwise wake at the earliest future dueness, capped.
    const anyDue = targets.some((target) => computeTargetDueAtMs(target) <= nowMs);
    this.scheduleWakeAt(
      anyDue ? nowMs : computeNextWakeAtMs(targets, [], nowMs, MAX_WAKE_INTERVAL_MS)
    );
  }

  private scheduleWakeAt(atMs: number): void {
    if (!this.started) {
      return;
    }
    const delayMs = Math.max(0, atMs - this.nowMs());
    if (this.wakeAtMs !== null && this.wakeAtMs <= this.nowMs() + delayMs) {
      return;
    }
    this.clearWake();
    if (delayMs === 0) {
      // Due now: run on the poll chain directly instead of a 0-delay timer.
      // Cannot livelock — every dispatched batch stamps lastAttempt, so the
      // next wake computation moves into the future.
      this.enqueue(() => this.runWake());
      return;
    }
    this.wakeAtMs = this.nowMs() + delayMs;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeAtMs = null;
      this.enqueue(() => this.runWake());
    }, delayMs);
    this.wakeTimer.unref?.();
  }

  private async runWake(): Promise<void> {
    const nowMs = this.nowMs();
    const targets = this.buildTargets(nowMs);
    this.pruneState(targets);
    const remaining: PrPollBatchPlan[] = planDueBatches(targets, nowMs);
    const deferredHints: number[] = [];
    while (remaining.length > 0) {
      const batch = pickNextBatch(
        remaining,
        this.consecutiveHighDispatches,
        this.deps.config.lowLaneEveryNBatches
      );
      if (!batch) {
        break;
      }
      remaining.splice(remaining.indexOf(batch), 1);
      const dispatched = await this.pollBatch(batch, deferredHints);
      if (dispatched) {
        this.consecutiveHighDispatches =
          batch.lane === 'high' ? this.consecutiveHighDispatches + 1 : 0;
      }
    }
    const afterMs = this.nowMs();
    this.scheduleWakeAt(
      computeNextWakeAtMs(this.buildTargets(afterMs), deferredHints, afterMs, MAX_WAKE_INTERVAL_MS)
    );
  }

  /** Bound the persisted state to currently-enumerated targets of ready workspaces. */
  private pruneState(targets: readonly SchedulableTarget[]): void {
    const readyWorkspaceIds = new Set(
      Array.from(this.workspaces.values())
        .filter((runtime) => runtime.ready)
        .map((runtime) => runtime.handle.workspaceId)
    );
    const validKeys = new Set(targets.map((target) => target.key));
    for (const key of Object.keys(this.state.targets)) {
      const workspaceId = key.split('|')[0] ?? '';
      if (readyWorkspaceIds.has(workspaceId) && !validKeys.has(key)) {
        delete this.state.targets[key];
        this.deps.stateStore.deleteTarget(key);
      }
    }
    const validOwners = new Set<string>();
    for (const runtime of this.workspaces.values()) {
      if (!runtime.ready) {
        continue;
      }
      for (const entry of runtime.entries) {
        validOwners.add(`${runtime.handle.workspaceId}:${entry.ownerSessionId}`);
      }
    }
    for (const key of Object.keys(this.state.discoveryFingerprints)) {
      const workspaceId = key.split(':')[0] ?? '';
      if (readyWorkspaceIds.has(workspaceId) && !validOwners.has(key)) {
        delete this.state.discoveryFingerprints[key];
        this.deps.stateStore.deleteDiscoveryFingerprint(key);
      }
    }
  }

  // -------------------------------------------------------------- one batch

  /** Returns true when a GitHub request was actually dispatched. */
  private async pollBatch(batch: PrPollBatchPlan, deferredHints: number[]): Promise<boolean> {
    const { config, logger } = this.deps;
    const runtime = this.workspaces.get(batch.workspaceId);
    if (!runtime) {
      return false;
    }
    const nowMs = this.nowMs();
    const credential = await runtime.handle.resolveCredential(batch.repoFullName);
    if (!credential) {
      if (nowMs - runtime.lastCredentialLogAtMs >= CREDENTIAL_LOG_THROTTLE_MS) {
        runtime.lastCredentialLogAtMs = nowMs;
        logger.debug(
          `[pr-poller] No GitHub credential for ${batch.repoFullName} (workspace ${batch.workspaceId}); retrying in ${CREDENTIAL_RETRY_MS / 1000}s`
        );
      }
      this.markAttempt(batch.targets, nowMs);
      deferredHints.push(nowMs + CREDENTIAL_RETRY_MS);
      return false;
    }

    const gate = this.preflightScope(credential, batch.repoFullName, deferredHints);
    if (!gate) {
      this.counters.skips += 1;
      return false;
    }

    const statusTargets = batch.targets.flatMap((target) => (target.status ? [target.status] : []));
    const discoveryTargets = batch.targets.flatMap((target) =>
      target.discovery ? [{ branch: target.discovery.branch }] : []
    );
    const query = buildPrPollBatchQuery({
      repoFullName: batch.repoFullName,
      statusTargets: statusTargets.map((target) => ({ prNumber: target.prNumber })),
      discoveryTargets,
      maxAliases: config.maxAliasesPerQuery,
    });
    if (!query) {
      logger.debug(`[pr-poller] Malformed repo full name "${batch.repoFullName}"; skipping batch`);
      this.markAttempt(batch.targets, nowMs);
      return false;
    }
    if (query.truncatedStatusCount + query.truncatedDiscoveryCount > 0) {
      logger.debug(
        `[pr-poller] Alias budget reached for ${batch.repoFullName}; truncated targets stay due for the next batch`
      );
    }

    // Only targets whose aliases actually entered the query are "attempted";
    // truncated ones keep their dueness and form the next batch (no silent
    // starvation of the tail).
    this.markAttempt(this.includedTargets(batch, query), nowMs);
    let outcome = await this.deps.client.executeBatch(query, credential.token);
    this.counters.calls += 1;
    let outcomeScope = gate.scope;
    let outcomeCooldownKey = gate.cooldownKey;
    if (outcome.kind === 'token-invalid') {
      // Invalidate, re-fetch, retry once before entering cooldown. The
      // replacement credential may belong to a DIFFERENT scope: it must pass
      // that scope's own freeze/bucket/cooldown gates, and quota must be
      // charged to the scope that actually made the call.
      runtime.handle.invalidateCredential(batch.repoFullName, credential);
      const retried = await runtime.handle.resolveCredential(batch.repoFullName);
      if (retried) {
        const retryGate = this.preflightScope(retried, batch.repoFullName, deferredHints);
        if (!retryGate) {
          this.counters.skips += 1;
          return true;
        }
        outcome = await this.deps.client.executeBatch(query, retried.token);
        this.counters.calls += 1;
        outcomeScope = retryGate.scope;
        outcomeCooldownKey = retryGate.cooldownKey;
      }
    }
    await this.handleOutcome(
      runtime,
      batch,
      query,
      outcomeScope,
      outcomeCooldownKey,
      outcome,
      deferredHints
    );
    return true;
  }

  private includedTargets(batch: PrPollBatchPlan, query: PrPollBatchQuery): SchedulableTarget[] {
    const includedPrNumbers = new Set(query.statusAliases.map((alias) => alias.prNumber));
    const includedBranches = new Set(query.discoveryAliases.map((alias) => alias.branch));
    return batch.targets.filter((target) =>
      target.status
        ? includedPrNumbers.has(target.status.prNumber)
        : target.discovery
          ? includedBranches.has(target.discovery.branch)
          : false
    );
  }

  private markAttempt(targets: readonly SchedulableTarget[], nowMs: number): void {
    for (const target of targets) {
      this.lastAttemptAtMs.set(target.key, nowMs);
    }
  }

  /**
   * Check the persisted repo cooldown and shared credential quota immediately
   * before a GitHub call. Pure quota decisions on the in-memory state; pure
   * refill is a time function and is not written through (spend/freeze are).
   */
  private preflightScope(
    credential: ResolvedGitHubCredential,
    repoFullName: string,
    deferredHints: number[]
  ): { scope: string; cooldownKey: string } | null {
    const { config, logger } = this.deps;
    const nowMs = this.nowMs();
    const scope = credential.credentialScope;
    const cooldownKey = `${scope}:${repoFullName}`;
    const cooldown = this.state.repoCooldowns[cooldownKey];
    if (cooldown && cooldown.nextRetryAtMs > nowMs) {
      deferredHints.push(cooldown.nextRetryAtMs);
      return null;
    }

    const quota = refillScopeQuota(
      this.state.scopes[scope] ?? fullScopeQuota(nowMs, config),
      nowMs,
      config
    );
    this.state.scopes[scope] = quota;

    if (isScopeFrozen(quota, nowMs)) {
      logger.debug(`[pr-poller] Scope ${scope} is frozen; skipping ${repoFullName}`);
      deferredHints.push(quota.frozenUntilMs ?? nowMs + DEFAULT_RATE_LIMIT_FREEZE_MS);
      return null;
    }
    if (quota.tokens < 1) {
      logger.debug(
        `[pr-poller] Bucket empty for scope ${scope}; skipping ${repoFullName} until refill`
      );
      deferredHints.push(scopeQuotaAvailableAtMs(quota, nowMs, config));
      return null;
    }

    return { scope, cooldownKey };
  }

  private async handleOutcome(
    runtime: WorkspaceRuntime,
    batch: PrPollBatchPlan,
    query: PrPollBatchQuery,
    scope: string,
    cooldownKey: string,
    outcome: PrPollQueryOutcome,
    deferredHints: number[]
  ): Promise<void> {
    const { config, logger } = this.deps;
    const nowMs = this.nowMs();
    const quota =
      this.state.scopes[scope] ?? refillScopeQuota(fullScopeQuota(nowMs, config), nowMs, config);

    switch (outcome.kind) {
      case 'success': {
        const cost = outcome.batch.rateLimit?.cost ?? 1;
        this.counters.pointsSpent += cost;
        let nextQuota = spendScopeQuota(refillScopeQuota(quota, nowMs, config), cost, config);
        if (outcome.batch.rateLimit) {
          nextQuota = applyProviderSafetyFloor(
            nextQuota,
            outcome.batch.rateLimit,
            nowMs,
            config,
            DEFAULT_RATE_LIMIT_FREEZE_MS
          );
          if (nextQuota.frozenUntilMs !== quota.frozenUntilMs) {
            logger.debug(
              `[pr-poller] Scope ${scope} remaining ${outcome.batch.rateLimit.remaining}/${outcome.batch.rateLimit.limit}; freezing until ${new Date(nextQuota.frozenUntilMs ?? 0).toISOString()}`
            );
          }
        }
        this.state.scopes[scope] = nextQuota;
        this.deps.stateStore.upsertScope(scope, nextQuota);
        if (this.state.repoCooldowns[cooldownKey]) {
          delete this.state.repoCooldowns[cooldownKey];
          this.deps.stateStore.deleteRepoCooldown(cooldownKey);
        }
        const ownerResults = await this.applyResults(runtime, batch, outcome.batch);
        const fingerprintChanged = this.markRefreshedTargets(
          batch,
          query,
          outcome.batch,
          ownerResults,
          nowMs
        );
        if (fingerprintChanged) {
          // A discovery-only success updates no metadata, so no meta event
          // re-derives the entries — refresh them here so a terminal owner
          // whose context is now fingerprinted goes idle immediately.
          this.refreshRuntimeFingerprintProjection(runtime);
        }
        break;
      }
      case 'rate-limited': {
        const frozenUntilMs = outcome.resetAtMs ?? nowMs + DEFAULT_RATE_LIMIT_FREEZE_MS;
        const frozen = { ...quota, frozenUntilMs };
        this.state.scopes[scope] = frozen;
        this.deps.stateStore.upsertScope(scope, frozen);
        logger.debug(
          `[pr-poller] Rate limited on ${batch.repoFullName}; freezing scope ${scope} until ${new Date(frozenUntilMs).toISOString()}`
        );
        deferredHints.push(frozenUntilMs);
        break;
      }
      case 'repo-not-found-or-forbidden':
      case 'token-invalid': {
        const next = nextRepoCooldown(
          this.state.repoCooldowns[cooldownKey],
          outcome.kind,
          nowMs,
          config
        );
        this.state.repoCooldowns[cooldownKey] = next;
        this.deps.stateStore.upsertRepoCooldown(cooldownKey, next);
        logger.debug(
          `[pr-poller] ${outcome.kind} on ${batch.repoFullName} (failure ${next.consecutiveFailures}); ` +
            `next probe at ${new Date(next.nextRetryAtMs).toISOString()}: ${outcome.message}`
        );
        deferredHints.push(next.nextRetryAtMs);
        break;
      }
      case 'network-error': {
        logger.debug(
          `[pr-poller] Network error polling ${batch.repoFullName}; retrying after the attempt floor: ${outcome.message}`
        );
        break;
      }
    }
  }

  /**
   * Commit success stamps AFTER effects: a target counts as refreshed only
   * when (a) its aliases were actually included in the query, (b) the
   * provider result for them was valid (`ok` — a malformed alias is a
   * target-local failure, never a confirmed empty), and (c) every effect the
   * owner's round required (association, metadata write-back) succeeded.
   * A discovery success also records the owner's context fingerprint
   * (idle-terminal). Returns whether any fingerprint changed.
   */
  private markRefreshedTargets(
    batch: PrPollBatchPlan,
    query: PrPollBatchQuery,
    parsed: ParsedPrPollBatch,
    ownerResults: ReadonlyMap<SessionId, OwnerEffectResult>,
    nowMs: number
  ): boolean {
    let fingerprintChanged = false;
    for (const target of this.includedTargets(batch, query)) {
      const effects = ownerResults.get(target.ownerSessionId);
      if (target.status) {
        const prNumber = target.status.prNumber;
        const entry = parsed.pullRequests.find((candidate) => candidate.prNumber === prNumber);
        if (!entry?.ok || !effects?.statusOk) {
          continue;
        }
      } else if (target.discovery) {
        const branch = target.discovery.branch;
        const entry = parsed.discoveries.find((candidate) => candidate.branch === branch);
        if (!entry?.ok || !effects?.discoveryOk) {
          continue;
        }
        const fingerprintKey = `${target.workspaceId}:${target.ownerSessionId}`;
        const fingerprint = computeDiscoveryFingerprint(target.repoFullName, branch);
        if (this.state.discoveryFingerprints[fingerprintKey] !== fingerprint) {
          this.state.discoveryFingerprints[fingerprintKey] = fingerprint;
          this.deps.stateStore.upsertDiscoveryFingerprint(fingerprintKey, fingerprint);
          fingerprintChanged = true;
        }
      } else {
        continue;
      }
      this.state.targets[target.key] = { lastSuccessAtMs: nowMs };
      this.deps.stateStore.upsertTarget(target.key, { lastSuccessAtMs: nowMs });
    }
    return fingerprintChanged;
  }

  // -------------------------------------------------------------- write-back

  private async applyResults(
    runtime: WorkspaceRuntime,
    batch: PrPollBatchPlan,
    results: ParsedPrPollBatch
  ): Promise<Map<SessionId, OwnerEffectResult>> {
    const owners = new Map<SessionId, SchedulableTarget[]>();
    for (const target of batch.targets) {
      const list = owners.get(target.ownerSessionId);
      if (list) {
        list.push(target);
      } else {
        owners.set(target.ownerSessionId, [target]);
      }
    }
    const ownerResults = new Map<SessionId, OwnerEffectResult>();
    for (const [ownerSessionId, targets] of owners) {
      const observations: PrObservation[] = [];
      const discovered: PrObservation[] = [];
      let queriedBranch: string | null = null;
      for (const target of targets) {
        if (target.status) {
          const result = results.pullRequests.find(
            (candidate) => candidate.prNumber === target.status?.prNumber && candidate.pr
          );
          if (result?.pr) {
            // Key the observation by the meta-side URL (upsert identity).
            observations.push({ ...result.pr, url: target.status.url });
          }
        }
        const branch = target.discovery?.branch;
        if (branch) {
          queriedBranch = branch;
          const discovery = results.discoveries.find((candidate) => candidate.branch === branch);
          for (const pr of discovery?.prs ?? []) {
            discovered.push(pr);
          }
        }
      }
      ownerResults.set(
        ownerSessionId,
        await this.applyOwner(runtime, ownerSessionId, batch.repoFullName, {
          observations,
          discovered,
          queriedBranch,
        })
      );
    }
    return ownerResults;
  }

  private async applyOwner(
    runtime: WorkspaceRuntime,
    ownerSessionId: SessionId,
    repoFullName: string,
    args: {
      observations: PrObservation[];
      discovered: PrObservation[];
      queriedBranch: string | null;
    }
  ): Promise<OwnerEffectResult> {
    const { logger } = this.deps;
    const failed: OwnerEffectResult = { statusOk: false, discoveryOk: false };
    try {
      // Fresh meta is the write predicate — never a cache. Missing/tombstoned
      // meta means the session was deleted mid-poll, and an archived or
      // machine-migrated owner is no longer this daemon's to write: never
      // write meta or associate for it (the endpoint does not validate
      // session existence).
      let freshMeta = await runtime.handle.readOwnerMeta(ownerSessionId);
      if (!freshMeta || freshMeta.isArchived || freshMeta.machineId !== runtime.handle.machineId) {
        return failed;
      }
      if (isDirectLocalProject(freshMeta.project, freshMeta.isWorktree)) {
        // The original local directory has no Session-owned branch. Drop a
        // result that was already in flight when the Session changed context.
        return failed;
      }

      // Context revalidation: results were fetched for `(repoFullName,
      // queriedBranch)`. A repo/branch switch while the request was in flight
      // invalidates the DISCOVERY results (they belong to the old context);
      // status observations stay valid (URL-keyed, branch-independent).
      const freshContext = resolveOwnerRepositoryContext(freshMeta);
      const contextUnchanged =
        args.queriedBranch === null ||
        (freshContext.repoFullName === repoFullName && freshContext.branch === args.queriedBranch);
      const discovered = contextUnchanged ? args.discovered : [];
      let discoveryOk = contextUnchanged;

      const newlyAssociated: PrObservation[] = [];
      const associationPlan = planAssociation({
        meta: freshMeta,
        observations: args.observations,
        discovered,
        runtimeBranch: freshContext.branch,
      });
      if (associationPlan) {
        const observation = discovered.find((pr) => pr.url === associationPlan.url);
        const associated = await runtime.handle.associatePullRequest({
          repoFullName,
          prNumber: associationPlan.prNumber,
          prUrl: associationPlan.url,
          branch: freshContext.branch ?? '',
          status: associationPlan.status,
          ownerSessionId,
        });
        if (associated && observation) {
          this.counters.discoveries += 1;
          logger.debug(
            `[pr-poller] Discovered PR #${associationPlan.prNumber} (${associationPlan.status}) for session ${ownerSessionId}; association created`
          );
          // Local meta write only AFTER backend association success.
          freshMeta = await runtime.handle.readOwnerMeta(ownerSessionId);
          if (
            !freshMeta ||
            freshMeta.isArchived ||
            freshMeta.machineId !== runtime.handle.machineId
          ) {
            return failed;
          }
          newlyAssociated.push(observation);
        } else {
          // Association must land before any local write; retry the whole
          // round (query included) at the attempt floor.
          discoveryOk = false;
        }
      }

      const plan = planPullRequestMetaWrite({
        meta: freshMeta,
        observations: [...args.observations, ...discovered],
        newlyAssociated,
        runtimeBranch: freshContext.branch,
        nowSec: Math.floor(this.nowMs() / 1000),
      });
      if (plan) {
        const patch: PrPollMetaPatch = {};
        if (plan.pullRequests) {
          patch.pullRequests = plan.pullRequests;
        }
        if (plan.pullRequestState) {
          patch.pullRequestState = plan.pullRequestState;
        }
        await runtime.handle.writeOwnerMeta(ownerSessionId, patch);
        this.counters.corrections += plan.changedStatusUrls.length;
        for (const url of plan.changedStatusUrls) {
          logger.debug(
            `[pr-poller] poll corrected stale PR status (workspace=${runtime.handle.workspaceId} session=${ownerSessionId} url=${url})`
          );
        }
        if (plan.changedStateUrls.length > 0 || plan.removedStateUrls.length > 0) {
          logger.debug(
            `[pr-poller] PR state updated for session ${ownerSessionId}: ` +
              `${plan.changedStateUrls.length} written, ${plan.removedStateUrls.length} removed, ` +
              `${plan.prunedStateUrls.length} pruned`
          );
        }
      }
      return { statusOk: true, discoveryOk };
    } catch (error) {
      logger.debug(
        `[pr-poller] Failed to apply poll results for session ${ownerSessionId}: ${formatErrorMessage(error)}`
      );
      return failed;
    }
  }
}
