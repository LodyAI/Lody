import { useSessionOwnerAccess } from './use-session-owner-access';
import { useSessionManagementGuard } from './use-session-management-guard';
import { useLegacyWorkspaceMutation } from '@/hooks/use-legacy-workspace-query';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import { useCallback, useMemo, useRef } from 'react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useCloudQuery } from '@lody/platform/react';
import type {
  Session,
  SessionStatus,
  SessionHistory,
  SessionHistoryInput,
  SessionId,
  SessionMeta,
  SessionToCreate,
  MachineId,
  MachineLegacyMetaFields,
  SessionTurnInputConfig,
  MachineFlockKey,
  SessionGoalAction,
  SessionGoalResponse,
} from '@lody/shared';
import {
  getMachineRoomId,
  getMachineFlockDocId,
  getMachineFlockDeleteLocalProjectIds,
  getMachineFlockLocalProjects,
  getSessionRoomId,
  machineFlockKeys,
  SessionStatusFactory,
  getLocalProjectHistoryProviderKey,
  getServerNow,
  LEGACY_SESSION_HISTORY_BACKEND,
  ROOST_SESSION_HISTORY_BACKEND,
  evaluateSessionCreateQuota,
  formatSessionQuotaRejection,
  isConvexUnauthenticatedError,
  isLoroRepoDocDeleted,
  readMachineFlockRowsFromFlock,
  sanitizeMessageTextSpans,
  machineSupportsProtocolCapability,
  MACHINE_PROTOCOL_CAPABILITIES,
  OPERATION_INBOX_PROTOCOL_VERSION,
  planStatusViewCommand,
  type StatusViewCommand,
  type StatusViewState,
  type StatusViewWrite,
  getSessionCancelRequestMarker,
} from '@lody/shared';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { usePostHog } from '@/lib/posthog-context';
// Default import: `debug` is CJS. Named `{ debug }` breaks Vite 8 / TanStack
// module-runner interop used by site-docs SSR (UNEXPECTED named-export error).
import debug from 'debug';
import {
  activeWorkspaceRuntimeAtom,
  type SessionDocDraft,
  type WorkspaceRuntime,
} from '@/atoms/runtime';
import {
  clearSessionRunConfigDraftsAtom,
  sessionRunConfigDraftAccountAtom,
} from '@/atoms/session-run-config-drafts';
import {
  setDocMetaByRoomIdAtom,
  sessionMetaCacheAtom,
  sessionMetaCountAtom,
} from '@/atoms/doc-meta';
import {
  addRpcDeliveredTurn,
  getRpcDeliveredTurnKey,
  rpcDeliveredTurnsAtom,
} from '@/atoms/session-dispatch-delivery';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { sendIpc } from '@/lib/electron-ipc-client';
import { useAuthenticatedConvex } from './use-authenticated-convex';
import { roostHistoryFeatureEnabledAtom } from '@/atoms/settings';
import { statusViewPatchToMeta, statusViewSessionsFromMetas } from '@/lib/status-view-state';
import { deleteWorkspacePinSection, writeWorkspacePinSection } from '@/lib/workspace-catalog-write';
import {
  createSessionSubmission,
  type CreateSessionResult,
  type StartSessionResult,
} from '@/lib/session-submission';

const log = debug('lody:session-actions');

type RepoDocMetaPatch = Parameters<WorkspaceRuntime['repo']['upsertDocMeta']>[1];

export type SessionChatType = 'regular' | 'side_chat';

export function resolveSessionChatType(
  session: Pick<SessionMeta, 'childSessionPlacement'> | null | undefined
): SessionChatType {
  return session?.childSessionPlacement === 'side-panel' ? 'side_chat' : 'regular';
}

const TRACKED_MENTION_KINDS = [
  'file',
  'dir',
  'issue',
  'pr',
  'skill',
  'session',
  'command',
  'agent_role',
] as const;

export type SessionMentionCounts = {
  mention_count: number;
  mention_types: (typeof TRACKED_MENTION_KINDS)[number][];
  mention_file_count: number;
  mention_dir_count: number;
  mention_issue_count: number;
  mention_pr_count: number;
  mention_skill_count: number;
  mention_session_count: number;
  mention_command_count: number;
  mention_agent_role_count: number;
};

export function countSessionMentions(items: SessionHistoryInput['items']): SessionMentionCounts {
  const counts = Object.fromEntries(TRACKED_MENTION_KINDS.map((kind) => [kind, 0])) as Record<
    (typeof TRACKED_MENTION_KINDS)[number],
    number
  >;

  for (const item of items ?? []) {
    if (item.type !== 'text' || typeof item.text !== 'string') continue;
    for (const span of sanitizeMessageTextSpans(item.text, item.spans) ?? []) {
      if (span.kind === 'pasted_text' || span.kind === 'message_quote') continue;
      counts[span.kind] += 1;
    }
  }

  const mentionTypes = TRACKED_MENTION_KINDS.filter((kind) => counts[kind] > 0);
  return {
    mention_count: mentionTypes.reduce((total, kind) => total + counts[kind], 0),
    mention_types: mentionTypes,
    mention_file_count: counts.file,
    mention_dir_count: counts.dir,
    mention_issue_count: counts.issue,
    mention_pr_count: counts.pr,
    mention_skill_count: counts.skill,
    mention_session_count: counts.session,
    mention_command_count: counts.command,
    mention_agent_role_count: counts.agent_role,
  };
}

/**
 * Local workspace state rejected creating this session for billing reasons
 * (free session limit, or the workspace is waiting on checkout). Callers surface
 * an upgrade/checkout prompt instead of a generic failure toast.
 */
export class SessionCreateBillingError extends Error {
  constructor(
    readonly code: 'free_session_limit_reached' | 'workspace_payment_required',
    readonly limit: number,
    readonly current: number,
    message: string
  ) {
    super(message);
    this.name = 'SessionCreateBillingError';
  }
}

