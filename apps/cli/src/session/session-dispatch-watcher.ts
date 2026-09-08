import type { RepoTransportRoomStatus, RepoWatchHandle } from 'loro-repo';
import { Effect, Fiber } from 'effect';
import {
  buildMissingEmail,
  buildPendingUserHistoryEntry,
  buildSessionTurnInputConfig,
  getSessionRoomId,
  getLegacyReadForSessionHistoryStatus,
  type ChatFailedReason,
  isLoroRepoDocDeleted,
  isSessionDocRoomId,
  type AcpConfigOptionValue,
  type MessageQueueItem,
  type MachineId,
  SESSION_DOC_PREFIX,
  SessionCreateRequestValidated,
  type ProjectRef,
  type SessionChatRequestValidated,
  type SessionHistoryInput,
  type SessionId,
  type SessionLaunchConfig,
  type SessionMeta,
  SessionStatusFactory,
  type SessionTurnInputConfig,
  type WorkspaceId,
  normalizeMcpServerIdSelection,
  getPendingUserTurnActivationId,
  hasPendingUserTurnActivation,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { startTraceSpan, traceAsync } from '@/utils/trace-span';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { SessionExecutionService, type SessionDispatchSource } from './session-execution-service';
import {
  extractPromptPreviewFromInputBlocks,
  normalizeSessionInputBlocks,
} from './session-execution-helpers';
import type { SessionUserResolver, SessionUserProfile } from './session-user-resolver';
import {
  findNextDispatchableUserTurn,
  isActivationAwaitingHistory,
  resolveDispatchTurnInput,
  resolveDispatchAcpSessionId,
  resolveResumableAcpSessionId,
  resolveSessionCancelAction,
  resolveSessionDispatchAction,
  shouldWatchSession,
  type SessionDispatchSnapshot,
} from './session-dispatch-logic';
import {
  verifyMachineAccessWithRetry,
  type MachineAccessDenyReason,
  type MachineAccessVerification,
} from './session-access-retry';
import { resolveSessionLaunchConfig } from './session-launch-config-resolver';
import type { SessionAccessPolicyService } from './session-access-policy';
import { mapWithConcurrency } from '@/lib/bounded-concurrency';
import { listAliveRoomIds } from '@/lib/loro/repo-existence';

const SESSION_RECONCILE_CONCURRENCY = 4;

type SessionUserResolverLike = Pick<SessionUserResolver, 'resolve' | 'clear'>;

type SessionDispatchWatcherDeps = {
  logger: Logger;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  currentUserId?: string;
  workspaceDocument: LoroDocumentManager;
  executionService: SessionExecutionService;
  // Required: resolving the requesting user's real name/email is what keeps a
  // dispatched turn's commits attributed to the user who started the session
  // instead of the daemon host's git config.
  userResolver: SessionUserResolverLike;
  accessPolicy?: SessionAccessPolicyService;
  getPreparedSessionLaunchConfig?: (input: {
    sessionMeta: SessionMeta;
    requesterUserId: string;
  }) => { config: SessionLaunchConfig | undefined } | null;
  // Three-way result (allowed / definitive deny / indeterminate). The
  // indeterminate case is what keeps a transient outage from dropping the turn —
  // see {@link verifyMachineAccessWithRetry}.
  canUseMachine: (args: {
    sessionId: SessionId;
    requesterUserId: string;
    // Provided when the session targets a local project, so the backend can
    // additionally enforce per-project sharing for non-owner requesters.
    localProjectId?: string;
    // Set by the background owner re-verification (P5/D11): implementations
    // must skip any local owner fast-path and consult the real backend, so an
    // online revocation is actually observed (and the optimistic-allow snapshot
    // refreshed/cleared) instead of being masked by the structural owner allow.
    forceBackendVerification?: boolean;
  }) => Promise<MachineAccessVerification>;
  // P5/D11 optimistic-allow snapshot bookkeeping, driven by the background
  // owner re-verification only: 'allowed' (confirmed online) refreshes the
  // cached owner allow — the sole writer of `verifiedAt` — and 'denied'
  // (definitive online deny) clears it, so the next dispatch falls back to the
  // remote three-state check. Indeterminate verdicts never reach this.
  recordOwnerAccessSnapshot?: (verdict: 'allowed' | 'denied') => Promise<void>;
  // Optional so existing callers/tests can omit it. When provided, a definitive
  // access denial surfaces a visible chat_failed notice instead of silently
  // marking the turn failed (which the web UI renders as "Delivered").
  recordChatFailure?: (
    sessionDoc: SessionDocumentHandle,
    reason: ChatFailedReason,
    message?: string
  ) => Promise<void>;
  // Startup bootstrap runs after the workspace is already considered started.
  // This hook lets callers keep post-bootstrap cleanup/recovery out of the
  // workspace startup await chain.
  onStartupBootstrapComplete?: () => void;
  // Optional machine-level escalation. Invoked once when access verification
  // keeps failing with an auth-looking error (likely an invalid/revoked token),
  // so a sustained problem is surfaced rather than silently retried forever.
  onFatalAuthFailure?: (error: Error) => void;
};

/** A running verify-with-retry fiber for a transient access failure on `turnId`. */
type AccessRetryHandle = {
  turnId: string;
  fiber: Fiber.RuntimeFiber<void, never>;
};

type WatchedSession = {
  unsubscribe: () => void;
};

type SessionReconcileOptions = {
  /** Keep startup's global concurrency bound around the initial room work. */
  awaitInitialChecks?: boolean;
  /** Reject work queued by an earlier start/stop lifecycle. */
  lifecycleGeneration?: number;
};

type SessionCheckOptions = {
  /** Resolve after room/history probing, before a potentially long agent turn. */
  resolveAfterInitialProbe?: boolean;
  /** A metadata event may already own this session; bootstrap need not duplicate it. */
  reuseExistingCheck?: boolean;
  lifecycleGeneration?: number;
};

type InitialProbeObserver = {
  complete: () => void;
  fail: (error: unknown) => void;
};

type InitialProbeRecord = {
  promise: Promise<void>;
  observer: InitialProbeObserver;
  started: boolean;
  settled: boolean;
};

type SessionReconcileLane = 'metadata' | 'bootstrap';

type SessionReconcileWaiter = {
  lane: SessionReconcileLane;
  resolve: () => void;
};

type LifecycleCancelSubscriber = {
  generation: number;
  cancel: () => void;
};

/** A user turn pushed over Machine RPC ahead of history CRDT sync. */
export type SessionRpcTurnOffer = {
  sessionId: SessionId;
  userTurnId: string;
  userId: string;
  timestamp: string;
  inputConfig: SessionTurnInputConfig;
};

export type SessionRpcTurnOfferDisposition =
  | 'accepted'
  | 'duplicate'
  | 'already-terminal'
  | 'not-owned'
  | 'error';

type StashedRpcTurn = {
  entry: SessionHistoryInput;
  expiresAtMs: number;
};

type SessionReconcilePhase =
  | 'read-doc-meta'
  | 'evaluate-ownership'
  | 'evaluate-active-watch'
  | 'open-session-doc'
  | 'subscribe-session-doc'
  | 'enqueue-session-checks';

type SessionDocumentHandle = Awaited<ReturnType<LoroDocumentManager['getOrCreateSessionDoc']>>;

const isConfigOptionValueRecord = (
  value: unknown
): value is Record<string, AcpConfigOptionValue> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(
    (item) => typeof item === 'string' || typeof item === 'boolean'
  );
};

/**
 * ## Session Dispatch Watcher — Behavioral Design
 *
 * This class watches CRDT session documents and dispatches user messages to the
 * execution service. It is the bridge between "a user typed something on the web"
 * and "the CLI agent starts working."
 *
 * ### Event Sources (inputs)
 *
 * Three event sources trigger dispatch checks:
 *
 * 1. **Metadata watch** (`repo.watch('doc-metadata')`) — fires when any session's
 *    CRDT metadata changes (e.g. new session created, status updated, cancel requested).
 *    This is the primary trigger for new sessions and cancel requests.
 *
 * 2. **Mirror subscribe** (`sessionDoc.mirror.subscribe()`) — fires when a session
 *    doc's content changes (e.g. new user message synced from the web client).
 *    This handles follow-up messages on already-watched sessions.
 *
 * 3. **RPC turn push** (`offerRpcTurn`, wired from the `session/dispatch-turn`
 *    Machine RPC) — the web client pushes the full turn payload ahead of history
 *    CRDT sync. The payload is stashed as a third turn source (history → queue →
 *    stash) and a dispatch check is enqueued; the RPC response is a delivery ACK
 *    only. The session doc stays the durable source of truth — an RPC loss just
 *    falls back to sources 1/2. Turns executed from the stash before their
 *    history entry syncs are reconciled by `maybeRepairAlreadyHandledTurn` so the
 *    late-arriving `pending` entry is repaired instead of dispatched twice.
 *
 * ### Dispatch Decision Tree
 *
 * When a check is triggered for a session, `maybeHandleSession` evaluates this
 * decision tree (all inputs are read fresh each time):
 *
 * ```
 * 1. Guard: not owned by this machine, or archived?
 *    └─ yes → noop (not our responsibility)
 *
 * 2. Guard: active turn is still creating/restoring its ACP session?
 *    └─ yes → noop (wait for it to finish)
 *
 * 3. Status is running / initializing / requestPermission?
 *    ├─ AND has active turn owner → noop (actively working, don't interrupt)
 *    └─ AND no active turn owner  → RESET status to idle
 *       (Stale status from a previous CRA crash. Without reset, the session
 *        would be permanently stuck. After reset, fall through to step 4.)
 *
 * 4. Find a dispatchable user turn in history:
 *    - A turn is "dispatchable" if:
 *      • status is 'pending', 'seen', or 'processing' (new status field), OR
 *      • read === false (legacy field), OR
 *      • id matches meta.processingUserMsgId (interrupted processing), OR
 *      • id matches meta.latestUserMsgId but NOT meta.lastHandledUserMsgId
 *    - If no turn found in history, try promoting from the message queue (I/O)
 *      via `SessionDocument.appendUserTurn`, which publishes the pointer too.
 *    - If still nothing AND the pointer's entry is genuinely absent, wait for
 *      remote sync and retry (the race where metadata arrives before session doc
 *      content syncs from the web client). A pointer whose entry is already
 *      terminal is settled instead — history has answered, so waiting cannot.
 *    └─ pending meta still has no history turn after 5m → negatively acknowledge
 *       that exact turn id and unload the session doc
 *
 * 5. Dispatch the turn:
 *    ├─ No reusable session AND no acpSessionId → startSession (create)
 *    └─ Otherwise                              → continueSession (chat)
 * ```
 *
 * ### Cancel Decision Tree
 *
 * Cancel checks run on a separate chain from dispatch checks (so a cancel can
 * proceed even while a dispatch is in-flight):
 *
 * ```
 * 1. Guard: not owned / archived / no lastCanceledTurn → noop
 * 2. Guard: lastCanceledTurn === already-seen turn     → noop (deduplicate)
 * 3. Execute cancel, record the turn as seen.
 * ```
 *
 * ### Concurrency Model
 *
 * Each session has two independent serialized promise chains:
 * - `sessionCheckChains` — at most one `maybeHandleSession` runs per session at a time.
 *   If multiple events fire while a check is in progress, exactly one follow-up check
 *   runs after it completes (coalescing).
 * - `cancelCheckChains` — same pattern for cancel requests. Separate from dispatch
 *   so that a cancel can be processed without waiting for a long-running dispatch.
 *
 * ### Turn-Finding Retry Strategy
 *
 * `findOrAwaitDispatchableTurn` only waits when metadata explicitly names work:
 *
 * ```
 * Phase 1 (local): check history → try queue promotion → RPC stash
 * Phase 2 (pending meta): keep the history room joined and wait up to 5m
 * Otherwise: return idle; metadata/RPC events reactivate the session later
 * ```
 *
 * ### User-Visible Dispatch Recovery Contract
 *
 * A web send is committed through two CRDT surfaces: session metadata and session
 * history. Metadata can sync first (`latestUserMsgId` / `processingUserMsgId`
 * says there is work), while the History CRDT entry for that user turn is still
 * missing locally. The CLI must not start a prompt until it can read the actual
 * history turn because the turn carries the prompt blocks, user id, config, and
 * queue semantics. This creates a visible gap where the message can look "seen"
 * by the machine, but the machine is not yet allowed to enter Working.
 *
 * The user expectation for that gap is:
 * - if the machine is online and has access, the session should enter Working
 *   as soon as the matching history turn arrives;
 * - if the history turn never arrives, the UI should receive one clear delivery
 *   failure within a bounded time instead of waiting forever;
 * - a failed recovery must not permanently poison the session: sending a fresh
 *   message should write a fresh pending pointer and wake the CLI again.
 *
 * To satisfy that contract, explicit pending metadata gets one five-minute
 * history-sync window. During that window we keep the SessionDoc joined and
 * listen for both mirror updates and transport room status. On a room disconnect
 * or error, we make one jittered `rejoinDocRoom()` attempt. The wait is passive:
 * we do not mutate `session.status` while waiting because non-idle status writes
 * can still be mistaken for durable activity by legacy readers; live UI should
 * rely on ephemeral presence for the "Working" indicator. We also
 * do not repeatedly unload and recreate the document: that makes the observed
 * state harder to reason about, churns subscriptions, and was the source of
 * confusing "message could not be delivered" failures when metadata won the
 * sync race.
 *
 * If the five-minute window expires, we mark dispatch recovery unhealthy,
 * preserve the producer/executor pointers and `lastHandledUserMsgId`, record the
 * exact id in `lastMissingHistoryUserMsgId`, and unload the session doc. Watch
 * activation and turn selection ignore a pointer only while it equals that
 * negative acknowledgement. A future send publishes a different id (and clears
 * the marker), which naturally wakes dispatch again. Preserving the pointers is
 * essential: clearing either one after an awaited refresh can overwrite a newer
 * activation or processing claim from another peer.
 * The tradeoff is that a genuinely late History CRDT update after the timeout
 * is never dispatched: the marker is permanent for that exact turn, and the
 * renderer derives a visible "not delivered" label for it from the marker plus
 * its non-terminal status (no CLI repair write, no schema change). Recovery is
 * a fresh send — the row's "not delivered" label opens a confirmation dialog
 * that re-sends the same content as a brand-new message (new turn id). The
 * renderer retains the marker and supersedes the abandoned entry to
 * `canceled`.
 *
 * Sessions without an explicit activation signal stay metadata-only. History is
 * a turn-selection source after activation, not a startup activation index.
 */
