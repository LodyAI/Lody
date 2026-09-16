import { useCallback, useMemo } from 'react';
import { useCloudMutation } from '@lody/platform/react';
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
  collectSessionArchiveTargets,
  getMachineFlockDocId,
  getMachineFlockDeleteLocalProjectIds,
  getMachineFlockLocalProjects,
  getSessionRoomId,
  machineFlockKeys,
  SessionStatusFactory,
  getLocalProjectHistoryProviderKey,
  getServerNow,
  evaluateSessionCreateQuota,
  formatSessionQuotaRejection,
  isConvexUnauthenticatedError,
  isLoroRepoDocDeleted,
  readMachineFlockRowsFromFlock,
  sanitizeMessageTextSpans,
} from '@lody/shared';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { usePostHog } from '@posthog/react';
// Default import: `debug` is CJS. Named `{ debug }` breaks Vite 8 / TanStack
// module-runner interop used by site-docs SSR (UNEXPECTED named-export error).
import debug from 'debug';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import {
  docMetaCacheReadyAtom,
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
      if (span.kind === 'pasted_text') continue;
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

function getDirectChildSessions(
  sessionId: SessionId,
  sessions: readonly SessionMeta[]
): SessionMeta[] {
  return sessions.filter(
    (session) => session.id !== sessionId && session.parentSessionId === sessionId
  );
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
    history: Omit<SessionHistoryInput, 'id'>
  ) => Promise<StartSessionResult>;
  addSessionHistory: (
    sessionId: SessionId,
    history: Omit<SessionHistoryInput, 'id'>,
    options?: { dispatch?: boolean; guideExpectedTurnId?: string }
  ) => Promise<SessionHistory>;
  requestSessionDispatch: (
    sessionId: SessionId,
    userTurnId: string,
    options?: { inputConfig?: SessionTurnInputConfig; machineId?: MachineId | null }
  ) => Promise<void>;
  requestSessionCancel: (sessionId: SessionId, turnId: string) => Promise<void>;
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
  /** Reassign `SessionMeta.userId` to another workspace member. */
  transferSessionOwner: (sessionId: SessionId, nextUserId: string) => Promise<void>;
  markSessionRead: (sessionId: SessionId, lastMessageAt?: number | null) => Promise<void>;
  markSessionUnread: (sessionId: SessionId) => Promise<void>;
  /** Delete exactly the supplied Sessions without discovering related Sessions. */
  deleteSessions: (sessionIds: SessionId[]) => Promise<void>;
  archiveSession: (sessionId: SessionId) => Promise<void>;
  restoreSession: (sessionId: SessionId) => Promise<void>;
  deleteArchivedSession: (sessionId: SessionId) => Promise<void>;
  setSessionPinned: (sessionId: SessionId, isPinned: boolean) => Promise<void>;
};

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
  proposal: SessionActivityProposal
): Promise<SessionMeta | undefined> {
  const roomId = getSessionRoomId(sessionId);
  const existing = await runtime.repo.getDocMeta(roomId);
  if (isLoroRepoDocDeleted(existing)) return undefined;
  const meta = existing?.meta as SessionMeta | undefined;
  const patch = buildSessionActivityPatch(meta, proposal);
  if (Object.keys(patch).length > 0) {
    await runtime.writer.upsertDocMeta(roomId, patch as RepoDocMetaPatch);
  }
  return meta;
}

export async function touchSessionActivityMeta(
  runtime: WorkspaceRuntime,
  sessionId: SessionId,
  proposal: SessionActivityProposal
): Promise<void> {
  const meta = await upsertSessionActivityPatch(runtime, sessionId, proposal);
  const parentSessionId = meta?.parentSessionId;
  if (parentSessionId && parentSessionId !== sessionId) {
    await upsertSessionActivityPatch(runtime, parentSessionId, proposal);
  }
}