/**
 * Restoring an archived local-project Session would make it active without a
 * valid execution target. Keep this error public so every restore surface can
 * explain the same recoverable action: add the project back first.
 */
export class ArchivedLocalProjectRestoreUnavailableError extends Error {
  constructor() {
    super('Re-add this local project to restore its conversations.');
    this.name = 'ArchivedLocalProjectRestoreUnavailableError';
  }
}

export function isArchivedLocalProjectRestoreUnavailableError(
  error: unknown
): error is ArchivedLocalProjectRestoreUnavailableError {
  return error instanceof ArchivedLocalProjectRestoreUnavailableError;
}

async function assertArchivedLocalProjectCanRestore(
  runtime: WorkspaceRuntime,
  sessionMeta: SessionMeta
): Promise<void> {
  const project = sessionMeta.project;
  if (project?.kind !== 'local') return;

  const machineMeta = (await runtime.repo.getDocMeta(getMachineRoomId(sessionMeta.machineId)))
    ?.meta as MachineLegacyMetaFields | undefined;
  const machineFlockHandle = await runtime.repo.openFlockDoc(
    getMachineFlockDocId(runtime.workspaceId, sessionMeta.machineId)
  );
  const rows = readMachineFlockRowsFromFlock(machineFlockHandle.flock, {
    families: ['localProject', 'deleteLocalProjectCommand'],
  });
  const pendingRemovalIds = getMachineFlockDeleteLocalProjectIds(rows);
  const availableProjects = {
    ...(machineMeta?.localProjects ?? {}),
    ...getMachineFlockLocalProjects(rows),
  };

  if (
    pendingRemovalIds.has(project.localProjectId) ||
    availableProjects[project.localProjectId] === undefined
  ) {
    throw new ArchivedLocalProjectRestoreUnavailableError();
  }
}

async function deleteMachineFlockRowsBestEffort(
  runtime: WorkspaceRuntime,
  machineId: string,
  keys: MachineFlockKey[],
  reason: string
): Promise<void> {
  try {
    const flockDocId = getMachineFlockDocId(runtime.workspaceId, machineId as MachineId);
    for (const key of keys) {
      await runtime.writer.flockRowDelete(flockDocId, key);
    }
  } catch (error) {
    log('[machine-flock] failed to delete command row', { machineId, reason, error });
  }
}

export type SessionActions = {
  createSession: (payload: SessionToCreate) => Promise<CreateSessionResult>;
  startSession: (
    payload: SessionToCreate,
    history: Omit<SessionHistoryInput, 'id'>,
    attachments?: SessionAttachmentDraft[]
  ) => Promise<StartSessionResult>;
  addSessionHistory: (
    sessionId: SessionId,
    history: Omit<SessionHistoryInput, 'id'>,
    options?: {
      dispatch?: boolean;
      guideExpectedTurnId?: string;
      attachments?: SessionAttachmentDraft[];
      onAccepted?: () => void;
    }
  ) => Promise<SessionHistory>;
  requestSessionDispatch: (
    sessionId: SessionId,
    userTurnId: string,
    options?: { inputConfig?: SessionTurnInputConfig; machineId?: MachineId | null }
  ) => Promise<void>;
  /**
   * Stop by default. `interrupt` only ends the turn so queued input runs next
   * (interrupt-and-send): it carries no Stop identity, so no daemon pauses the
   * Inbox or cancels the queued input's eligibility.
   */
  requestSessionCancel: (
    sessionId: SessionId,
    turnId: string,
    options?: { interrupt?: boolean }
  ) => Promise<void>;
  requestSessionSteer: (
    sessionId: SessionId,
    expectedTurnId: string,
    userTurnId: string,
    options?: { machineId?: MachineId | null }
  ) => Promise<boolean>;
  /**
   * Run a goal action through the agent's control extension.
   *
   * Status-only actions reach a goal whose prompt is still open, which the chat
   * path cannot do: that prompt is the session's only turn slot.
   */
  requestSessionGoal: (
    sessionId: SessionId,
    action: SessionGoalAction,
    options?: { objective?: string; userId?: string; machineId?: MachineId | null }
  ) => Promise<SessionGoalResponse | null>;
  touchSessionActivity: (sessionId: SessionId) => Promise<void>;
  updateSessionStatus: (sessionId: SessionId, status: SessionStatus) => Promise<void>;
  updateSessionTitle: (sessionId: SessionId, title: string) => Promise<void>;
  updateSessionMetadata: (sessionId: SessionId, patch: Record<string, unknown>) => Promise<void>;
  /** Reassign `SessionMeta.userId` to another workspace member. */
  transferSessionOwner: (sessionId: SessionId, nextUserId: string) => Promise<void>;
  markSessionRead: (sessionId: SessionId, lastMessageAt?: number | null) => Promise<void>;
  markSessionUnread: (sessionId: SessionId) => Promise<void>;
  /** Delete exactly the supplied Sessions without discovering related Sessions. */
  deleteSessions: (sessionIds: SessionId[]) => Promise<void>;
  /** Archives contained Tabs; opened Sessions only with `includeOpenedSessions`. */
  archiveSession: (
    sessionId: SessionId,
    options?: { includeOpenedSessions?: boolean }
  ) => Promise<void>;
  setTreeCollaborationStopped: (sessionId: SessionId, stopped: boolean) => Promise<void>;
  setSessionTabClosed: (sessionId: SessionId, closed: boolean) => Promise<void>;
  restoreSession: (sessionId: SessionId) => Promise<void>;
  deleteArchivedSession: (sessionId: SessionId) => Promise<void>;
  setSessionPinned: (sessionId: SessionId, isPinned: boolean) => Promise<void>;
  /**
   * Plan a Status view or pin-section command with the shared planner and
   * write the result. `state` is what the caller's list shows (order, presence,
   * permissions); opened sub-conversations and the target's own metadata are
   * read from the Repo. Every affected Session passes the guard before any write.
   */
  runStatusViewCommand: (
    command: StatusViewCommand,
    state?: StatusViewState
  ) => Promise<StatusViewWrite[]>;
  /** Snooze a session until `snoozedUntil` (epoch ms) in the Status view's Later section. */
  snoozeSession: (
    sessionId: SessionId,
    snoozedUntil: number,
    options?: { includeOpenedSessions?: boolean }
  ) => Promise<void>;
  /** Mark a session as settled in the Status view's Settled section. */
  settleSession: (
    sessionId: SessionId,
    options?: { includeOpenedSessions?: boolean }
  ) => Promise<void>;
  /** Restore a snoozed or settled session back to Focus. */
  moveSessionToFocus: (
    sessionId: SessionId,
    options?: { includeOpenedSessions?: boolean }
  ) => Promise<void>;
};