export class SessionDispatchWatcher {
  /** Sessions this watcher is actively monitoring (keyed by sessionId → unsubscribe handle). */
  private readonly watchedSessions = new Map<SessionId, WatchedSession>();

  /**
   * Per-session serialized promise chains for dispatch checks.
   * Ensures at most one `maybeHandleSession` call runs per session at a time.
   * New events that arrive during an in-flight check are coalesced into a single follow-up.
   */
  private readonly sessionCheckChains = new Map<SessionId, Promise<void>>();
  private readonly sessionInitialProbes = new Map<SessionId, Set<InitialProbeRecord>>();

  /**
   * Per-session serialized promise chains for cancel checks.
   * Separate from `sessionCheckChains` so cancels are not blocked by long dispatches.
   */
  private readonly cancelCheckChains = new Map<SessionId, Promise<void>>();

  /**
   * Tracks the last `meta.lastCanceledTurn` value we have already processed per session.
   * Used to deduplicate cancel requests — the same `lastCanceledTurn` value should
   * only trigger one cancel call.
   */
  private readonly cancelSeenTurn = new Map<SessionId, string>();

  /**
   * User turns pushed via `session/dispatch-turn` RPC, keyed by userTurnId.
   * A third turn source for dispatch (after history and the message queue):
   * the payload lets a turn start before the session-doc history CRDT syncs.
   * Entries are dropped when the history copy arrives, when the turn is handed
   * to the execution service, or when the TTL lapses.
   */
  private readonly rpcTurnStash = new Map<SessionId, Map<string, StashedRpcTurn>>();

  /** How the currently found turn payload reached us, keyed `${sessionId}:${turnId}`. */
  private readonly turnSourceHints = new Map<string, SessionDispatchSource>();

  /** Subscribers that make every CRDT wait preemptible when an RPC turn lands. */
  private readonly rpcTurnOfferSubscribers = new Map<SessionId, Set<() => void>>();

  private static readonly RPC_TURN_STASH_TTL_MS = 10 * 60_000;

  /**
   * Per-session verify-with-retry fibers for transient access-verification
   * failures. Present only while a turn is being re-verified in the background;
   * interrupted on success, definitive denial, supersession by a newer turn, or
   * when the session stops needing an active watch.
   */
  private readonly accessFibers = new Map<SessionId, AccessRetryHandle>();

  private metadataWatchHandle: RepoWatchHandle | null = null;
  private readonly userResolver: SessionUserResolverLike;
  private detachMetaRoomSyncedListener: (() => void) | null = null;
  private bootstrapChain: Promise<void> = Promise.resolve();
  private readonly pendingBootstrapReasons = new Set<string>();
  private bootstrapDrainScheduled = false;
  private metadataReconcileChain: Promise<void> = Promise.resolve();
  private readonly pendingMetadataSessionIds = new Set<SessionId>();
  private metadataReconcileDrainScheduled = false;
  private activeSessionReconciles = 0;
  private activeBootstrapReconciles = 0;
  private readonly sessionReconcileWaiters: SessionReconcileWaiter[] = [];
  private startupBootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private lifecycleGeneration = 0;
  private readonly lifecycleCancelSubscribers = new Set<LifecycleCancelSubscriber>();

  constructor(private readonly deps: SessionDispatchWatcherDeps) {
    this.userResolver = deps.userResolver;
  }

  /**
   * Start watching for session dispatch opportunities.
   *
   * Workspace startup should not join session rooms synchronously. Register the
   * live metadata watcher first, then run startup reconciliation in the
   * background so a bad session doc cannot prevent the workspace from starting.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.lifecycleGeneration += 1;
    this.started = true;

    this.detachMetaRoomSyncedListener = this.deps.workspaceDocument.onMetaRoomSynced((reason) => {
      if (!this.started) {
        return;
      }
      this.enqueueBootstrap(`meta-room-synced:${reason}`);
    });
    this.metadataWatchHandle = this.deps.workspaceDocument.repo.watch(
      (event) => {
        if (event.kind !== 'doc-metadata' || !isSessionDocRoomId(event.docId)) {
          return;
        }
        const sessionId = event.docId.slice(SESSION_DOC_PREFIX.length) as SessionId;
        this.enqueueMetadataReconcile(sessionId);
      },
      { kinds: ['doc-metadata'] }
    );
    this.startupBootstrapTimer = setTimeout(() => {
      this.startupBootstrapTimer = null;
      if (this.started) {
        this.enqueueBootstrap('startup');
      }
    }, 0);
    this.startupBootstrapTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    this.lifecycleGeneration += 1;
    for (const subscriber of this.lifecycleCancelSubscribers) {
      subscriber.cancel();
    }
    this.lifecycleCancelSubscribers.clear();
    if (this.startupBootstrapTimer) {
      clearTimeout(this.startupBootstrapTimer);
      this.startupBootstrapTimer = null;
    }
    this.metadataWatchHandle?.unsubscribe();
    this.metadataWatchHandle = null;
    this.detachMetaRoomSyncedListener?.();
    this.detachMetaRoomSyncedListener = null;
    for (const watched of this.watchedSessions.values()) {
      watched.unsubscribe();
    }
    this.watchedSessions.clear();
    for (const probes of this.sessionInitialProbes.values()) {
      for (const probe of probes) {
        probe.observer.complete();
      }
    }
    this.sessionInitialProbes.clear();
    this.sessionCheckChains.clear();
    this.cancelCheckChains.clear();
    this.cancelSeenTurn.clear();
    this.rpcTurnStash.clear();
    this.turnSourceHints.clear();
    this.rpcTurnOfferSubscribers.clear();
    this.pendingBootstrapReasons.clear();
    this.pendingMetadataSessionIds.clear();
    for (const sessionId of [...this.accessFibers.keys()]) {
      this.interruptAccessRetry(sessionId);
    }
    this.userResolver.clear();
  }

  recheckPendingAccess(reason: string): void {
    const sessionIds = new Set<SessionId>([
      ...this.watchedSessions.keys(),
      ...this.accessFibers.keys(),
    ]);
    for (const sessionId of Array.from(this.accessFibers.keys())) {
      this.interruptAccessRetry(sessionId);
    }
    this.enqueueBootstrap(`access-recheck:${reason}`);
    for (const sessionId of sessionIds) {
      void this.enqueueSessionCheck(sessionId);
    }
  }

  private isLifecycleActive(lifecycleGeneration?: number): boolean {
    return (
      lifecycleGeneration === undefined ||
      (this.started && lifecycleGeneration === this.lifecycleGeneration)
    );
  }

  private subscribeToLifecycleCancel(
    lifecycleGeneration: number | undefined,
    cancel: () => void
  ): () => void {
    if (lifecycleGeneration === undefined) {
      return () => {};
    }
    if (!this.isLifecycleActive(lifecycleGeneration)) {
      cancel();
      return () => {};
    }
    const subscriber = { generation: lifecycleGeneration, cancel };
    this.lifecycleCancelSubscribers.add(subscriber);
    return () => {
      this.lifecycleCancelSubscribers.delete(subscriber);
    };
  }

  /**
   * Enqueue a dispatch check for a session. Multiple calls while a check is in-flight
   * are coalesced: exactly one follow-up check will run after the current one finishes.
   */
  enqueueSessionCheck(sessionId: SessionId, options: SessionCheckOptions = {}): Promise<void> {
    // Tests may drive an as-yet-unstarted watcher directly (generation 0). Once
    // a production watcher has ever started, every check is generation-bound,
    // including RPC/access callbacks that happen to enqueue after stop().
    const lifecycleGeneration =
      options.lifecycleGeneration ??
      (this.lifecycleGeneration > 0 ? this.lifecycleGeneration : undefined);
    const existing = this.sessionCheckChains.get(sessionId);
    if (options.reuseExistingCheck === true && existing !== undefined) {
      const probes = this.sessionInitialProbes.get(sessionId);
      const activeProbe = [...(probes ?? [])].find((probe) => probe.started && !probe.settled);
      if (activeProbe) {
        return activeProbe.promise;
      }
      // If the chain has not started yet, its first probe is the reconcile's
      // initial work. If a settled probe is still running post-probe agent work,
      // any later check is a follow-up event, not part of this activation slot.
      const hasRunningPostProbe = [...(probes ?? [])].some(
        (probe) => probe.started && probe.settled
      );
      if (hasRunningPostProbe) {
        return Promise.resolve();
      }
      const firstQueuedProbe = [...(probes ?? [])].find((probe) => !probe.settled);
      return firstQueuedProbe?.promise ?? existing;
    }

    const previous = this.sessionCheckChains.get(sessionId) ?? Promise.resolve();
    let resolveProbe!: () => void;
    let rejectProbe!: (error: unknown) => void;
    let probeSettled = false;
    const probe = new Promise<void>((resolve, reject) => {
      resolveProbe = resolve;
      rejectProbe = reject;
    });
    let probeRecord!: InitialProbeRecord;
    const initialProbe: InitialProbeObserver = {
      complete: () => {
        if (probeSettled) {
          return;
        }
        probeSettled = true;
        probeRecord.settled = true;
        resolveProbe();
      },
      fail: (error) => {
        if (probeSettled) {
          return;
        }
        probeSettled = true;
        probeRecord.settled = true;
        rejectProbe(error);
      },
    };
    probeRecord = {
      promise: probe,
      observer: initialProbe,
      started: false,
      settled: false,
    };
    let probes = this.sessionInitialProbes.get(sessionId);
    if (!probes) {
      probes = new Set();
      this.sessionInitialProbes.set(sessionId, probes);
    }
    probes.add(probeRecord);
    const next = previous
      .catch(() => {})
      .then(async () => {
        probeRecord.started = true;
        await this.maybeHandleSession(sessionId, initialProbe, lifecycleGeneration);
      })
      .finally(() => {
        initialProbe.complete();
        const currentProbes = this.sessionInitialProbes.get(sessionId);
        currentProbes?.delete(probeRecord);
        if (currentProbes?.size === 0) {
          this.sessionInitialProbes.delete(sessionId);
        }
        if (this.sessionCheckChains.get(sessionId) === next) {
          this.sessionCheckChains.delete(sessionId);
        }
      });
    this.sessionCheckChains.set(sessionId, next);
    // The maps own these promises even when an event handler intentionally
    // ignores the returned handle. Attach observers to avoid unhandled rejects;
    // callers that await either promise still receive the original rejection.
    void next.catch(() => undefined);
    void probe.catch(() => undefined);
    return options.resolveAfterInitialProbe === true ? probe : next;
  }