export function useSessionActions(): SessionActions {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
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
  const recordMyWorkspaceDailyActiveUser = useCloudMutation(
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
        assertSessionCreateAllowed,
        recordWorkspaceActivity,
        publishSessionMeta: setDocMetaByRoomId,
        readSessionMeta: (sessionId) =>
          store.get(sessionMetaCacheAtom)[getSessionRoomId(sessionId)],
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
      assertSessionCreateAllowed,
      recordWorkspaceActivity,
      setDocMetaByRoomId,
      store,
      postHog,
    ]
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
      await runtime.writer.upsertDocMeta(roomId, { status: nextStatus } as Partial<SessionMeta>);
    },
    [runtime]
  );

  const requestSessionCancel = useCallback(
    async (sessionId: SessionId, turnId: string) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(existing)) return;
      const meta = existing?.meta as SessionMeta | undefined;
      const machineId = meta?.machineId;
      if (machineId) {
        // Fast-path RPC is intentionally redundant with the durable meta fallback below.
        void runtime
          .requestSessionCancel(machineId, sessionId, turnId, { timeoutMs: 2_000 })
          .then((response) => {
            if (response && !response.success) {
              log('session cancel rpc failed for %s/%s: %s', sessionId, turnId, response.error);
            }
          })
          .catch((error) => {
            log('session cancel rpc threw for %s/%s: %o', sessionId, turnId, error);
          });
      }
      await runtime.writer.upsertDocMeta(roomId, {
        // Stop targets the assistant turn currently on screen, not the originating user turn.
        lastCanceledTurn: turnId,
      } as Partial<SessionMeta>);
    },
    [runtime]
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
    [runtime]
  );

  const touchSessionActivity = useCallback(
    async (sessionId: SessionId) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const now = getServerNow();
      await touchSessionActivityMeta(runtime, sessionId, { lastMessageAt: now, lastReadAt: now });
    },
    [runtime]
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
      await runtime.writer.upsertDocMeta(roomId, {
        title: nextTitle,
        titleSource: 'user',
      } as Partial<SessionMeta>);
    },
    [runtime]
  );

  /**
   * Hand a session to another workspace member. `SessionMeta.userId` is the
   * owner: it drives the My/Team scope split, the sidebar author avatar, and
   * CLI-side owner checks (Code Collab writes, usage attribution). Anyone in
   * the workspace may transfer, mirroring task owner assignment.
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
      await runtime.writer.upsertDocMeta(roomId, {
        userId,
      } as Partial<SessionMeta>);
    },
    [runtime]
  );

  const markSessionRead = useCallback(
    async (sessionId: SessionId, lastMessageAt?: number | null) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const readAt = getFiniteTimestamp(lastMessageAt) ?? getServerNow();
      await touchSessionActivityMeta(runtime, sessionId, { lastReadAt: readAt });
    },
    [runtime]
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
      if (lastMessageAt === null) return;

      // Unread is the durable comparison `lastMessageAt > lastReadAt`. Move
      // only this receipt behind the latest known message; do not touch the
      // activity timestamp, which would reorder the sidebar.
      await runtime.writer.upsertDocMeta(roomId, {
        lastReadAt: lastMessageAt - 1,
      } as Partial<SessionMeta>);
    },
    [runtime, store]
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

      await Promise.all([
        runtime.writer.deleteDoc(sessionRoomId),
        runtime.releaseSessionStore(sessionId),
      ]);
    },
    [invalidateExternalHistoryCatalog, runtime]
  );

  const deleteSessions = useCallback(
    async (sessionIds: SessionId[]) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      await Promise.all(sessionIds.map((id) => deleteSessionDocuments(id)));
    },
    [runtime, deleteSessionDocuments]
  );

  const archiveSession = useCallback(
    async (sessionId: SessionId) => {
      log('[session-archive] start', { sessionId });
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      if (!store.get(docMetaCacheReadyAtom)) {
        throw new Error('Session metadata is still loading');
      }

      const sessionRoomId = getSessionRoomId(sessionId);
      const repoMeta = (await runtime.repo.getDocMeta(sessionRoomId))?.meta as
        | SessionMeta
        | undefined;
      // The repo read is preferred (freshest lifecycle fields), but it can lag
      // a session the UI already renders. The archive write below is an
      // idempotent patch, so the rendered meta cache is enough to proceed — a
      // session the UI can show must also be closable.
      const sessionMeta =
        repoMeta ?? (store.get(sessionMetaCacheAtom)[sessionRoomId] as SessionMeta | undefined);
      if (!sessionMeta) {
        throw new Error(`Session metadata missing for ${sessionId}`);
      }
      log('[session-archive] session meta loaded', {
        sessionId,
        machineId: sessionMeta.machineId,
      });

      const archiveTargets = [
        { ...sessionMeta, id: sessionId },
        ...collectSessionArchiveTargets(sessionId, Object.values(store.get(sessionMetaCacheAtom))),
      ];
      for (const session of archiveTargets) {
        if (typeof window !== 'undefined') {
          sendIpc('terminal.closeSession', { sessionId: session.id });
        }
        // The archived state is the whole request: the owning machine observes
        // it, releases the runtime, and reconciles the worktree directory.
        await runtime.writer.upsertDocMeta(getSessionRoomId(session.id), {
          isArchived: true,
          status: SessionStatusFactory.idle(),
        } as Partial<SessionMeta>);
      }
      log('[session-archive] archived', {
        sessionId,
        targetSessionIds: archiveTargets.map((session) => session.id),
      });
    },
    [runtime, store]
  );

  const restoreSession = useCallback(
    async (sessionId: SessionId) => {
      log('[session-restore] start', { sessionId });
      if (!runtime) {
        throw new Error('Runtime not ready');
      }

      const sessionRoomId = getSessionRoomId(sessionId);
      const sessionMeta = (await runtime.repo.getDocMeta(sessionRoomId))?.meta as
        | SessionMeta
        | undefined;
      if (!sessionMeta) {
        throw new Error(`Session metadata missing for ${sessionId}`);
      }
      await assertArchivedLocalProjectCanRestore(runtime, sessionMeta);
      const archiveTargets = [
        { ...sessionMeta, id: sessionMeta.id ?? sessionId },
        ...getDirectChildSessions(sessionId, Object.values(store.get(sessionMetaCacheAtom))),
      ];

      for (const session of archiveTargets) {
        await runtime.writer.upsertDocMeta(getSessionRoomId(session.id), {
          isArchived: false,
        } as Partial<SessionMeta>);
      }
      log('[session-restore] restored', {
        sessionId,
        targetSessionIds: archiveTargets.map((session) => session.id),
      });
    },
    [runtime, store]
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
      if (!store.get(docMetaCacheReadyAtom)) {
        throw new Error('Session metadata is still loading');
      }
      const loadedMeta = (await runtime.repo.getDocMeta(getSessionRoomId(sessionId)))?.meta as
        | SessionMeta
        | undefined;
      if (!loadedMeta) throw new Error(`Session metadata missing for ${sessionId}`);
      const rootMeta = { ...loadedMeta, id: loadedMeta.id ?? sessionId };
      const deleteTargets = [
        rootMeta,
        ...getDirectChildSessions(sessionId, Object.values(store.get(sessionMetaCacheAtom))),
      ];

      for (const session of [...deleteTargets].reverse()) {
        await deleteArchivedSessionMeta(session);
      }
      log('[session-delete] deleted', {
        sessionId,
        targetSessionIds: deleteTargets.map((session) => session.id),
      });
    },
    [runtime, store, deleteArchivedSessionMeta]
  );

  const setSessionPinned = useCallback(
    async (sessionId: SessionId, isPinned: boolean) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(existing)) return;
      await runtime.writer.upsertDocMeta(roomId, {
        isPinned,
      } as Partial<SessionMeta>);
    },
    [runtime]
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
    transferSessionOwner,
    markSessionRead,
    markSessionUnread,
    deleteSessions,
    archiveSession,
    restoreSession,
    deleteArchivedSession,
    setSessionPinned,
  };
}