const randomByte = () => Math.floor(Math.random() * 256);

const emptyStatusViewState = (): StatusViewState => ({
  sessions: [],
  sections: [],
  sectionsLoaded: false,
  canManageSections: true,
  nowMs: getServerNow(),
});

const extractSessionStatus = (value: unknown): Session['status'] | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const maybeMeta = 'meta' in value ? (value as { meta?: unknown }).meta : value;

  if (!maybeMeta || typeof maybeMeta !== 'object' || !('status' in maybeMeta)) {
    return undefined;
  }

  const status = (maybeMeta as { status?: unknown }).status;
  if (!status || typeof status !== 'object') {
    return undefined;
  }

  const type = (status as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return undefined;
  }

  return status as Session['status'];
};

type SessionActivityProposal = {
  lastMessageAt?: number;
  lastReadAt?: number;
};

function getFiniteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildSessionActivityPatch(
  meta: SessionMeta | undefined,
  proposal: SessionActivityProposal
): Partial<SessionMeta> {
  const patch: Partial<SessionMeta> = {};
  if (proposal.lastMessageAt !== undefined) {
    const current = getFiniteTimestamp(meta?.lastMessageAt);
    if (current === null || proposal.lastMessageAt > current) {
      patch.lastMessageAt = proposal.lastMessageAt;
    }
  }
  if (proposal.lastReadAt !== undefined) {
    const current = getFiniteTimestamp(meta?.lastReadAt);
    if (current === null || proposal.lastReadAt > current) {
      patch.lastReadAt = proposal.lastReadAt;
    }
  }
  return patch;
}

async function upsertSessionActivityPatch(
  runtime: WorkspaceRuntime,
  sessionId: SessionId,
  proposal: SessionActivityProposal,
  assertCanManage?: (ids: readonly SessionId[]) => Promise<void>
): Promise<SessionMeta | undefined> {
  const roomId = getSessionRoomId(sessionId);
  const existing = await runtime.repo.getDocMeta(roomId);
  if (isLoroRepoDocDeleted(existing)) return undefined;
  const meta = existing?.meta as SessionMeta | undefined;
  // A held creation is written with its first message. Activity must not
  // publish a partial session that hides its local placeholder meanwhile.
  if (!meta?.id && runtime.pendingSends?.hasPendingCreation(sessionId)) return undefined;
  const patch = buildSessionActivityPatch(meta, proposal);
  if (Object.keys(patch).length > 0) {
    await assertCanManage?.([sessionId]);
    await runtime.writer.upsertDocMeta(roomId, patch as RepoDocMetaPatch);
  }
  return meta;
}

export async function touchSessionActivityMeta(
  runtime: WorkspaceRuntime,
  sessionId: SessionId,
  proposal: SessionActivityProposal,
  assertCanManage?: (ids: readonly SessionId[]) => Promise<void>
): Promise<void> {
  if (assertCanManage) {
    const target = (await runtime.repo.getDocMeta(getSessionRoomId(sessionId)))?.meta as
      | SessionMeta
      | undefined;
    await assertCanManage(
      target?.parentSessionId ? [sessionId, target.parentSessionId] : [sessionId]
    );
  }
  const meta = await upsertSessionActivityPatch(runtime, sessionId, proposal, assertCanManage);
  const parentSessionId = meta?.parentSessionId;
  if (parentSessionId && parentSessionId !== sessionId) {
    await upsertSessionActivityPatch(runtime, parentSessionId, proposal, assertCanManage);
  }
}