  /**
   * Accept a user turn pushed over Machine RPC (`session/dispatch-turn`).
   *
   * Ack-then-execute: this only validates, stashes the payload, wakes any
   * in-flight history-sync wait, and enqueues a normal dispatch check — the
   * caller's RPC response is a delivery ACK, never an execution result. The
   * turn still flows through the per-session serialized check chain with all
   * of its guards (ownership, active turn, access verification), so the RPC
   * path can never double-dispatch against the CRDT path. Idempotent by
   * `userTurnId`.
   */
  async offerRpcTurn(offer: SessionRpcTurnOffer): Promise<SessionRpcTurnOfferDisposition> {
    const { sessionId, userTurnId } = offer;
    const span = startTraceSpan(this.deps.logger, 'dispatch.offer_rpc_turn', {
      sessionId,
      userTurnId,
    });
    const finish = (
      disposition: SessionRpcTurnOfferDisposition
    ): SessionRpcTurnOfferDisposition => {
      span.end({ disposition });
      return disposition;
    };
    try {
      const record = await this.deps.workspaceDocument.repo.getDocMeta(getSessionRoomId(sessionId));
      const meta = isLoroRepoDocDeleted(record)
        ? undefined
        : (record?.meta as SessionMeta | undefined);
      // A missing meta is fine: the RPC envelope already targeted this machine
      // explicitly, and the meta pointer may simply not have synced yet. The
      // dispatch check re-verifies ownership once meta lands.
      if (meta?.isArchived || (meta?.machineId && meta.machineId !== this.deps.machineId)) {
        return finish('not-owned');
      }
      if (
        meta?.lastHandledUserMsgId === userTurnId ||
        this.deps.executionService.getTerminalUserTurnStatusWithoutEntry?.(sessionId, userTurnId)
      ) {
        return finish('already-terminal');
      }
      if (this.deps.executionService.getActiveUserTurnId?.(sessionId) === userTurnId) {
        return finish('duplicate');
      }

      const inputBlocks = normalizeSessionInputBlocks(
        offer.inputConfig.inputBlocks,
        offer.inputConfig.prompt ?? ''
      );
      const pendingEntry = buildPendingUserHistoryEntry({
        userId: offer.userId,
        inputBlocks,
        timestamp: offer.timestamp,
        inputConfig: offer.inputConfig,
      });
      if (!pendingEntry) {
        return finish('error');
      }

      // Sweep expired entries across all sessions on every accept. A turn that
      // is accepted before its session meta ever syncs is never re-peeked (the
      // dispatch check returns early on missing meta), so without this sweep its
      // payload would outlive the TTL forever. Sweeping on the write path bounds
      // total retention to turns accepted within one TTL window.
      this.sweepExpiredRpcTurns();

      let stash = this.rpcTurnStash.get(sessionId);
      if (!stash) {
        stash = new Map();
        this.rpcTurnStash.set(sessionId, stash);
      }
      const wasStashed = stash.has(userTurnId);
      stash.set(userTurnId, {
        entry: { ...pendingEntry, id: userTurnId },
        expiresAtMs: Date.now() + SessionDispatchWatcher.RPC_TURN_STASH_TTL_MS,
      });

      this.deps.logger.debug(
        `[${sessionId}] RPC turn ${userTurnId} stashed for dispatch (duplicate=${wasStashed})`
      );
      this.activateRpcTurn(sessionId);
      return finish(wasStashed ? 'duplicate' : 'accepted');
    } catch (error) {
      span.fail(error, { disposition: 'error' });
      this.deps.logger.error(
        `[${sessionId}] Failed to accept RPC turn ${userTurnId}: ${formatErrorMessage(error)}`
      );
      return 'error';
    }
  }

  hasPendingDispatch(sessionId: SessionId): boolean {
    this.sweepExpiredRpcTurns();
    return (this.rpcTurnStash.get(sessionId)?.size ?? 0) > 0 || this.accessFibers.has(sessionId);
  }

  /** Drop expired stashed RPC turns across all sessions (bounded cleanup). */
  private sweepExpiredRpcTurns(): void {
    const now = Date.now();
    for (const [sessionId, stash] of this.rpcTurnStash) {
      for (const [userTurnId, stashed] of stash) {
        if (stashed.expiresAtMs <= now) {
          stash.delete(userTurnId);
        }
      }
      if (stash.size === 0) {
        this.rpcTurnStash.delete(sessionId);
      }
    }
  }

  /**
   * Peek the oldest live stashed RPC turn for a session. Entries that expired
   * or already reached a terminal state are dropped instead of returned, so a
   * finished turn cannot re-enter dispatch from the stash. Terminal means:
   * advanced past by `lastHandledUserMsgId`, recorded terminal in memory
   * (handled/denied while stashed), or carrying a terminal history status —
   * e.g. the renderer superseding an undelivered turn to `canceled` when its
   * content is resent as a new message.
   *
   * An entry whose id matches `lastMissingHistoryUserMsgId` stays stashed but
   * is never returned: the negative acknowledgement is PERMANENT for that
   * exact turn while it stands, so no turn source may dispatch it — a
   * duplicate RPC offer must not resurrect the turn. Recovery is a fresh send
   * with a new turn id (the conversation's resend entry), never a revival.
   */
  private peekStashedRpcTurn(
    sessionId: SessionId,
    meta: SessionMeta,
    history: SessionHistoryInput[] = []
  ): SessionHistoryInput | null {
    const stash = this.rpcTurnStash.get(sessionId);
    if (!stash) {
      return null;
    }
    const now = Date.now();
    for (const [userTurnId, stashed] of stash) {
      const isTerminal =
        meta.lastHandledUserMsgId === userTurnId ||
        this.deps.executionService.getTerminalUserTurnStatusWithoutEntry?.(
          sessionId,
          userTurnId
        ) !== undefined ||
        !isActivationAwaitingHistory(history, userTurnId);
      if (stashed.expiresAtMs <= now || isTerminal) {
        stash.delete(userTurnId);
        continue;
      }
      if (userTurnId === meta.lastMissingHistoryUserMsgId) {
        continue;
      }
      this.turnSourceHints.set(`${sessionId}:${userTurnId}`, 'rpc');
      return stashed.entry;
    }
    if (stash.size === 0) {
      this.rpcTurnStash.delete(sessionId);
    }
    return null;
  }

  private consumeStashedRpcTurn(sessionId: SessionId, userTurnId: string): void {
    const stash = this.rpcTurnStash.get(sessionId);
    if (!stash) {
      return;
    }
    stash.delete(userTurnId);
    if (stash.size === 0) {
      this.rpcTurnStash.delete(sessionId);
    }
  }

  private activateRpcTurn(sessionId: SessionId): void {
    this.rpcTurnOfferSubscribers.get(sessionId)?.forEach((notify) => notify());
    void this.enqueueSessionCheck(sessionId);
  }

  private subscribeToRpcTurnOffers(sessionId: SessionId, subscriber: () => void): () => void {
    let subscribers = this.rpcTurnOfferSubscribers.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.rpcTurnOfferSubscribers.set(sessionId, subscribers);
    }
    subscribers.add(subscriber);