export function useSessionActions(): SessionActions {
  const getOwnerAccessReason = useSessionOwnerAccess();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const assertCanManageSessions = useSessionManagementGuard(runtime);
  const roostHistoryEnabled = useAtomValue(roostHistoryFeatureEnabledAtom);
  const setDocMetaByRoomId = useSetAtom(setDocMetaByRoomIdAtom);
  const store = useStore();
  // Convex dedupes identical subscriptions client-side, so this shares the
  // entitlement subscription already held by the chat surfaces.
  const billingEntitlement = useCloudQuery(
    cloudOperations.billing.getWorkspaceBillingEntitlement,
    runtime?.workspaceId ? { workspaceId: runtime.workspaceId } : 'skip'
  );
  const postHog = usePostHog();
  const { isAuthenticated: isConvexAuthenticated, requestAuthRecovery } = useAuthenticatedConvex();
  const recordMyWorkspaceDailyActiveUser = useLegacyWorkspaceMutation(
    cloudOperations.activity.recordMyWorkspaceDailyActiveUser
  );

  const recordWorkspaceActivity = useCallback(
    (workspaceId: string | undefined) => {
      if (!workspaceId || !isConvexAuthenticated) return;
      // Best-effort DAU recording: never block the chat/session flow.
      void recordMyWorkspaceDailyActiveUser({ workspaceId }).catch((error: unknown) => {
        if (isConvexUnauthenticatedError(error)) {
          requestAuthRecovery();
          return;
        }
        console.warn('[session-actions] Failed to record daily active user:', error);
      });
    },
    [isConvexAuthenticated, recordMyWorkspaceDailyActiveUser, requestAuthRecovery]
  );

  const assertSessionCreateAllowed = useCallback(
    (sessionId: SessionId) => {
      if (!runtime?.workspaceId) return;
      if (store.get(sessionMetaCacheAtom)[getSessionRoomId(sessionId)] !== undefined) return;

      const admission = evaluateSessionCreateQuota({
        effectivePlanTier: billingEntitlement?.effectivePlanTier,
        checkoutPending: billingEntitlement?.checkoutPending,
        sessionCount: store.get(sessionMetaCountAtom),
      });
      if (admission.allowed) return;

      throw new SessionCreateBillingError(
        admission.reason === 'checkout_pending'
          ? 'workspace_payment_required'
          : 'free_session_limit_reached',
        admission.limit,
        admission.current,
        formatSessionQuotaRejection('session_create', admission)
      );
    },
    [billingEntitlement, runtime, store]
  );

  const {
    createSession,
    startSession,
    addSessionHistory,
    requestSessionDispatch,
    requestSessionSteer,
  } = useMemo(
    () =>
      createSessionSubmission({
        runtime,
        defaultHistoryBackend: roostHistoryEnabled
          ? ROOST_SESSION_HISTORY_BACKEND
          : LEGACY_SESSION_HISTORY_BACKEND,
        assertSessionCreateAllowed,
        assertSessionEditable: (sessionId) => assertCanManageSessions([sessionId]),
        recordWorkspaceActivity,
        publishSessionMeta: setDocMetaByRoomId,
        readSessionMeta: (sessionId) =>
          store.get(sessionMetaCacheAtom)[getSessionRoomId(sessionId)],
        // Key below every existing orderKey so a new top-level conversation
        // lands at the top of Status Focus; child Sessions get none (they
        // render nested under their opener row).
        planNewSessionOrderKey: () => {
          const write = planStatusViewCommand(
            {
              ...emptyStatusViewState(),
              related: statusViewSessionsFromMetas(Object.values(store.get(sessionMetaCacheAtom))),
            },
            { type: 'newSessionOrder', sessionId: '' },
            { nowMs: getServerNow(), randomByte }
          )[0];
          return write?.type === 'session' ? write.patch.orderKey : undefined;
        },
        onRpcDelivered: (sessionId, turnId) =>
          store.set(rpcDeliveredTurnsAtom, (previous) =>
            addRpcDeliveredTurn(previous, getRpcDeliveredTurnKey(sessionId, turnId))
          ),
        recordChat: (meta, sessionId, first, items) =>
          capturePostHogEvent(postHog, 'session/chat', {
            user_id: meta?.userId,
            workspace_id: runtime?.workspaceId,
            session_id: sessionId,
            machine_id: meta?.machineId,
            agent_config_id: meta?.agentConfigId,
            cli_type: meta?.cliType,
            agent_type: meta?.agentType,
            project_kind: meta?.project?.kind ?? null,
            is_first_message: first,
            session_type: resolveSessionChatType(meta),
            ...countSessionMentions(items),
          }),
      }),
    [
      runtime,
      roostHistoryEnabled,
      assertSessionCreateAllowed,
      assertCanManageSessions,
      recordWorkspaceActivity,
      setDocMetaByRoomId,
      store,
      postHog,
    ]
  );

  const updateSessionMetadata = useCallback(
    async (sessionId: SessionId, patch: Record<string, unknown>) => {
      if (!runtime) throw new Error('Runtime not ready');
      await assertCanManageSessions([sessionId]);
      await runtime.writer.upsertDocMeta(getSessionRoomId(sessionId), patch);
    },
    [runtime, assertCanManageSessions]
  );

  const assertReadablePreferences = useCallback(
    (ids: readonly SessionId[]) => assertCanManageSessions(ids, true),
    [assertCanManageSessions]
  );
  const updateSessionPreference = useCallback(
    async (
      sessionId: SessionId,
      patch: {
        isPinned?: boolean;
        pinSectionId?: string | undefined;
        orderKey?: string | undefined;
        lastReadAt?: number;
      }
    ) => {
      if (!runtime) throw new Error('Runtime not ready');
      await assertReadablePreferences([sessionId]);
      await runtime.writer.upsertDocMeta(getSessionRoomId(sessionId), patch);
    },
    [runtime, assertReadablePreferences]
  );

  const updateSessionStatus = useCallback(
    async (sessionId: SessionId, status: SessionStatus) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(existing)) return;
      const prevStatus = extractSessionStatus(existing);
      if (prevStatus?.type === 'running' && status.type === 'idle') {
        // Web should not drive running -> idle; only CLI owns that transition.
        log('[session-status] ignore running -> idle transition from web', {
          sessionId,
          prevStatus,
          nextStatus: status,
        });
        return;
      }
      // Keep web writes aligned with the shared state machine to avoid regressions.
      const nextStatus = status;
      if (prevStatus && nextStatus === prevStatus) {
        return;
      }
      await updateSessionMetadata(sessionId, { status: nextStatus } as Partial<SessionMeta>);
    },
    [runtime, updateSessionMetadata]
  );

  const requestSessionCancel = useCallback(
    async (sessionId: SessionId, turnId: string, options?: { interrupt?: boolean }) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      await assertCanManageSessions([sessionId]);
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(existing)) return;
      const interrupt = options?.interrupt === true;
      const meta = existing?.meta as SessionMeta | undefined;
      const machineId = meta?.machineId;
      const machine = machineId
        ? await runtime.repo.getDocMeta(getMachineRoomId(machineId))
        : undefined;
      const supportsInbox = machineSupportsProtocolCapability(
        machine?.meta,
        MACHINE_PROTOCOL_CAPABILITIES.operationInbox,
        OPERATION_INBOX_PROTOCOL_VERSION
      );
      const cancelId = supportsInbox && !interrupt ? crypto.randomUUID() : undefined;
      if (machineId) {
        // RPC and the durable control request share an identity, even if either arrives late.
        void runtime
          .requestSessionCancel(machineId, sessionId, turnId, {
            timeoutMs: 2_000,
            ...(cancelId ? { cancelId } : {}),
            ...(interrupt && supportsInbox ? { pauseInbox: false } : {}),
          })
          .then((response) => {
            if (response && !response.success) {
              log('session cancel rpc failed for %s/%s: %s', sessionId, turnId, response.error);
            }
          })
          .catch((error) => {
            log('session cancel rpc threw for %s/%s: %o', sessionId, turnId, error);
          });
      }
      if (!interrupt) {
        // Keep the observed drafts paused before publishing the durable Stop
        // marker. The immediate RPC above must not wait for a store read.
        await runtime.sendResources.withSessionStore(sessionId, (sessionStore) => {
          sessionStore.setState((draft: SessionDocDraft) => {
            for (const item of draft.mq ?? []) item.paused = true;
            if (cancelId) draft.cancelRequest = { id: cancelId, turnId };
          });
        });
      }
      if (cancelId) {
        await runtime.repo.flush();
      }
      await updateSessionMetadata(sessionId, {
        lastCanceledTurn: cancelId ? getSessionCancelRequestMarker(cancelId) : turnId,
      } as Partial<SessionMeta>);
    },
    [runtime, updateSessionMetadata, assertCanManageSessions]
  );

  const requestSessionGoal = useCallback(
    async (
      sessionId: SessionId,
      action: SessionGoalAction,
      options?: { objective?: string; userId?: string; machineId?: MachineId | null }
    ): Promise<SessionGoalResponse | null> => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      await assertCanManageSessions([sessionId]);
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      const meta = isLoroRepoDocDeleted(existing)
        ? undefined
        : (existing?.meta as SessionMeta | undefined);
      const machineId = options?.machineId ?? meta?.machineId ?? null;
      const userId = options?.userId?.trim() || meta?.userId;
      if (!machineId || !userId) {
        return null;
      }
      return await runtime.requestSessionGoal(machineId, {
        sessionId,
        action,
        ...(options?.objective ? { objective: options.objective } : {}),
        userId,
      });
    },
    [runtime, assertCanManageSessions]
  );

  const touchSessionActivity = useCallback(
    async (sessionId: SessionId) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const now = getServerNow();
      await assertCanManageSessions([sessionId]);
      await touchSessionActivityMeta(
        runtime,
        sessionId,
        { lastMessageAt: now, lastReadAt: now },
        assertCanManageSessions
      );
      await runStatusViewCommandRef.current({ type: 'touchOnSend', sessionId });
    },
    [runtime, assertCanManageSessions]
  );

  const updateSessionTitle = useCallback(
    async (sessionId: SessionId, title: string) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const nextTitle = title.trim();
      if (!nextTitle) {
        return;
      }
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(existing)) return;
      await updateSessionMetadata(sessionId, {
        title: nextTitle,
        titleSource: 'user',
      } as Partial<SessionMeta>);
    },
    [runtime, updateSessionMetadata]
  );

  /**
   * Hand a session to another workspace member. `SessionMeta.userId` is the
   * owner: it drives the My/Team scope split, the sidebar author avatar, and
   * CLI-side owner checks (Code Collab writes, usage attribution). Assignment never changes machine/project sharing.
   */
  const transferSessionOwner = useCallback(
    async (sessionId: SessionId, nextUserId: string) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const userId = nextUserId.trim();
      if (!userId) {
        return;
      }
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(existing)) return;
      if (!existing) throw new Error('Session not found');
      await assertCanManageSessions([sessionId]);
      const reason = getOwnerAccessReason(existing?.meta as SessionMeta, userId);
      if (reason) throw new Error(reason);
      await updateSessionMetadata(sessionId, {
        userId,
      } as Partial<SessionMeta>);
    },
    [runtime, updateSessionMetadata, assertCanManageSessions, getOwnerAccessReason]
  );

  const markSessionRead = useCallback(
    async (sessionId: SessionId, lastMessageAt?: number | null) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const now = getServerNow();
      const baseReadAt = getFiniteTimestamp(lastMessageAt) ?? now;
      const roomId = getSessionRoomId(sessionId);
      const cachedMeta = store.get(sessionMetaCacheAtom)[roomId] as SessionMeta | undefined;
      const snoozedUntil = getFiniteTimestamp(cachedMeta?.snoozedUntil);
      const expiredSnoozeAt = snoozedUntil !== null && snoozedUntil <= now ? snoozedUntil : 0;
      const readAt = Math.max(baseReadAt, expiredSnoozeAt);
      await assertReadablePreferences([sessionId]);
      await touchSessionActivityMeta(
        runtime,
        sessionId,
        { lastReadAt: readAt },
        assertReadablePreferences
      );
      const rootId = cachedMeta?.parentSessionId;
      const rootMeta = rootId
        ? (store.get(sessionMetaCacheAtom)[getSessionRoomId(rootId)] as SessionMeta | undefined)
        : undefined;
      const rootSnoozedUntil = getFiniteTimestamp(rootMeta?.snoozedUntil);
      if (
        rootId &&
        rootSnoozedUntil !== null &&
        rootSnoozedUntil <= now &&
        rootSnoozedUntil > readAt
      ) {
        await touchSessionActivityMeta(
          runtime,
          rootId,
          { lastReadAt: rootSnoozedUntil },
          assertReadablePreferences
        );
      }
    },
    [runtime, store, assertReadablePreferences]
  );

  const markSessionUnread = useCallback(
    async (sessionId: SessionId) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(existing)) return;
      // Prefer the repo read, but fall back to the same rendered metadata cache
      // as Archive. A sidebar row can arrive before the repo read hydrates; an
      // action offered on that visible row must not become a silent no-op.
      const repoMeta = existing?.meta as SessionMeta | undefined;
      const cachedMeta = store.get(sessionMetaCacheAtom)[roomId] as SessionMeta | undefined;
      const lastMessageAt =
        getFiniteTimestamp(repoMeta?.lastMessageAt) ??
        getFiniteTimestamp(cachedMeta?.lastMessageAt);
      const now = getServerNow();
      const snoozedUntil =
        getFiniteTimestamp(repoMeta?.snoozedUntil) ?? getFiniteTimestamp(cachedMeta?.snoozedUntil);
      const expiredSnoozeAt = snoozedUntil !== null && snoozedUntil <= now ? snoozedUntil : null;
      const effectiveLastMessageAt =
        lastMessageAt !== null && expiredSnoozeAt !== null
          ? Math.max(lastMessageAt, expiredSnoozeAt)
          : (lastMessageAt ?? expiredSnoozeAt);
      if (effectiveLastMessageAt === null) return;

      // Unread is the durable comparison `effectiveLastMessageAt > lastReadAt`. Move
      // only this receipt behind the latest known activity; do not touch the
      // activity timestamp, which would reorder the sidebar.
      await updateSessionPreference(sessionId, {
        lastReadAt: effectiveLastMessageAt - 1,
      } as Partial<SessionMeta>);
    },
    [runtime, store, updateSessionPreference]
  );

  const invalidateExternalHistoryCatalog = useCallback(
    async (sessionMeta: SessionMeta | undefined) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const externalHistory = sessionMeta?.externalHistory;
      if (!sessionMeta || !externalHistory || sessionMeta.project?.kind !== 'local') {
        return;
      }

      const machineRoomId = getMachineRoomId(sessionMeta.machineId);
      const machineMeta = (await runtime.repo.getDocMeta(machineRoomId))?.meta as
        | MachineLegacyMetaFields
        | undefined;
      const flockDocId = getMachineFlockDocId(runtime.workspaceId, sessionMeta.machineId);
      const handle = await runtime.repo.openFlockDoc(flockDocId);
      const localProjects = {
        ...(machineMeta?.localProjects ?? {}),
        ...getMachineFlockLocalProjects(
          readMachineFlockRowsFromFlock(handle.flock, { families: ['localProject'] })
        ),
      };
      const project = localProjects?.[sessionMeta.project.localProjectId];
      const providerKey = getLocalProjectHistoryProviderKey(externalHistory.provider);
      const catalog = project?.history?.[providerKey];
      const item = catalog?.sessions[externalHistory.sourceAcpSessionId];
      if (!project || !catalog || !item) {
        return;
      }
      if (item.importedSessionId && item.importedSessionId !== sessionMeta.id) {
        return;
      }

      const nextItem = {
        acpSessionId: item.acpSessionId,
        title: item.title,
        ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
        status: 'available' as const,
      };

      const key = machineFlockKeys.localProject(sessionMeta.project.localProjectId);
      await runtime.writer.flockRowPut(flockDocId, key, {
        ...project,
        history: {
          ...(project.history ?? {}),
          [providerKey]: {
            ...catalog,
            sessions: {
              ...catalog.sessions,
              [externalHistory.sourceAcpSessionId]: nextItem,
            },
          },
        },
      });
    },
    [runtime]
  );

  const deleteSessionDocuments = useCallback(
    async (sessionId: SessionId, options?: { cleanupLaunchConfig?: boolean }) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }

      await assertCanManageSessions([sessionId]);
      const draftOwner = store.get(sessionRunConfigDraftAccountAtom);
      const sessionRoomId = getSessionRoomId(sessionId);
      const sessionMeta = (await runtime.repo.getDocMeta(sessionRoomId))?.meta as
        | SessionMeta
        | undefined;
      await invalidateExternalHistoryCatalog(sessionMeta);
      if (options?.cleanupLaunchConfig !== false && sessionMeta?.machineId) {
        await deleteMachineFlockRowsBestEffort(
          runtime,
          sessionMeta.machineId,
          [machineFlockKeys.sessionLaunchConfig(sessionId)],
          'deleteSessionDocuments'
        );
      }

      // Held sends never write after this: cancellation joins any in-flight write.
      await runtime.pendingSends?.cancelSessions([sessionId]);
      await assertCanManageSessions([sessionId]);
      await runtime.writer.deleteDoc(sessionRoomId);
      if (runtime.accountId) {
        store.set(clearSessionRunConfigDraftsAtom, {
          accountId: runtime.accountId,
          lifetime: draftOwner.lifetime,
          workspaceId: runtime.workspaceId,
          sessionIds: [sessionId],
        });
      }
      await runtime.repo.flush();
      await runtime.releaseSessionStore(sessionId);
    },
    [invalidateExternalHistoryCatalog, runtime, store, assertCanManageSessions]
  );

  const deleteSessions = useCallback(
    async (sessionIds: SessionId[]) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      await assertCanManageSessions(sessionIds);
      await Promise.all(sessionIds.map((id) => deleteSessionDocuments(id)));
    },
    [runtime, deleteSessionDocuments, assertCanManageSessions]
  );

  const setTreeCollaborationStopped = useCallback(
    async (sessionId: SessionId, stopped: boolean) => {
      if (!runtime) throw new Error('Runtime not ready');
      const targets = await runtime.readSessionOperationTargets(sessionId, 'collaboration');
      await assertCanManageSessions(targets.map((target) => target.id));
      for (const machineId of new Set(targets.map((target) => target.machineId))) {
        const machine = await runtime.repo.getDocMeta(getMachineRoomId(machineId));
        if (
          !machineSupportsProtocolCapability(
            machine?.meta,
            MACHINE_PROTOCOL_CAPABILITIES.sessionCollaborationControl
          )
        )
          throw new Error(
            'Update every machine in this conversation tree before controlling collaboration'
          );
      }
      if (store.get(activeWorkspaceRuntimeAtom) !== runtime) {
        throw new Error('Workspace changed before controlling collaboration');
      }
      // Stop the root first, so late descendants inherit its barrier. Restore it last.
      for (const target of stopped ? targets : [...targets].reverse()) {
        await updateSessionMetadata(target.id, {
          collaborationStopped: stopped,
        } as Partial<SessionMeta>);
      }
      if (stopped) await runtime.pendingSends?.cancelSessions(targets.map((target) => target.id));
    },
    [runtime, store, assertCanManageSessions, updateSessionMetadata]
  );

  const archiveSession = useCallback(
    async (sessionId: SessionId, options?: { includeOpenedSessions?: boolean }) => {
      const includeOpenedSessions = options?.includeOpenedSessions === true;
      log('[session-archive] start', { sessionId, includeOpenedSessions });
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const unwritten = runtime.pendingSends?.hasPendingCreation(sessionId) ?? false;
      if (unwritten && !(await runtime.repo.getDocMeta(getSessionRoomId(sessionId)))?.meta?.id) {
        // Only a runtime-owned, uncommitted creation is cancelled here; no Repo mutation.
        if (store.get(activeWorkspaceRuntimeAtom) !== runtime)
          throw new Error('Workspace changed before archiving');
        await runtime.pendingSends?.cancelSessions([sessionId]);
        log('[session-archive] canceled unwritten conversation', { sessionId });
        return;
      }
      const archiveTargets = await runtime.readSessionOperationTargets(
        sessionId,
        includeOpenedSessions ? 'archive-tree' : 'archive'
      );
      await assertCanManageSessions(archiveTargets.map((target) => target.id));
      if (store.get(activeWorkspaceRuntimeAtom) !== runtime) {
        throw new Error('Workspace changed before archiving');
      }
      // Held follow-ups would otherwise be written into archived conversations.
      await runtime.pendingSends?.cancelSessions(archiveTargets.map((session) => session.id));
      for (const session of archiveTargets) {
        // The archived state is the whole request: the owning machine observes
        // it, releases the runtime, and reconciles the worktree directory.
        await updateSessionMetadata(session.id, {
          isArchived: true,
          status: SessionStatusFactory.idle(),
        } as Partial<SessionMeta>);
        if (typeof window !== 'undefined') {
          // Cleanup failure cannot undo the accepted archive state.
          try {
            sendIpc('terminal.closeSession', { sessionId: session.id });
          } catch (error) {
            log('[session-archive] terminal cleanup failed', { sessionId: session.id, error });
          }
        }
      }
      await runtime.repo.flush();
      log('[session-archive] archived', {
        sessionId,
        targetSessionIds: archiveTargets.map((session) => session.id),
      });
    },
    [runtime, store, assertCanManageSessions, updateSessionMetadata]
  );

  const restoreSession = useCallback(
    async (sessionId: SessionId) => {
      log('[session-restore] start', { sessionId });
      if (!runtime) {
        throw new Error('Runtime not ready');
      }

      const restoreTargets = await runtime.readSessionOperationTargets(sessionId, 'restore');
      await assertCanManageSessions(restoreTargets.map((target) => target.id));
      const [sessionMeta] = restoreTargets;
      await assertArchivedLocalProjectCanRestore(runtime, sessionMeta);
      if (store.get(activeWorkspaceRuntimeAtom) !== runtime) {
        throw new Error('Workspace changed before restoring');
      }
      // Restore is a lifecycle change only; every tab keeps its close flag.
      for (const session of restoreTargets) {
        await updateSessionMetadata(session.id, {
          isArchived: false,
        } as Partial<SessionMeta>);
      }
      log('[session-restore] restored', {
        sessionId,
        targetSessionIds: restoreTargets.map((session) => session.id),
      });
    },
    [runtime, store, assertCanManageSessions, updateSessionMetadata]
  );

  const setSessionTabClosed = useCallback(
    async (sessionId: SessionId, closed: boolean) => {
      if (!runtime) throw new Error('Runtime not ready');
      const roomId = getSessionRoomId(sessionId);
      const entry = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(entry)) throw new Error('Session was deleted');
      const meta = entry?.meta ?? store.get(sessionMetaCacheAtom)[roomId];
      if (!meta) throw new Error('Session metadata is still loading');
      await updateSessionMetadata(sessionId, { isTabClosed: closed });
    },
    [runtime, store, updateSessionMetadata]
  );

  const deleteArchivedSessionMeta = useCallback(
    async (sessionMeta: SessionMeta) => {
      if (!runtime) throw new Error('Runtime not ready');
      // Deleting the doc leaves a deletion marker the owning machine reconciles
      // its worktree directory against; no machine command is needed.
      await deleteSessionDocuments(sessionMeta.id);
    },
    [runtime, deleteSessionDocuments]
  );

  const deleteArchivedSession = useCallback(
    async (sessionId: SessionId) => {
      log('[session-delete] start', { sessionId });
      if (!runtime) throw new Error('Runtime not ready');
      const deleteTargets = await runtime.readSessionOperationTargets(sessionId, 'delete');
      await assertCanManageSessions(deleteTargets.map((target) => target.id));
      if (store.get(activeWorkspaceRuntimeAtom) !== runtime) {
        throw new Error('Workspace changed before deleting');
      }

      for (const session of [...deleteTargets].reverse()) {
        await deleteArchivedSessionMeta(session);
      }
      log('[session-delete] deleted', {
        sessionId,
        targetSessionIds: deleteTargets.map((session) => session.id),
      });
    },
    [runtime, store, deleteArchivedSessionMeta, assertCanManageSessions]
  );

  const readSessionMetas = useCallback(
    async (sessionId: SessionId, includeOpened: boolean): Promise<SessionMeta[]> => {
      if (!runtime) throw new Error('Runtime not ready');
      if (includeOpened) {
        const tree = await runtime.readSessionOperationTargets(sessionId, 'archive-tree');
        if (store.get(activeWorkspaceRuntimeAtom) !== runtime) {
          throw new Error('Workspace changed during session operation');
        }
        return tree;
      }
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(existing)) return [];
      const meta =
        (existing?.meta as SessionMeta | undefined) ??
        (store.get(sessionMetaCacheAtom)[roomId] as SessionMeta | undefined);
      return meta ? [{ ...meta, id: sessionId }] : [];
    },
    [runtime, store]
  );

  /** Every affected Session passes its guard before the first write. */
  const applyStatusViewWrites = useCallback(
    async (writes: readonly StatusViewWrite[]) => {
      if (!runtime) throw new Error('Runtime not ready');
      const managed: SessionId[] = [];
      const preferred: SessionId[] = [];
      for (const write of writes) {
        if (write.type !== 'session') continue;
        (write.access === 'manage' ? managed : preferred).push(write.sessionId as SessionId);
      }
      if (managed.length > 0) await assertCanManageSessions(managed);
      if (preferred.length > 0) await assertReadablePreferences(preferred);
      for (const write of writes) {
        if (write.type === 'session') {
          await runtime.writer.upsertDocMeta(
            getSessionRoomId(write.sessionId as SessionId),
            statusViewPatchToMeta(write.patch) as RepoDocMetaPatch
          );
        } else if (write.type === 'putSection') {
          await writeWorkspacePinSection(runtime, write.section);
        } else {
          await deleteWorkspacePinSection(runtime, write.sectionId);
        }
      }
    },
    [runtime, assertCanManageSessions, assertReadablePreferences]
  );

  const runStatusViewCommand = useCallback(
    async (requested: StatusViewCommand, state?: StatusViewState) => {
      if (!runtime) throw new Error('Runtime not ready');
      let command = requested;
      const base = state ?? emptyStatusViewState();
      const listed = new Set(base.sessions.map((session) => session.id));
      let reached: SessionMeta[] = [];
      switch (command.type) {
        case 'snooze':
        case 'settle':
        case 'moveToFocus':
          reached = await readSessionMetas(command.sessionId as SessionId, command.includeOpened);
          break;
        case 'move':
          // A row dropped into Focus brings its opened sub-conversations along.
          reached = await readSessionMetas(
            command.sessionId as SessionId,
            command.to.area === 'focus'
          );
          break;
        case 'touchOnSend': {
          reached = await readSessionMetas(command.sessionId as SessionId, false);
          const rootId = reached[0]?.parentSessionId;
          if (rootId) {
            command = { type: 'touchOnSend', sessionId: rootId };
            reached = await readSessionMetas(rootId, false);
          }
          break;
        }
        case 'setPinned': {
          const pinnedId = command.sessionId;
          const target = await readSessionMetas(pinnedId as SessionId, false);
          if (target.length === 0) return [];
          // The new pin's key is planned against every pin in the default section.
          reached = [
            ...Object.values(store.get(sessionMetaCacheAtom)).filter(
              (meta) => meta.isArchived !== true && meta.id !== pinnedId
            ),
            ...target,
          ];
          break;
        }
        default:
          break;
      }
      const related = statusViewSessionsFromMetas(reached, {
        keepArchivedId: 'sessionId' in command ? command.sessionId : undefined,
      }).filter((session) => !listed.has(session.id));
      const writes = planStatusViewCommand(
        { ...base, related: [...(base.related ?? []), ...related] },
        command,
        { nowMs: getServerNow(), randomByte }
      );
      await applyStatusViewWrites(writes);
      return writes;
    },
    [runtime, store, readSessionMetas, applyStatusViewWrites]
  );
  const runStatusViewCommandRef = useRef(runStatusViewCommand);
  runStatusViewCommandRef.current = runStatusViewCommand;

  const setSessionPinned = useCallback(
    async (sessionId: SessionId, pinned: boolean) => {
      await runStatusViewCommand({ type: 'setPinned', sessionId, pinned });
    },
    [runStatusViewCommand]
  );

  const snoozeSession = useCallback(
    async (sessionId: SessionId, until: number, options?: { includeOpenedSessions?: boolean }) => {
      await runStatusViewCommand({
        type: 'snooze',
        sessionId,
        until,
        includeOpened: options?.includeOpenedSessions === true,
      });
    },
    [runStatusViewCommand]
  );

  const settleSession = useCallback(
    async (sessionId: SessionId, options?: { includeOpenedSessions?: boolean }) => {
      await runStatusViewCommand({
        type: 'settle',
        sessionId,
        includeOpened: options?.includeOpenedSessions === true,
      });
    },
    [runStatusViewCommand]
  );

  const moveSessionToFocus = useCallback(
    async (sessionId: SessionId, options?: { includeOpenedSessions?: boolean }) => {
      await runStatusViewCommand({
        type: 'moveToFocus',
        sessionId,
        includeOpened: options?.includeOpenedSessions === true,
      });
    },
    [runStatusViewCommand]
  );

  return {
    createSession,
    startSession,
    addSessionHistory,
    requestSessionDispatch,
    requestSessionCancel,
    requestSessionSteer,
    requestSessionGoal,
    touchSessionActivity,
    updateSessionStatus,
    updateSessionTitle,
    updateSessionMetadata,
    setSessionTabClosed,
    transferSessionOwner,
    markSessionRead,
    markSessionUnread,
    deleteSessions,
    archiveSession,
    setTreeCollaborationStopped,
    restoreSession,
    deleteArchivedSession,
    setSessionPinned,
    runStatusViewCommand,
    snoozeSession,
    settleSession,
    moveSessionToFocus,
  };
}