    return () => {
      const current = this.rpcTurnOfferSubscribers.get(sessionId);
      current?.delete(subscriber);
      if (current?.size === 0) {
        this.rpcTurnOfferSubscribers.delete(sessionId);
      }
    };
  }

  private takeTurnSourceHint(sessionId: SessionId, userTurnId: string): SessionDispatchSource {
    const key = `${sessionId}:${userTurnId}`;
    const hint = this.turnSourceHints.get(key);
    this.turnSourceHints.delete(key);
    return hint ?? 'crdt';
  }

  private peekTurnSourceHint(sessionId: SessionId, userTurnId: string): SessionDispatchSource {
    const key = `${sessionId}:${userTurnId}`;
    return this.turnSourceHints.get(key) ?? 'crdt';
  }

  /** Enqueue a cancel check (separate chain from dispatch — see class doc). */
  private enqueueCancelCheck(sessionId: SessionId, lifecycleGeneration?: number): Promise<void> {
    const previous = this.cancelCheckChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (
          lifecycleGeneration !== undefined &&
          (!this.started || lifecycleGeneration !== this.lifecycleGeneration)
        ) {
          return;
        }
        await this.maybeHandleCancelRequest(sessionId, lifecycleGeneration);
      })
      .finally(() => {
        if (this.cancelCheckChains.get(sessionId) === next) {
          this.cancelCheckChains.delete(sessionId);
        }
      });
    this.cancelCheckChains.set(sessionId, next);
    void next.catch(() => undefined);
    return next;
  }

  /** Scan known session existence in the background and reconcile sessions independently. */
  private enqueueBootstrap(reason: string): void {
    this.pendingBootstrapReasons.add(reason);
    this.scheduleBootstrapDrain();
  }

  /**
   * Fold metadata bursts by session and reconcile them with the same four-way
   * bound used by bootstrap. Remote meta catch-up can publish thousands
   * of events in one turn; opening every activated SessionDocument at once would
   * otherwise monopolize the event loop and retain all of their cloud rooms.
   */
  private enqueueMetadataReconcile(sessionId: SessionId): void {
    // Reinsert so a fresh event moves ahead of stale catch-up work already in
    // the queue. The drain takes from the newest end in bounded batches.
    this.pendingMetadataSessionIds.delete(sessionId);
    this.pendingMetadataSessionIds.add(sessionId);
    this.scheduleMetadataReconcileDrain();
  }

  private scheduleMetadataReconcileDrain(): void {
    if (this.metadataReconcileDrainScheduled) {
      return;
    }
    this.metadataReconcileDrainScheduled = true;
    const lifecycleGeneration = this.lifecycleGeneration;
    const next = this.metadataReconcileChain
      .catch(() => {})
      .then(async () => {
        while (
          this.started &&
          lifecycleGeneration === this.lifecycleGeneration &&
          this.pendingMetadataSessionIds.size > 0
        ) {
          const sessionIds = [...this.pendingMetadataSessionIds]
            .slice(-SESSION_RECONCILE_CONCURRENCY)
            .reverse();
          for (const sessionId of sessionIds) {
            this.pendingMetadataSessionIds.delete(sessionId);
          }
          await Promise.all(
            sessionIds.map((sessionId) =>
              this.withSessionReconcileSlot('metadata', async () => {
                await this.reconcileSessionWatch(sessionId, 'metadata-watch', {
                  awaitInitialChecks: true,
                  lifecycleGeneration,
                });
              }).catch(() => undefined)
            )
          );
        }
      })
      .finally(() => {
        this.metadataReconcileDrainScheduled = false;
        if (this.started && this.pendingMetadataSessionIds.size > 0) {
          this.scheduleMetadataReconcileDrain();
        }
      });
    this.metadataReconcileChain = next;
  }

  private scheduleBootstrapDrain(): void {
    if (this.bootstrapDrainScheduled) {
      return;
    }
    this.bootstrapDrainScheduled = true;
    const lifecycleGeneration = this.lifecycleGeneration;
    const next = this.bootstrapChain
      .catch(() => {})
      .then(async () => {
        if (
          !this.started ||
          lifecycleGeneration !== this.lifecycleGeneration ||
          this.pendingBootstrapReasons.size === 0
        ) {
          return;
        }

        const reasons = [...this.pendingBootstrapReasons];
        this.pendingBootstrapReasons.clear();
        const scanReason =
          reasons.length === 1 ? (reasons[0] ?? 'unknown') : `coalesced:${reasons.join(',')}`;
        await this.bootstrapOwnedSessions(scanReason, lifecycleGeneration);
        if (
          reasons.includes('startup') &&
          this.started &&
          lifecycleGeneration === this.lifecycleGeneration
        ) {
          this.deps.onStartupBootstrapComplete?.();
        }
      })
      .catch((error: unknown) => {
        this.deps.logger.error(
          `[dispatch] Owned-session bootstrap drain failed: ${formatErrorMessage(error, {
            includeStack: true,
          })}`
        );
      })
      .finally(() => {
        this.bootstrapDrainScheduled = false;
        if (this.started && this.pendingBootstrapReasons.size > 0) {
          this.scheduleBootstrapDrain();
        }
      });
    this.bootstrapChain = next;
  }

  private async bootstrapOwnedSessions(reason: string, lifecycleGeneration: number): Promise<void> {
    const isActive = () => this.started && lifecycleGeneration === this.lifecycleGeneration;
    if (!isActive()) {
      return;
    }

    this.deps.logger.debug(`[dispatch] Scanning owned sessions (reason=${reason})`);

    let sessionRoomIds: string[];
    try {
      sessionRoomIds = await listAliveRoomIds(this.deps.workspaceDocument, isSessionDocRoomId);
    } catch (error) {
      this.deps.logger.error(
        `[dispatch] Failed to scan owned sessions (reason=${reason}): ${formatErrorMessage(error, {
          includeStack: true,
        })}`
      );
      return;
    }

    this.deps.logger.debug(
      `[dispatch] Found ${sessionRoomIds.length} session room(s) during owned-session scan (reason=${reason})`
    );

    if (!isActive()) {
      return;
    }

    const reconcileFailures = await mapWithConcurrency(
      sessionRoomIds,
      SESSION_RECONCILE_CONCURRENCY,
      async (roomId) => {
        if (!isActive()) {
          return false;
        }
        const sessionId = roomId.slice(SESSION_DOC_PREFIX.length) as SessionId;
        try {
          await this.withSessionReconcileSlot('bootstrap', async () => {
            await this.reconcileSessionWatch(sessionId, `bootstrap:${reason}`, {
              awaitInitialChecks: true,
              lifecycleGeneration,
            });
          });
          return false;
        } catch {
          return true;
        }
      }
    );
    const failedCount = reconcileFailures.filter(Boolean).length;

    if (failedCount > 0) {
      this.deps.logger.warn(
        `[dispatch] Owned-session bootstrap completed with ${failedCount}/${sessionRoomIds.length} session reconcile failure(s) (reason=${reason})`
      );
    }
  }

  /**
   * Share one global initial-room-work budget across metadata and bootstrap.
   * Bootstrap may consume at most three slots so a live activation can always
   * enter the fourth instead of waiting behind a five-minute history probe.
   */
  private async withSessionReconcileSlot<T>(
    lane: SessionReconcileLane,
    task: () => Promise<T>
  ): Promise<T> {
    await this.acquireSessionReconcileSlot(lane);
    try {
      return await task();
    } finally {
      this.releaseSessionReconcileSlot(lane);
    }
  }

  private acquireSessionReconcileSlot(lane: SessionReconcileLane): Promise<void> {
    if (this.canAcquireSessionReconcileSlot(lane)) {
      this.markSessionReconcileSlotAcquired(lane);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.sessionReconcileWaiters.push({ lane, resolve });
    });
  }

  private canAcquireSessionReconcileSlot(lane: SessionReconcileLane): boolean {
    return (
      this.activeSessionReconciles < SESSION_RECONCILE_CONCURRENCY &&
      (lane === 'metadata' || this.activeBootstrapReconciles < SESSION_RECONCILE_CONCURRENCY - 1)
    );
  }

  private markSessionReconcileSlotAcquired(lane: SessionReconcileLane): void {
    this.activeSessionReconciles += 1;
    if (lane === 'bootstrap') {
      this.activeBootstrapReconciles += 1;
    }
  }

  private releaseSessionReconcileSlot(lane: SessionReconcileLane): void {
    this.activeSessionReconciles -= 1;
    if (lane === 'bootstrap') {
      this.activeBootstrapReconciles -= 1;
    }
    this.drainSessionReconcileWaiters();
  }

  private drainSessionReconcileWaiters(): void {
    while (this.activeSessionReconciles < SESSION_RECONCILE_CONCURRENCY) {
      let waiterIndex = this.sessionReconcileWaiters.findIndex(
        (waiter) => waiter.lane === 'metadata'
      );
      if (waiterIndex < 0 && this.activeBootstrapReconciles < SESSION_RECONCILE_CONCURRENCY - 1) {
        waiterIndex = this.sessionReconcileWaiters.findIndex(
          (waiter) => waiter.lane === 'bootstrap'
        );
      }
      if (waiterIndex < 0) {
        return;
      }
      const [waiter] = this.sessionReconcileWaiters.splice(waiterIndex, 1);
      if (!waiter) {
        return;
      }
      this.markSessionReconcileSlotAcquired(waiter.lane);
      waiter.resolve();
    }
  }

  /**
   * Reconcile whether we should be watching a given session.
   *
   * Called on metadata changes and during bootstrap. Uses a lazy strategy:
   * - If not owned by this machine or archived → stop watching
   * - If owned but idle with no pending work → don't join / unwatch if watching
   * - If owned and has pending work (dispatch, cancel, active status) → join room
   *
   * This avoids eagerly joining rooms for all owned sessions on startup.
   * The metadata watch will notify us when an idle session gets new work,
   * at which point we lazily join its room.
   */
  private async reconcileSessionWatch(
    sessionId: SessionId,
    trigger: string,
    options: SessionReconcileOptions = {}
  ): Promise<void> {
    const lifecycleGeneration = options.lifecycleGeneration ?? this.lifecycleGeneration;
    const isActive = () => this.started && this.lifecycleGeneration === lifecycleGeneration;
    if (!isActive()) {
      return;
    }
    const roomId = getSessionRoomId(sessionId);
    let phase: SessionReconcilePhase = 'read-doc-meta';
    try {
      const record = await this.deps.workspaceDocument.repo.getDocMeta(roomId);
      if (!isActive()) {
        return;
      }
      const docDeleted = isLoroRepoDocDeleted(record);
      const meta = docDeleted ? undefined : (record?.meta as SessionMeta | undefined);

      phase = 'evaluate-ownership';
      const isOwned = meta?.machineId === this.deps.machineId && !meta?.isArchived;
      if (!isOwned) {
        const watched = this.watchedSessions.get(sessionId);
        watched?.unsubscribe();
        this.watchedSessions.delete(sessionId);
        this.cancelCheckChains.delete(sessionId);
        this.cancelSeenTurn.delete(sessionId);
        // Absent metadata is "unknown", not "foreign": a freshly created
        // session's RPC turn can arrive before its meta syncs to this machine.
        // Keep the TTL-bounded stash so the metadata watch dispatches it once
        // the meta lands; only a definitive verdict — deleted doc, another
        // machine's session, or an archived one — drops the stashed turn.
        if (meta || docDeleted) {
          this.rpcTurnStash.delete(sessionId);
        }
        this.interruptAccessRetry(sessionId);
        return;
      }

      // Only join the room if the session has pending work. Idle sessions with
      // no outstanding dispatch/cancel are left unwatched — the metadata watch
      // will call us again when new activity arrives.
      phase = 'evaluate-active-watch';
      if (!this.sessionNeedsActiveWatch(meta)) {
        const watched = this.watchedSessions.get(sessionId);
        if (watched) {
          watched.unsubscribe();
          this.watchedSessions.delete(sessionId);
          this.deps.logger.debug(`[${sessionId}] Unwatching idle session (no pending work)`);
        }
        // A session with no pending work has nothing to retry. If a turn were still
        // waiting on access verification, its activation would keep
        // sessionNeedsActiveWatch() true and we would not reach here.
        this.interruptAccessRetry(sessionId);
        return;
      }

      if (!this.watchedSessions.has(sessionId)) {
        phase = 'open-session-doc';
        const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
        if (!isActive()) {
          return;
        }
        phase = 'subscribe-session-doc';
        // Bootstrap and live metadata can race on the same session. Re-check
        // after the awaited open so only one subscription is installed.
        if (!this.watchedSessions.has(sessionId)) {
          const unsubscribe = sessionDoc.mirror?.subscribe(() => {
            if (isActive()) {
              void this.enqueueSessionCheck(sessionId, { lifecycleGeneration });
            }
          });
          if (unsubscribe) {
            this.watchedSessions.set(sessionId, { unsubscribe });
          }
        }
      }

      if (!isActive()) {
        return;
      }
      phase = 'enqueue-session-checks';
      const cancelCheck = this.enqueueCancelCheck(sessionId, lifecycleGeneration);
      const awaitInitialChecks = options.awaitInitialChecks === true;
      const sessionCheck = this.enqueueSessionCheck(
        sessionId,
        awaitInitialChecks
          ? {
              resolveAfterInitialProbe: true,
              reuseExistingCheck: true,
              lifecycleGeneration,
            }
          : { lifecycleGeneration }
      );
      if (awaitInitialChecks) {
        await Promise.all([cancelCheck, sessionCheck]);
      }
    } catch (error) {
      this.deps.logger.error(
        `[dispatch] Failed to reconcile session watch (sessionId=${sessionId}, roomId=${roomId}, trigger=${trigger}, phase=${phase}): ${formatErrorMessage(
          error,
          { includeStack: true }
        )}`
      );
      throw error;
    }
  }

  /**
   * Determine whether a session needs an active room connection based on its metadata.
   *
   * Returns true if the session is actively running, has a pending dispatch,
   * has an interrupted turn (crash recovery), or has an unprocessed cancel request.
   *
   * Metadata is the activation index. An idle session without a handled marker
   * is still idle unless one of the durable or process-local activation signals
   * says otherwise; opening history to infer work would fan out across every
   * historical room on startup.
   */
  private sessionNeedsActiveWatch(meta: SessionMeta): boolean {
    return shouldWatchSession({
      meta,
      hasUnprocessedCancelRequest: Boolean(
        typeof meta.lastCanceledTurn === 'string' &&
        meta.lastCanceledTurn.length > 0 &&
        meta.lastCanceledTurn !== this.cancelSeenTurn.get(meta.id)
      ),
      hasRpcTurnOffer: (this.rpcTurnStash.get(meta.id)?.size ?? 0) > 0,
      hasAccessRetry: this.accessFibers.has(meta.id),
    });
  }

  /**
   * Core dispatch logic — thin I/O shell around pure decision functions.
   *
   * 1. Gather snapshot (I/O: read meta, check in-memory state)
   * 2. Call `resolveSessionDispatchAction` (pure decision)
   * 3. Execute the returned action (I/O: reset status / start session / continue session)
   *
   * For `reset-stale-status`: execute the reset, then re-evaluate with updated snapshot.
   * For `no-dispatchable-turn`: attempt queue promotion and remote-sync retry.
   */
  private async maybeHandleSession(
    sessionId: SessionId,
    initialProbe?: InitialProbeObserver,
    lifecycleGeneration?: number
  ): Promise<void> {
    const span = startTraceSpan(this.deps.logger, 'dispatch.maybe_handle_session', { sessionId });
    let outcome = 'unknown';
    const isActive = () =>
      lifecycleGeneration === undefined ||
      (this.started && lifecycleGeneration === this.lifecycleGeneration);
    const ensureActive = () => {
      if (!isActive()) {
        throw new Error(`Session dispatch watcher lifecycle ended (${sessionId})`);
      }
    };
    try {
      if (!isActive()) {
        outcome = 'stale-lifecycle';
        return;
      }
      const sessionDoc = await traceAsync(
        this.deps.logger,
        'dispatch.open_session_doc',
        { sessionId },
        async () => await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId)
      );
      if (!isActive()) {
        outcome = 'stale-lifecycle';
        return;
      }
      const meta = await traceAsync(
        this.deps.logger,
        'dispatch.read_meta',
        { sessionId },
        async () => await sessionDoc.getMetaState()
      );
      if (!isActive()) {
        outcome = 'stale-lifecycle';
        return;
      }
      if (!meta) {
        outcome = 'no-meta';
        return;
      }

      // ── Gather snapshot ──
      const snapshot = {
        meta,
        history: [] as SessionHistoryInput[], // deferred — only needed after guard checks
        ...this.deps.executionService.getExecutionSnapshot(sessionId),
      };

      const guardAction = resolveSessionDispatchAction(snapshot, this.deps.machineId);

      // ── Handle guard/stale-status results (no history needed) ──
      if (guardAction.type === 'noop') {
        outcome = `guard-noop-${guardAction.reason}`;
        return;
      }

      if (guardAction.type === 'reset-stale-status') {
        const releaseConflict =
          this.deps.executionService.tryAcquireSessionRewriteConflictLease(sessionId);
        if (!releaseConflict) {
          outcome = 'stale-reset-blocked-by-rewrite';
          return;
        }
        this.deps.logger.debug(
          `[${sessionId}] Resetting stale '${guardAction.statusType}' status to idle (no active turn owner)`
        );
        try {
          await traceAsync(
            this.deps.logger,
            'dispatch.reset_stale_status',
            { sessionId, statusType: guardAction.statusType },
            async () => await sessionDoc.setStatus(SessionStatusFactory.idle())
          );
        } finally {
          releaseConflict();
        }
        if (!isActive()) {
          outcome = 'stale-lifecycle';
          return;
        }
        // Fall through to turn-finding below (status is now idle)
      }

      // ── Find dispatchable turn (with bounded history sync wait) ──
      const nextUserTurn = await traceAsync(
        this.deps.logger,
        'dispatch.find_or_await_turn',
        { sessionId },
        async () =>
          await this.findOrAwaitDispatchableTurn(sessionId, sessionDoc, meta, lifecycleGeneration)
      );
      initialProbe?.complete();
      if (!isActive()) {
        outcome = 'stale-lifecycle';
        return;
      }
      if (!nextUserTurn) {
        if (hasPendingUserTurnActivation(meta)) {
          outcome = 'missing-history';
          await this.markMissingUserTurnRecovery(sessionId, sessionDoc, meta);
        } else {
          outcome = 'no-dispatchable-turn';
          await this.markMessageQueueSignalChecked(sessionDoc, meta);
        }
        return;
      }
      // ── Re-read state and re-evaluate before dispatching ──
      // The wait above can take up to 5 minutes. Session state may have changed
      // (archived, reassigned, another path created a session, etc.).
      const freshMeta = await traceAsync(
        this.deps.logger,
        'dispatch.read_fresh_meta',
        { sessionId, userTurnId: nextUserTurn.id },
        async () => await sessionDoc.getMetaState()
      );
      if (!isActive()) {
        outcome = 'stale-lifecycle';
        return;
      }
      if (!freshMeta) {
        outcome = 'no-fresh-meta';
        return;
      }
      const dispatchSnapshot: SessionDispatchSnapshot = {
        meta: { ...freshMeta, status: { type: 'idle' as const } },
        history: [nextUserTurn],
        ...this.deps.executionService.getExecutionSnapshot(sessionId),
      };
      const dispatchAction = resolveSessionDispatchAction(dispatchSnapshot, this.deps.machineId);

      if (dispatchAction.type !== 'dispatch') {
        outcome = `fresh-action-${dispatchAction.type}`;
        return;
      }

      const requesterUserId = nextUserTurn.userId ?? freshMeta.userId;
      const localProjectId =
        freshMeta.project?.kind === 'local' ? freshMeta.project.localProjectId : undefined;

      // A background verify-with-retry fiber already owns this turn (from a prior
      // indeterminate result). Don't re-verify on every mirror tick — the fiber
      // re-enqueues a dispatch check once it reaches a definitive answer.
      if (this.accessFibers.get(sessionId)?.turnId === nextUserTurn.id) {
        outcome = 'access-retry-in-flight';
        return;
      }

      // Access verification, launch-config resolution, user resolution, and
      // request construction are independent DAG nodes once the dispatch turn is
      // known. Start them from a named promise node instead of stacking awaits on
      // the dispatch critical path. Optional branches get no-op catch handlers so
      // an early return on access denial cannot surface an unhandled rejection;
      // awaiting them later still rethrows the original error.
      // Keep this area modeled as a DAG; see context/cli-prompt-hot-path.md.
      const dispatchTurnPromise = Promise.resolve({
        freshMeta,
        nextUserTurn,
        requesterUserId,
        localProjectId,
      });
      const preparedLaunchConfig =
        dispatchAction.mode === 'create'
          ? this.deps.getPreparedSessionLaunchConfig?.({
              sessionMeta: freshMeta,
              requesterUserId,
            })
          : null;
      const launchConfigPromise = preparedLaunchConfig
        ? Promise.resolve(preparedLaunchConfig.config)
        : dispatchTurnPromise.then((turn) =>
            traceAsync(
              this.deps.logger,
              'dispatch.resolve_launch_config',
              { sessionId, userTurnId: turn.nextUserTurn.id },
              async () => await this.resolveSessionLaunchConfig(turn.freshMeta)
            )
          );
      void launchConfigPromise.catch(() => undefined);
      const userResolution = this.startUserResolution(sessionId, nextUserTurn.id, requesterUserId);
      const userForRequestPromise = dispatchTurnPromise.then((turn) =>
        this.resolveUserForRequest({
          meta: turn.freshMeta,
          requesterUserId: turn.requesterUserId,
          userResolution,
        })
      );
      void userForRequestPromise.catch(() => undefined);

      const requestPromise = Promise.all([
        dispatchTurnPromise,
        launchConfigPromise,
        userForRequestPromise,
      ]).then(async ([turn, launchConfig, user]) => {
        ensureActive();
        if (dispatchAction.mode === 'create') {
          const result = {
            mode: 'create' as const,
            request: await traceAsync(
              this.deps.logger,
              'dispatch.build_create_request',
              { sessionId, userTurnId: turn.nextUserTurn.id },
              async () =>
                await this.buildCreateRequestFromHistoryEntry(
                  turn.freshMeta,
                  turn.nextUserTurn,
                  launchConfig,
                  user
                )
            ),
          };
          ensureActive();
          return result;
        }
        const result = {
          mode: 'continue' as const,
          request: await traceAsync(
            this.deps.logger,
            'dispatch.build_chat_request',
            { sessionId, userTurnId: turn.nextUserTurn.id },
            async () =>
              await this.buildChatRequestFromHistoryEntry(
                turn.freshMeta,
                turn.nextUserTurn,
                launchConfig,
                user
              )
          ),
        };
        ensureActive();
        return result;
      });
      void requestPromise.catch(() => undefined);

      const accessPromise = dispatchTurnPromise.then(async (turn) => {
        ensureActive();
        const access = await traceAsync(
          this.deps.logger,
          'dispatch.verify_machine_access',
          { sessionId, userTurnId: turn.nextUserTurn.id },
          async () =>
            await this.deps.canUseMachine({
              sessionId,
              requesterUserId: turn.requesterUserId,
              localProjectId: turn.localProjectId,
            })
        );
        ensureActive();
        return access;
      });
      let executionAccessPromise: Promise<MachineAccessVerification> = accessPromise;
      let ownerRecheckStarted = false;
      // Local-first access gate (P5/R1): the catalog policy is offline-authoritative
      // for owner-cached allow and for remote_missing workspaces; only a `remote`
      // outcome falls through to the pre-started backend verify DAG node, so the
      // dominant "owner sending to their own machine" case skips the blocking wait
      // while still using the prepared-turn execution path.
      const localAccess =
        this.deps.accessPolicy && this.deps.currentUserId
          ? await Effect.runPromise(
              this.deps.accessPolicy.decide({
                workspaceId: this.deps.workspaceId,
                currentUserId: this.deps.currentUserId,
                requesterUserId,
              })
            )
          : ({ outcome: 'remote' } as const);
      if (!isActive()) {
        outcome = 'stale-lifecycle';
        return;
      }
      if (localAccess.outcome === 'deny') {
        outcome = 'access-denied';
        this.interruptAccessRetry(sessionId);
        await this.markDispatchAccessDenied(
          sessionId,
          sessionDoc,
          nextUserTurn.id,
          localAccess.reason
        );
        void accessPromise.catch(() => undefined);
        return;
      }
      if (localAccess.outcome === 'allow') {
        // Owner-cached fast path: dispatch immediately. The pre-started verify
        // is discarded (its owner fast-path answer carries no new information);
        // the REAL backend re-verification runs in the background instead, so
        // an online revocation clears the snapshot and sends the NEXT dispatch
        // back to remote verification.
        this.interruptAccessRetry(sessionId);
        void accessPromise.catch(() => undefined);
        this.fireOwnerAccessRecheck(sessionId, requesterUserId, localProjectId);
        ownerRecheckStarted = true;
        executionAccessPromise = Promise.resolve({ outcome: 'allowed' as const });
      } else {
        void accessPromise.catch(() => undefined);
      }

      const dispatchSource = this.peekTurnSourceHint(sessionId, nextUserTurn.id);
      outcome = `dispatch-prepared-${dispatchAction.mode}-${dispatchSource}`;
      ensureActive();
      await traceAsync(
        this.deps.logger,
        'dispatch.execution_prepared_session',
        { sessionId, userTurnId: nextUserTurn.id, dispatchSource, mode: dispatchAction.mode },
        async () =>
          await this.deps.executionService.dispatchPreparedSessionTurn({
            sessionId,
            sessionDoc,
            userTurnId: nextUserTurn.id,
            invocation: {
              sourceTurnId: nextUserTurn.id,
              requesterUserId: nextUserTurn.userId,
              inputConfig: nextUserTurn.inputConfig ?? {},
            },
            dispatchSource,
            accessPromise: executionAccessPromise,
            requestPromise,
            onAccessAllowed: async () => {
              ensureActive();
              this.interruptAccessRetry(sessionId);
              this.takeTurnSourceHint(sessionId, nextUserTurn.id);
              this.consumeStashedRpcTurn(sessionId, nextUserTurn.id);
              if (!ownerRecheckStarted) {
                this.fireOwnerAccessRecheck(sessionId, requesterUserId, localProjectId);
              }
            },
            onAccessDenied: async (access) => {
              ensureActive();
              // Definitive: the backend gave a real authorization answer.
              // Retrying will not change it, so fail the turn visibly.
              outcome = 'access-denied';
              this.interruptAccessRetry(sessionId);
              await this.markDispatchAccessDenied(
                sessionId,
                sessionDoc,
                nextUserTurn.id,
                access.reason
              );
            },
            onAccessIndeterminate: async () => {
              ensureActive();
              // Could not verify (network blip / backend unreachable /
              // auth-looking error). Leave the turn pending and let the retry
              // fiber re-enqueue once it reaches a definitive answer.
              outcome = 'access-indeterminate';
              this.forkAccessRetry(sessionId, sessionDoc, nextUserTurn.id, {
                requesterUserId,
                localProjectId,
              });
            },
          })
      );
    } catch (error) {
      if (!isActive()) {
        initialProbe?.complete();
        outcome = 'stale-lifecycle';
        return;
      }
      initialProbe?.fail(error);
      span.fail(error, { outcome: 'error' });
      throw error;
    } finally {
      initialProbe?.complete();
      span.end({ outcome });
    }
  }

  /**
   * P5/D11 background owner re-verification. An owner-allowed dispatch never
   * blocks on the backend, but the optimistic-allow snapshot must track real
   * backend verdicts: a confirmed online allow (re)writes it — the only source
   * of `verifiedAt` — and a definitive deny clears it, so the next dispatch
   * falls back to remote verification. `indeterminate` (offline / network
   * blip) writes nothing, preserving the snapshot write discipline: no online
   * verdict, no snapshot change. Fire-and-forget: a failed recheck just leaves
   * the snapshot as-is and never affects the already-dispatched turn.
   */
  private fireOwnerAccessRecheck(
    sessionId: SessionId,
    requesterUserId: string,
    localProjectId?: string
  ): void {
    const record = this.deps.recordOwnerAccessSnapshot;
    // The snapshot only ever represents "the current user owns this machine";
    // rechecks for foreign requesters must not touch it.
    if (!record || requesterUserId !== this.deps.currentUserId) {
      return;
    }
    void (async () => {
      const verdict = await this.deps.canUseMachine({
        sessionId,
        requesterUserId,
        localProjectId,
        forceBackendVerification: true,
      });
      if (verdict.outcome === 'allowed') {
        await record('allowed');
      } else if (verdict.outcome === 'denied') {
        await record('denied');
      }
    })().catch((error: unknown) => {
      this.deps.logger.debug(
        `[${sessionId}] Background owner access recheck failed: ${formatErrorMessage(error)}`
      );
    });
  }

  /**
   * Fork a background verify-with-retry for a transient access failure on `turnId`.
   *
   * Writes NOTHING to the session doc: the turn stays `pending` (and therefore
   * dispatchable), so the message is never dropped and the web UI keeps showing
   * "Sending" until we either dispatch it or get a definitive deny. On CLI restart
   * the still-pending turn is simply re-picked.
   *
   * The backoff policy, jitter, per-attempt timeout, and auth escalation all live
   * in {@link verifyMachineAccessWithRetry} (declarative + TestClock-tested). This
   * fiber only wires its outcome back into the watcher:
   * - allowed → re-enqueue a normal dispatch check (verification now passes fast,
   *   and the inline path dispatches with fresh metadata),
   * - denied → mark the turn failed with a visible notice.
   * Interruption (supersession / unwatch / stop) just stops the fiber.
   *
   * Mirrors the forked-fiber lifecycle already used for turns in
   * `session-execution-service.ts` (Effect.runFork + Fiber.interrupt).
   */
  private forkAccessRetry(
    sessionId: SessionId,
    sessionDoc: SessionDocumentHandle,
    turnId: string,
    verifyArgs: { requesterUserId: string; localProjectId?: string }
  ): void {
    // A newer turn supersedes any stale retry for this session.
    this.interruptAccessRetry(sessionId);

    const program = verifyMachineAccessWithRetry({
      verify: () =>
        this.deps.canUseMachine({
          sessionId,
          requesterUserId: verifyArgs.requesterUserId,
          localProjectId: verifyArgs.localProjectId,
        }),
      onAuthEscalation: () => {
        this.deps.logger.error(
          `[${sessionId}] Access verification keeps failing with an auth error; escalating`
        );
        this.deps.onFatalAuthFailure?.(
          new Error(`Machine access verification keeps failing with an auth error (${sessionId})`)
        );
      },
    }).pipe(
      Effect.flatMap(() =>
        Effect.sync(() => {
          // Clear the handle BEFORE re-enqueuing so the re-check's dedup guard
          // passes and the inline path actually dispatches (no stall).
          this.clearAccessFiberIf(sessionId, turnId);
          void this.enqueueSessionCheck(sessionId);
        })
      ),
      Effect.catchTag('AccessDenied', (denied) =>
        Effect.promise(async () => {
          this.clearAccessFiberIf(sessionId, turnId);
          await this.markDispatchAccessDenied(sessionId, sessionDoc, turnId, denied.reason).catch(
            (error: unknown) => {
              this.deps.logger.error(
                `[${sessionId}] Failed to mark turn failed after access denial: ${formatErrorMessage(error)}`
              );
            }
          );
        })
      )
    );

    this.deps.logger.debug(
      `[${sessionId}] Access verification indeterminate; keeping turn ${turnId} pending and retrying in the background`
    );
    const fiber = Effect.runFork(program);
    this.accessFibers.set(sessionId, { turnId, fiber });
  }

  /** Remove the access-retry handle for a session iff it still tracks `turnId`. */
  private clearAccessFiberIf(sessionId: SessionId, turnId: string): void {
    if (this.accessFibers.get(sessionId)?.turnId === turnId) {
      this.accessFibers.delete(sessionId);
    }
  }

  /** Interrupt and forget any running access-retry fiber for a session. */
  private interruptAccessRetry(sessionId: SessionId): void {
    const handle = this.accessFibers.get(sessionId);
    if (!handle) {
      return;
    }
    this.accessFibers.delete(sessionId);
    void Effect.runPromise(Fiber.interrupt(handle.fiber)).catch(() => {});
  }

  private getAccessDeniedMessage(reason: MachineAccessDenyReason): string {
    switch (reason) {
      case 'requester_not_member':
        return 'The requester is not a member of this workspace.';
      case 'machine_not_registered':
        return 'This machine is not registered for workspace access.';
      case 'not_visible':
        return 'This machine is private to its owner.';
      case 'project_not_shared':
        return 'This local project is not shared with the team.';
    }
    return 'Machine access was denied.';
  }

  private async markMessageQueueSignalChecked(
    sessionDoc: Awaited<ReturnType<LoroDocumentManager['getOrCreateSessionDoc']>>,
    meta: SessionMeta
  ): Promise<void> {
    const updatedAt = meta.messageQueueUpdatedAt ?? 0;
    if (updatedAt <= (meta.messageQueueCheckedAt ?? 0)) {
      return;
    }
    await this.deps.workspaceDocument.repo.upsertDocMeta(sessionDoc.roomId, {
      messageQueueCheckedAt: updatedAt,
    } satisfies Partial<SessionMeta>);
  }

  private async markDispatchAccessDenied(
    sessionId: SessionId,
    sessionDoc: Awaited<ReturnType<LoroDocumentManager['getOrCreateSessionDoc']>>,
    userTurnId: string,
    reason: MachineAccessDenyReason
  ): Promise<void> {
    const message = this.getAccessDeniedMessage(reason);
    this.deps.logger.warn(`[${sessionId}] Refusing dispatch: ${message}`);

    let entryMatched = false;
    await sessionDoc.updateHistory((history) =>
      history.map((entry) => {
        if (entry.id !== userTurnId || entry.role !== 'user') {
          return entry;
        }
        entryMatched = true;
        return {
          ...entry,
          status: 'failed' as const,
          read: getLegacyReadForSessionHistoryStatus('failed'),
        };
      })
    );
    // An RPC-stashed turn can be denied before its history entry syncs; record
    // the failure so the late entry gets repaired to 'failed' instead of
    // re-dispatched, and drop the stash copy so it cannot loop back in.
    if (!entryMatched) {
      this.deps.executionService.recordTerminalUserTurnStatusWithoutEntry?.(
        sessionId,
        userTurnId,
        'failed'
      );
    }
    this.consumeStashedRpcTurn(sessionId, userTurnId);

    await this.deps.workspaceDocument.repo.upsertDocMeta?.(getSessionRoomId(sessionId), {
      lastHandledUserMsgId: userTurnId,
      processingUserMsgId: undefined,
    } satisfies Partial<SessionMeta>);
    await sessionDoc.setStatus(SessionStatusFactory.idle());

    // Surface the denial to the user. Without this the turn renders as
    // "Delivered" in the web UI (isSessionHistoryDelivered treats any non-pending
    // status as delivered), so a genuine denial would look like a successful send.
    await this.deps.recordChatFailure?.(sessionDoc, 'machine_access_denied', message);
  }

  /**
   * Cancel logic — thin I/O shell around {@link resolveSessionCancelAction}.
   */
  private async maybeHandleCancelRequest(
    sessionId: SessionId,
    lifecycleGeneration?: number
  ): Promise<void> {
    const isActive = () =>
      lifecycleGeneration === undefined ||
      (this.started && lifecycleGeneration === this.lifecycleGeneration);
    if (!isActive()) {
      return;
    }
    const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
    if (!isActive()) {
      return;
    }
    const meta = await sessionDoc.getMetaState();
    if (!isActive()) {
      return;
    }

    const action = resolveSessionCancelAction(
      meta ?? undefined,
      this.cancelSeenTurn.get(sessionId),
      this.deps.machineId
    );

    if (action.type === 'noop') {
      return;
    }

    if (!isActive()) {
      return;
    }
    this.cancelSeenTurn.set(sessionId, action.turnId);
    await this.deps.executionService.cancelSession({
      type: 'session/cancel',
      sessionId,
      machineId: this.deps.machineId,
      workspaceId: this.deps.workspaceId,
      turnId: action.turnId,
    });
    if (!isActive()) {
      return;
    }
    await this.reconcileSessionWatch(sessionId, 'cancel-processed', {
      lifecycleGeneration,
    });
  }

  private fallbackUserProfile(userId: string): SessionUserProfile {
    const email = buildMissingEmail('lody', userId);
    return {
      id: userId,
      name: email,
      email,
    };
  }

  private startUserResolution(
    sessionId: SessionId,
    userTurnId: string,
    requesterUserId: string
  ): {
    promise: Promise<SessionUserProfile>;
    getSettled: () => SessionUserProfile | undefined;
  } {
    let settled: SessionUserProfile | undefined;
    const promise = traceAsync(
      this.deps.logger,
      'dispatch.resolve_user',
      { sessionId, userTurnId },
      async () => await this.userResolver.resolve(requesterUserId)
    )
      .then((user) => {
        settled = user;
        return user;
      })
      .catch((error: unknown) => {
        const fallback = this.fallbackUserProfile(requesterUserId);
        settled = fallback;
        this.deps.logger.debug(
          `[${sessionId}] Falling back to synthetic user profile for ${requesterUserId}: ${formatErrorMessage(error)}`
        );
        return fallback;
      });
    return {
      promise,
      getSettled: () => settled,
    };
  }

  private shouldBlockForUserIdentity(meta: SessionMeta): boolean {
    return Boolean(meta.project || meta.parentSessionId);
  }

  private async resolveUserForRequest(args: {
    meta: SessionMeta;
    requesterUserId: string;
    userResolution: {
      promise: Promise<SessionUserProfile>;
      getSettled: () => SessionUserProfile | undefined;
    };
  }): Promise<SessionUserProfile> {
    if (this.shouldBlockForUserIdentity(args.meta)) {
      return await args.userResolution.promise;
    }
    return args.userResolution.getSettled() ?? this.fallbackUserProfile(args.requesterUserId);
  }

  private async buildChatRequestFromHistoryEntry(
    meta: SessionMeta,
    entry: SessionHistoryInput,
    launchConfig: SessionLaunchConfig | undefined,
    user: SessionUserProfile
  ): Promise<SessionChatRequestValidated> {
    const project: ProjectRef | undefined = meta.project;
    const { inputBlocks, prompt } = this.resolveDispatchInput(entry);

    return {
      type: 'session/chat',
      sessionId: meta.id,
      machineId: this.deps.machineId,
      workspaceId: this.deps.workspaceId,
      project,
      acpSessionConfig: {
        prompt,
        inputBlocks: inputBlocks.length > 0 ? inputBlocks : undefined,
        cliType: entry.inputConfig?.cliType ?? meta.cliType,
        agentType: entry.inputConfig?.agentType ?? meta.agentType,
        customAcp: entry.inputConfig?.customAcp ?? launchConfig?.customAcp,
        runtimeOverrides: entry.inputConfig?.runtimeOverrides ?? launchConfig?.runtimeOverrides,
        modeId: entry.inputConfig?.modeId,
        modelId: entry.inputConfig?.modelId,
        configOptionValues: entry.inputConfig?.configOptionValues,
        mcpServerIds: entry.inputConfig?.mcpServerIds ?? [],
        taskToolsEnabled: entry.inputConfig?.taskToolsEnabled === true,
        agentRoleId: entry.inputConfig?.agentRoleId,
        agentRoleRevision: entry.inputConfig?.agentRoleRevision,
        issuePRMentions: entry.inputConfig?.issuePRMentions,
        resume: entry.inputConfig?.resume ?? resolveDispatchAcpSessionId(meta),
      },
      userTurnId: entry.id,
      userId: entry.userId ?? meta.userId,
      userName: user.name,
      userEmail: user.email,
    };
  }

  private async buildCreateRequestFromHistoryEntry(
    meta: SessionMeta,
    entry: SessionHistoryInput,
    launchConfig: SessionLaunchConfig | undefined,
    user: SessionUserProfile
  ): Promise<SessionCreateRequestValidated> {
    const project: ProjectRef | undefined = meta.project;
    const { inputBlocks, prompt } = this.resolveDispatchInput(entry);

    return {
      type: 'session/create',
      sessionId: meta.id,
      machineId: this.deps.machineId,
      workspaceId: this.deps.workspaceId,
      project,
      meta: meta.fromFeedbackPostId
        ? {
            fromFeedbackPostId: meta.fromFeedbackPostId,
          }
        : undefined,
      acpSessionConfig: {
        prompt,
        inputBlocks: inputBlocks.length > 0 ? inputBlocks : undefined,
        cliType: entry.inputConfig?.cliType ?? meta.cliType,
        agentType: entry.inputConfig?.agentType ?? meta.agentType,
        customAcp: entry.inputConfig?.customAcp ?? launchConfig?.customAcp,
        runtimeOverrides: entry.inputConfig?.runtimeOverrides ?? launchConfig?.runtimeOverrides,
        modeId: entry.inputConfig?.modeId,
        modelId: entry.inputConfig?.modelId,
        configOptionValues: entry.inputConfig?.configOptionValues,
        mcpServerIds: entry.inputConfig?.mcpServerIds ?? [],
        taskToolsEnabled: entry.inputConfig?.taskToolsEnabled === true,
        agentRoleId: entry.inputConfig?.agentRoleId,
        agentRoleRevision: entry.inputConfig?.agentRoleRevision,
        issuePRMentions: entry.inputConfig?.issuePRMentions,
        resume: entry.inputConfig?.resume,
      },
      worktreeSetup: launchConfig?.worktreeSetup,
      worktreeCleanup: launchConfig?.worktreeCleanup,
      env: launchConfig?.env,
      userTurnId: entry.id,
      userId: entry.userId ?? meta.userId,
      userName: user.name,
      userEmail: user.email,
      parentSessionId: meta.parentSessionId,
    };
  }

  private async resolveSessionLaunchConfig(
    meta: SessionMeta
  ): Promise<SessionLaunchConfig | undefined> {
    return (
      await resolveSessionLaunchConfig({
        workspaceDocument: this.deps.workspaceDocument,
        workspaceId: this.deps.workspaceId,
        machineId: this.deps.machineId,
        sessionId: meta.id,
        sessionMeta: meta,
        logger: this.deps.logger,
      })
    ).config;
  }

  private resolveDispatchInput(entry: SessionHistoryInput): {
    inputBlocks: ReturnType<typeof resolveDispatchTurnInput>['inputBlocks'];
    prompt: string;
  } {
    return resolveDispatchTurnInput(entry);
  }

  /**
   * Try to pop a message from the session's message queue and promote it into
   * a history entry. This handles the case where the web client enqueues messages
   * via the message queue API instead of writing directly to the session history.
   *
   * This is an I/O operation (mutates the session doc by popping the queue and
   * appending to history), which is why it lives in the watcher rather than in
   * the pure turn-finding logic.
   */
  private async promoteNextQueuedMessage(
    sessionDoc: Awaited<ReturnType<LoroDocumentManager['getOrCreateSessionDoc']>>,
    meta: SessionMeta,
    history: SessionHistoryInput[]
  ): Promise<SessionHistoryInput | null> {
    const releaseQueueMutation = this.deps.executionService.tryAcquireSessionRewriteConflictLease(
      meta.id
    );
    if (!releaseQueueMutation) {
      return null;
    }
    try {
      const popMessageQueue = (
        sessionDoc as { popMessageQueue?: (() => Promise<MessageQueueItem | null>) | undefined }
      ).popMessageQueue;
      if (!popMessageQueue) {
        return null;
      }

      const queuedItem = await popMessageQueue.call(sessionDoc);
      if (!queuedItem) {
        return null;
      }

      const queuedTurnId = queuedItem.userTurnId?.trim() || `queued-${queuedItem.$cid}`;
      if (history.some((entry) => entry.id === queuedTurnId)) {
        this.deps.logger.debug(
          `[${meta.id}] Dropping already-promoted queued message ${queuedItem.$cid}`
        );
        return null;
      }

      const inputBlocks = normalizeSessionInputBlocks(
        queuedItem.acpSessionConfig?.inputBlocks,
        queuedItem.acpSessionConfig?.prompt ?? queuedItem.task
      );
      const inputConfig = buildSessionTurnInputConfig({
        inputBlocks,
        prompt:
          queuedItem.acpSessionConfig?.prompt ?? extractPromptPreviewFromInputBlocks(inputBlocks),
        cliType: queuedItem.acpSessionConfig?.cliType ?? meta.cliType,
        agentType: queuedItem.acpSessionConfig?.agentType ?? meta.agentType,
        modeId: queuedItem.acpSessionConfig?.modeId,
        modelId: queuedItem.acpSessionConfig?.modelId,
        configOptionValues: isConfigOptionValueRecord(
          queuedItem.acpSessionConfig?.configOptionValues
        )
          ? queuedItem.acpSessionConfig.configOptionValues
          : undefined,
        mcpServerIds:
          normalizeMcpServerIdSelection(queuedItem.acpSessionConfig?.mcpServerIds) ?? [],
        taskToolsEnabled: queuedItem.acpSessionConfig?.taskToolsEnabled === true,
        agentRoleId: queuedItem.acpSessionConfig?.agentRoleId,
        agentRoleRevision: queuedItem.acpSessionConfig?.agentRoleRevision,
        issuePRMentions: queuedItem.acpSessionConfig?.issuePRMentions,
        resume: resolveResumableAcpSessionId(meta),
      });
      const pendingEntry = buildPendingUserHistoryEntry({
        userId: queuedItem.userId ?? meta.userId,
        inputBlocks,
        timestamp: queuedItem.timestamp,
        inputConfig,
      });

      if (!pendingEntry) {
        this.deps.logger.debug(`[${meta.id}] Dropping invalid queued message ${queuedItem.$cid}`);
        return null;
      }

      const entry: SessionHistoryInput = {
        ...pendingEntry,
        id: queuedTurnId,
      };

      // Promotion is a dispatch producer; `appendUserTurn` publishes the pointer.
      await sessionDoc.appendUserTurn(entry);
      return entry;
    } finally {
      releaseQueueMutation();
    }
  }

  /** Maximum time (ms) to wait for a pending user-turn pointer to appear in history. */
  private static readonly HISTORY_SYNC_WAIT_TIMEOUT_MS = 5 * 60_000;
  private static readonly HISTORY_SYNC_PROGRESS_LOG_MS = 30_000;
  private static readonly HISTORY_RECONNECT_JITTER_MIN_MS = 500;
  private static readonly HISTORY_RECONNECT_JITTER_MAX_MS = 1_500;
  private static readonly HISTORY_RECONNECT_BASE_DELAY_MS = 1_000;
  private static readonly HISTORY_RECONNECT_MAX_DELAY_MS = 15_000;
  private static setUnrefTimeout(
    callback: () => void,
    delayMs: number
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(callback, delayMs);
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }
    return timer;
  }

  private static sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      SessionDispatchWatcher.setUnrefTimeout(resolve, delayMs);
    });
  }

  private static getReconnectJitterMs(): number {
    const min = SessionDispatchWatcher.HISTORY_RECONNECT_JITTER_MIN_MS;
    const max = SessionDispatchWatcher.HISTORY_RECONNECT_JITTER_MAX_MS;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /**
   * Try to find a dispatchable turn with a two-phase strategy:
   *
   * 1. **Immediate**: check local history and message queue.
   * 2. **Pending meta wait**: if meta explicitly points at an unhandled user
   *    turn, keep the history room joined and wait up to 5 minutes. This covers
   *    the case where MetaDoc sync races ahead of the SessionDoc history CRDT.
   * Sessions without an explicit pointer do not wait: metadata and RPC are the
   * activation index and will enqueue a fresh check when work arrives.
   */
  private async findOrAwaitDispatchableTurn(
    sessionId: SessionId,
    sessionDoc: Awaited<ReturnType<LoroDocumentManager['getOrCreateSessionDoc']>>,
    meta: SessionMeta,
    lifecycleGeneration?: number
  ): Promise<SessionHistoryInput | null> {
    const isActive = () => this.isLifecycleActive(lifecycleGeneration);
    // Phase 1: check immediately with whatever data we have locally
    // (history → queue → RPC stash).
    const { turn, history } = await this.checkHistoryAndQueue(sessionDoc, meta, isActive);
    if (!isActive()) {
      return null;
    }
    if (turn) {
      return turn;
    }

    const pendingUserTurnId = getPendingUserTurnActivationId(meta);
    if (!pendingUserTurnId) {
      return null;
    }
    // Phase 2 is a wait for HISTORY, so it is only meaningful while history can
    // still explain the pointer. If the entry is already here and terminal, the
    // check above just judged it and declined: waiting cannot change that, and
    // the recovery that follows would accuse a turn that already ran. Settling
    // the pointer instead keeps that path for genuinely undelivered turns.
    if (!isActivationAwaitingHistory(history, pendingUserTurnId)) {
      if (await this.settleTerminalActivation(sessionId, pendingUserTurnId)) {
        return null;
      }
    }
    return await this.waitForPendingUserTurnHistorySync(
      sessionId,
      sessionDoc,
      meta,
      lifecycleGeneration
    );
  }

  /**
   * Retire an activation whose turn is already terminal in history.
   *
   * Records the settlement in its own slot rather than rewriting the pointers.
   * `latestUserMsgId` is producer-owned and there is no CAS against a Loro LWW
   * map, so a send published between this read and this write would otherwise be
   * overwritten — and a fresh turn whose entry has not synced yet would lose its
   * activation entirely, going unwatched and silently unrun. `settledActivationUserMsgId`
   * suppresses only a matching pointer, and the turn it names is already
   * terminal, so a later settlement may replace it freely — unlike
   * `lastMissingHistoryUserMsgId`, whose eviction would revive a pending turn.
   *
   * `processingUserMsgId` is different: it is execution-owned, dispatch is
   * serialized per session, and we only reach here with no active turn, so
   * clearing a slot whose turn is verifiably terminal is safe and repairs a
   * crashed-mid-turn leftover.
   *
   * Returns whether the session is now settled. A patch that retires THIS
   * activation while a different one survives must report false, or the caller
   * short-circuits into missing-history recovery and accuses that survivor of
   * never being delivered.
   */
  private async settleTerminalActivation(
    sessionId: SessionId,
    terminalUserTurnId: string
  ): Promise<boolean> {
    const roomId = getSessionRoomId(sessionId);
    const record = await this.deps.workspaceDocument.repo.getDocMeta(roomId);
    const meta = isLoroRepoDocDeleted(record)
      ? undefined
      : (record?.meta as SessionMeta | undefined);
    if (!meta) {
      return false;
    }
    const clearsProcessing = meta.processingUserMsgId === terminalUserTurnId;
    const retiresLatest = meta.latestUserMsgId === terminalUserTurnId;
    const patch: Partial<SessionMeta> = {
      ...(clearsProcessing ? { processingUserMsgId: undefined } : {}),
      ...(retiresLatest ? { settledActivationUserMsgId: terminalUserTurnId } : {}),
    };
    if (!clearsProcessing && !retiresLatest) {
      return false;
    }
    this.deps.logger.debug(
      `[${sessionId}] Settling stale activation ${terminalUserTurnId}; its history entry is already terminal`
    );
    await this.deps.workspaceDocument.repo.upsertDocMeta?.(roomId, patch);
    return !hasPendingUserTurnActivation({ ...meta, ...patch });
  }

  /**
   * Metadata already points at a user turn, but the turn is not visible in the
   * session history yet. Keep the history room joined for one bounded window
   * instead of repeatedly unloading/reopening the document.
   *
   * Intentionally does NOT mutate `session.status`. Changing status to
   * `initializing` here creates misleading durable activity for legacy readers;
   * live UI should rely on ephemeral presence for "Working/Thinking".
   */
  private async waitForPendingUserTurnHistorySync(
    sessionId: SessionId,
    sessionDoc: SessionDocumentHandle,
    meta: SessionMeta,
    lifecycleGeneration?: number
  ): Promise<SessionHistoryInput | null> {
    const isActive = () => this.isLifecycleActive(lifecycleGeneration);
    if (!isActive()) {
      return null;
    }
    const pendingUserTurnId = getPendingUserTurnActivationId(meta);
    this.deps.logger.debug(
      `[${sessionId}] Pending user turn ${
        pendingUserTurnId ?? 'unknown'
      } has no history entry yet; waiting up to ${
        SessionDispatchWatcher.HISTORY_SYNC_WAIT_TIMEOUT_MS / 1000
      }s for history CRDT sync`
    );

    return await new Promise<SessionHistoryInput | null>((resolve) => {
      let settled = false;
      let currentMeta = meta;
      let checkRunning = false;
      let checkRequested = false;
      let exitWhenCheckIsEmpty = false;
      let reconnectAttempts = 0;
      let reconnectInFlight = false;
      let unsubscribeMirror: (() => void) | undefined;
      let unsubscribeStatus: (() => void) | undefined;
      let unsubscribeRpcOffers: (() => void) | undefined;
      let unsubscribeLifecycle: (() => void) | undefined;
      let progressTimer: ReturnType<typeof setInterval> | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waitStartedAt = Date.now();

      const finish = (turn: SessionHistoryInput | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        if (progressTimer) {
          clearInterval(progressTimer);
        }
        unsubscribeMirror?.();
        unsubscribeStatus?.();
        unsubscribeRpcOffers?.();
        unsubscribeLifecycle?.();
        resolve(turn);
      };

      unsubscribeLifecycle = this.subscribeToLifecycleCancel(lifecycleGeneration, () => {
        finish(null);
      });
      if (settled) {
        return;
      }

      // Mirror updates, RPC offers, and sync completion can arrive together.
      // Serialize their checks because queue promotion mutates the session doc.
      const requestTurnCheck = () => {
        if (settled || !isActive()) {
          finish(null);
          return;
        }
        checkRequested = true;
        if (checkRunning) {
          return;
        }
        checkRunning = true;
        void (async () => {
          try {
            while (checkRequested) {
              checkRequested = false;
              const { turn } = await this.checkHistoryAndQueue(sessionDoc, currentMeta, isActive);
              if (settled || !isActive()) {
                finish(null);
                return;
              }
              if (turn) {
                this.deps.logger.debug(
                  `[${sessionId}] Found dispatchable turn while waiting for history CRDT sync`
                );
                finish(turn);
                return;
              }
            }
            if (exitWhenCheckIsEmpty && !settled) {
              finish(null);
            }
          } catch (error) {
            this.deps.logger.debug(
              `[${sessionId}] Error checking history during history sync wait: ${formatErrorMessage(
                error
              )}`
            );
          } finally {
            checkRunning = false;
            if (checkRequested && !settled) {
              requestTurnCheck();
            }
          }
        })();
      };

      // A pending user-turn pointer means the payload SHOULD arrive; a dead
      // room subscription must therefore keep retrying for the whole wait
      // window (capped exponential backoff + jitter), not give up after one
      // attempt — a single early rejoin used to race the web client's
      // background stream creation and lose.
      const scheduleReconnect = (reason: string) => {
        if (settled || reconnectInFlight || !isActive()) {
          if (!isActive()) {
            finish(null);
          }
          return;
        }
        reconnectInFlight = true;
        void (async () => {
          // First attempt keeps the original jitter-only delay; later attempts
          // back off exponentially up to the cap.
          const backoffMs =
            reconnectAttempts === 0
              ? 0
              : Math.min(
                  SessionDispatchWatcher.HISTORY_RECONNECT_BASE_DELAY_MS *
                    2 ** (reconnectAttempts - 1),
                  SessionDispatchWatcher.HISTORY_RECONNECT_MAX_DELAY_MS
                );
          const delayMs = backoffMs + SessionDispatchWatcher.getReconnectJitterMs();
          reconnectAttempts += 1;
          this.deps.logger.debug(
            `[${sessionId}] Session history room ${reason}; rejoin attempt ${reconnectAttempts} in ${delayMs}ms`
          );
          await SessionDispatchWatcher.sleep(delayMs);
          if (settled || !isActive()) {
            reconnectInFlight = false;
            if (!isActive()) {
              finish(null);
            }
            return;
          }
          try {
            await sessionDoc.rejoinDocRoom();
          } catch (error) {
            this.deps.logger.debug(
              `[${sessionId}] Session history room rejoin failed: ${formatErrorMessage(error)}`
            );
          }
          reconnectInFlight = false;
          if (!isActive()) {
            finish(null);
            return;
          }
          requestTurnCheck();
          if (settled) {
            return;
          }
          const status = sessionDoc.getDocRoomStatus();
          if (!status || status === 'disconnected' || status === 'error') {
            scheduleReconnect('is still not connected');
          }
        })();
      };

      const handleRoomStatus = (status: RepoTransportRoomStatus | undefined) => {
        if (settled || !isActive() || !status) {
          if (!isActive()) {
            finish(null);
          }
          return;
        }
        if (status === 'disconnected' || status === 'error') {
          scheduleReconnect(status);
        }
      };

      timer = SessionDispatchWatcher.setUnrefTimeout(() => {
        this.deps.logger.warn(
          `[${sessionId}] User turn ${pendingUserTurnId ?? 'unknown'} did not arrive in history after ${
            SessionDispatchWatcher.HISTORY_SYNC_WAIT_TIMEOUT_MS / 1000
          }s; entering dispatch recovery`
        );
        finish(null);
      }, SessionDispatchWatcher.HISTORY_SYNC_WAIT_TIMEOUT_MS);
      progressTimer = setInterval(() => {
        if (settled || !isActive()) {
          if (!isActive()) {
            finish(null);
          }
          return;
        }
        this.deps.logger.warn(
          `[${sessionId}] Still waiting for pending user turn history sync (pendingUserMsgId=${
            pendingUserTurnId ?? 'unknown'
          } elapsed=${Date.now() - waitStartedAt}ms docRoom=${
            sessionDoc.getDocRoomStatus() ?? 'unknown'
          })`
        );
      }, SessionDispatchWatcher.HISTORY_SYNC_PROGRESS_LOG_MS);
      progressTimer.unref?.();

      if (!isActive()) {
        finish(null);
        return;
      }

      // Subscribe before starting Doc Room synchronization. An RPC offer that
      // arrives during join retries is a complete turn source and must preempt
      // the CRDT wait without bypassing the serialized dispatch chain.
      unsubscribeRpcOffers = this.subscribeToRpcTurnOffers(sessionId, requestTurnCheck);
      unsubscribeMirror = sessionDoc.mirror?.subscribe(requestTurnCheck);
      if (!unsubscribeMirror) {
        this.deps.logger.debug(
          `[${sessionId}] Session mirror is unavailable during history sync wait`
        );
      }

      unsubscribeStatus = sessionDoc.onDocRoomStatusChange(handleRoomStatus);
      const currentStatus = sessionDoc.getDocRoomStatus();
      if (currentStatus) {
        handleRoomStatus(currentStatus);
      } else {
        scheduleReconnect('has no active subscription');
      }

      // Close the check-to-subscribe race, then let CRDT readiness feed the
      // same coordinator. The recovery timeout covers this entire preflight;
      // neither join retries nor waitUntilSynced extend it.
      requestTurnCheck();
      void (async () => {
        try {
          await sessionDoc.ensureDocRoomJoined();
        } catch (error) {
          this.deps.logger.debug(
            `[${sessionId}] Failed to ensure session history room is joined before waiting: ${formatErrorMessage(
              error
            )}`
          );
        }
        if (settled || !isActive()) {
          if (!isActive()) {
            finish(null);
          }
          return;
        }

        await sessionDoc.waitUntilSynced();
        if (settled || !isActive()) {
          if (!isActive()) {
            finish(null);
          }
          return;
        }

        // The input meta can come from a workspace projection that lags the
        // session doc. Refresh it only after initial sync, then perform one
        // final serialized source check before honoring a cleared pointer.
        currentMeta = (await sessionDoc.getMetaState()) ?? currentMeta;
        if (!isActive()) {
          finish(null);
          return;
        }
        if (!hasPendingUserTurnActivation(currentMeta)) {
          this.deps.logger.debug(
            `[${sessionId}] Pending user turn pointer cleared during pre-wait sync; exiting wait`
          );
          exitWhenCheckIsEmpty = true;
        }
        requestTurnCheck();
      })().catch((error: unknown) => {
        if (settled) {
          return;
        }
        this.deps.logger.debug(
          `[${sessionId}] Session history sync preflight failed: ${formatErrorMessage(error)}`
        );
      });
    });
  }

  private async markMissingUserTurnRecovery(
    sessionId: SessionId,
    sessionDoc: SessionDocumentHandle,
    previousMeta: SessionMeta
  ): Promise<void> {
    const roomId = getSessionRoomId(sessionId);
    let meta = previousMeta;

    try {
      const record = await this.deps.workspaceDocument.repo.getDocMeta(roomId);
      if (!isLoroRepoDocDeleted(record) && record?.meta) {
        meta = record.meta as SessionMeta;
      }
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to refresh metadata before dispatch recovery: ${formatErrorMessage(
          error
        )}`
      );
    }

    if (
      meta.machineId !== this.deps.machineId ||
      meta.isArchived ||
      !hasPendingUserTurnActivation(meta)
    ) {
      return;
    }

    // Rejected: advancing `lastHandledUserMsgId` here. The machine never read
    // the turn payload, so "handled" would poison dispatch and silently drop a
    // late-arriving history entry. Use an explicit recovery marker instead.
    const pendingUserMsgId = getPendingUserTurnActivationId(meta);
    const recoveryPatch: Partial<SessionMeta> = {
      status: SessionStatusFactory.idle(),
    };
    if (pendingUserMsgId) {
      recoveryPatch.lastMissingHistoryUserMsgId = pendingUserMsgId;
    }
    this.deps.logger.warn(
      `[${sessionId}] Marking missing-history recovery for user turn ${pendingUserMsgId ?? 'unknown'} (message_delivery_failed)`
    );
    await this.deps.workspaceDocument.repo.upsertDocMeta?.(roomId, recoveryPatch);
    this.deps.logger.info(
      `[${sessionId}] Recorded missing-history recovery for user turn ${
        pendingUserMsgId ?? 'unknown'
      }; the turn stays undispatchable until the user explicitly redelivers it`
    );

    if (this.deps.recordChatFailure) {
      try {
        await this.deps.recordChatFailure(
          sessionDoc,
          'message_delivery_failed',
          'The user message could not be delivered because its history payload did not sync to this machine. Please resend it after sync recovers.'
        );
      } catch (error) {
        this.deps.logger.debug(
          `[${sessionId}] Failed to record missing-history delivery failure: ${formatErrorMessage(
            error
          )}`
        );
      }
    }

    const watched = this.watchedSessions.get(sessionId);
    watched?.unsubscribe();
    this.watchedSessions.delete(sessionId);
    await this.deps.workspaceDocument.cleanSessionDoc(sessionId, { preserveStatus: true });
  }

  /**
   * Check the three turn sources in order: history → message queue → RPC stash.
   * Shared by the initial check and every wait loop, so a stashed RPC payload
   * is picked up wherever the watcher would otherwise sit waiting for the
   * history CRDT.
   *
   * The returned snapshot predates queue promotion, but every path that appends also returns
   * a turn — so it is accurate whenever `turn` is null, which is the only case
   * a caller can act on it.
   */
  private async checkHistoryAndQueue(
    sessionDoc: Awaited<ReturnType<LoroDocumentManager['getOrCreateSessionDoc']>>,
    meta: SessionMeta,
    isActive: () => boolean = () => true
  ): Promise<{ turn: SessionHistoryInput | null; history: SessionHistoryInput[] }> {
    const history = await sessionDoc.getHistory();
    if (!isActive()) {
      return { turn: null, history };
    }
    const turn = findNextDispatchableUserTurn(history, meta);
    if (turn) {
      const repaired = await this.maybeRepairAlreadyHandledTurn(sessionDoc, meta, turn, history);
      if (repaired) {
        // The repaired entry no longer matches; re-scan so an older repaired
        // turn cannot mask a genuinely dispatchable newer one.
        return await this.checkHistoryAndQueue(sessionDoc, meta, isActive);
      }
      // The history copy is authoritative once it syncs; drop the RPC copy.
      this.consumeStashedRpcTurn(meta.id, turn.id);
      return { turn, history };
    }
    if (!isActive()) {
      return { turn: null, history };
    }
    const promoted = await this.promoteNextQueuedMessage(sessionDoc, meta, history);
    if (!isActive()) {
      return { turn: null, history };
    }
    if (promoted) {
      this.turnSourceHints.set(`${meta.id}:${promoted.id}`, 'queue');
      return { turn: promoted, history };
    }
    return { turn: this.peekStashedRpcTurn(meta.id, meta, history), history };
  }

  /**
   * Late-entry reconciliation for RPC fast-path turns: when a turn already ran
   * from the RPC payload before its history entry synced, the entry lands as
   * `pending` and — because entry status dominates meta pointers in
   * `findNextDispatchableUserTurn` — would be dispatched a second time. Detect
   * that case, repair the entry to its recorded terminal status (also fixing
   * the sender's delivery indicator), and skip dispatch.
   *
   * `processingUserMsgId === turn.id` always wins: that is crash-mid-turn
   * recovery, which must re-dispatch and reuses the same assistant entry.
   */
  private async maybeRepairAlreadyHandledTurn(
    sessionDoc: SessionDocumentHandle,
    meta: SessionMeta,
    turn: SessionHistoryInput,
    history: SessionHistoryInput[]
  ): Promise<boolean> {
    const sessionId = meta.id;
    if (meta.processingUserMsgId === turn.id) {
      return false;
    }

    // Prefer the exact terminal status recorded in memory (handled/failed/
    // canceled). This is the only source that distinguishes success from a
    // denied/canceled turn, so it must win over the durable backstops below.
    let terminalStatus = this.deps.executionService.getTerminalUserTurnStatusWithoutEntry?.(
      sessionId,
      turn.id
    );
    if (!terminalStatus && turn.status === 'pending') {
      // Restart backstop (in-memory record is gone): a completed assistant
      // entry linked to this user turn is positive proof it ran to completion.
      // endedAt is written at ACP finalization. Only this proves 'handled'.
      const assistantCompleted = history.some(
        (entry) =>
          entry.role === 'assistant' &&
          entry.userTurnId === turn.id &&
          typeof entry.endedAt === 'number'
      );
      if (assistantCompleted) {
        terminalStatus = 'handled';
      } else if (meta.lastHandledUserMsgId === turn.id) {
        // The dispatch pointer advanced past this turn on this machine, but
        // with no completed assistant entry it did NOT finish successfully
        // (denied access, cancel, or pre-prompt failure whose exact kind was
        // lost on restart). Repair to 'failed' — a safe non-success terminal
        // that prevents re-dispatch without falsely reporting success. A
        // chat_failed notice was already surfaced when the terminal write
        // happened, so the user still sees the real outcome.
        terminalStatus = 'failed';
      }
    }
    if (!terminalStatus) {
      return false;
    }

    const status = terminalStatus;
    this.deps.logger.debug(
      `[${sessionId}] Repairing late-arriving user turn ${turn.id} to '${status}' (already executed via fast path)`
    );
    await sessionDoc.updateHistory((entries) =>
      entries.map((entry) =>
        entry.id === turn.id && entry.role === 'user'
          ? {
              ...entry,
              status,
              read: getLegacyReadForSessionHistoryStatus(status),
            }
          : entry
      )
    );
    this.deps.executionService.clearTerminalUserTurnStatusWithoutEntry?.(sessionId, turn.id);
    this.consumeStashedRpcTurn(sessionId, turn.id);
    return true;
  }
}
