import { useCallback } from 'react';
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
  SessionDocMeta,
  SessionTurnInputConfig,
  MachineFlockKey,
  MachineFlockRow,
} from '@lody/shared';
import {
  buildMachineArchiveSessionCommand,
  buildMachineDeleteSessionCommand,
  getMachineRoomId,
  getMachineFlockDocId,
  getMachineFlockDeleteLocalProjectIds,
  getMachineFlockLocalProjects,
  getSessionRoomId,
  machineFlockKeys,
  machineDeleteCommandToQueueItem,
  SessionStatusFactory,
  getLocalProjectHistoryProviderKey,
  getServerNow,
  evaluateSessionCreateQuota,
  formatSessionQuotaRejection,
  isConvexUnauthenticatedError,
  isLoroRepoDocDeleted,
  normalizeSessionTurnInputConfig,
  readMachineFlockRowsFromFlock,
  sanitizeMessageTextSpans,
  shouldQueueMachineDeleteSession,
} from '@lody/shared';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { usePostHog } from '@posthog/react';
// Default import: `debug` is CJS. Named `{ debug }` breaks Vite 8 / TanStack
// module-runner interop used by site-docs SSR (UNEXPECTED named-export error).
import debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
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
import { resolveSessionCreateRepoFullName } from '@/lib/session-repo';
import { collectSessionLifecycleIds } from '@/lib/session-lifecycle';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { sendIpc } from '@/lib/electron-ipc-client';
import { useAuthenticatedConvex } from './use-authenticated-convex';

const log = debug('lody:session-actions');

type RepoDocMetaPatch = Parameters<WorkspaceRuntime['repo']['upsertDocMeta']>[1];
type CreateSessionResult = {
  sessionId: SessionId;
  sessionMeta: SessionMeta;
};
type StartSessionResult = CreateSessionResult & {
  historyEntry: SessionHistory;
};

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

function buildSessionCreateResult(payload: SessionToCreate): CreateSessionResult {
  const sessionId = payload.sessionId ?? (uuidv4() as SessionId);
  const sessionMeta: SessionMeta = {
    id: sessionId,
    machineId: payload.machineId,
    userId: payload.userId,
    status: SessionStatusFactory.idle(),
    isArchived: false,
    createdAt: new Date().toISOString(),
    cliType: payload.cliType,
    agentType: payload.agentType,
    agentConfigId: payload.agentConfigId,
    acpSessionId: undefined,
    diffStats: undefined,
  };
  if (payload.title?.trim()) {
    sessionMeta.title = payload.title.trim();
    sessionMeta.titleSource = payload.titleSource ?? 'user';
  }
  if (payload.fromFeedbackPostId?.trim()) {
    sessionMeta.fromFeedbackPostId = payload.fromFeedbackPostId.trim();
  }
  const repoFullName = resolveSessionCreateRepoFullName(payload);
  if (repoFullName) {
    sessionMeta.repoFullName = repoFullName;
  }
  if (payload.project) {
    sessionMeta.project = payload.project;
  }
  if (
    payload.isWorktree === true ||
    payload.project?.kind === 'github' ||
    payload.project?.useWorktree === true
  ) {
    sessionMeta.isWorktree = true;
  }
  const baseBranch =
    payload.project?.kind === 'local'
      ? undefined
      : payload.project?.branch?.trim() || payload.branchName?.trim();
  if (baseBranch) {
    sessionMeta.baseBranch = baseBranch;
  }
  if (payload.parentSessionId) {
    sessionMeta.parentSessionId = payload.parentSessionId;
  }
  // Where this session came from, not how it runs: the launch config above is
  // already frozen, so nothing re-reads the mutable Role catalog from these.
  if (payload.agentRoleId) {
    sessionMeta.agentRoleId = payload.agentRoleId;
    if (typeof payload.agentRoleRevision === 'number') {
      sessionMeta.agentRoleRevision = payload.agentRoleRevision;
    }
  }
  return { sessionId, sessionMeta };
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

async function writeMachineFlockRowBestEffort(
  runtime: WorkspaceRuntime,
  machineId: string,
  row: MachineFlockRow,
  reason: string
): Promise<void> {
  try {
    await writeMachineFlockRowRequired(runtime, machineId, row);
  } catch (error) {
    log('[machine-flock] failed to write command row', { machineId, reason, error });
  }
}

async function writeMachineFlockRowRequired(
  runtime: WorkspaceRuntime,
  machineId: string,
  row: MachineFlockRow
): Promise<void> {
  await runtime.writer.flockRowPut(
    getMachineFlockDocId(runtime.workspaceId, machineId as MachineId),
    row.key,
    row.value
  );
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

async function cleanupMachineSessionCommandQueues(
  runtime: WorkspaceRuntime,
  machineId: string,
  sessionId: SessionId,
  reason: string
): Promise<void> {
  const machineRoomId = getMachineRoomId(machineId as MachineId);
  const machineMeta = (await runtime.repo.getDocMeta(machineRoomId))?.meta as
    | MachineLegacyMetaFields
    | undefined;
  const needToArchiveSessions = machineMeta?.needToArchiveSessions ?? {};
  const needToDeleteSessions = machineMeta?.needToDeleteSessions ?? {};

  let nextNeedToArchiveSessions: typeof needToArchiveSessions | undefined;
  let nextNeedToDeleteSessions: typeof needToDeleteSessions | undefined;

  if (needToArchiveSessions[sessionId] !== undefined) {
    const { [sessionId]: _, ...rest } = needToArchiveSessions;
    nextNeedToArchiveSessions = rest;
  }

  if (needToDeleteSessions[sessionId] !== undefined) {
    const { [sessionId]: _, ...rest } = needToDeleteSessions;
    nextNeedToDeleteSessions = rest;
  }

  if (nextNeedToArchiveSessions !== undefined || nextNeedToDeleteSessions !== undefined) {
    await runtime.writer.upsertDocMeta(machineRoomId, {
      ...(nextNeedToArchiveSessions !== undefined
        ? { needToArchiveSessions: nextNeedToArchiveSessions }
        : {}),
      ...(nextNeedToDeleteSessions !== undefined
        ? { needToDeleteSessions: nextNeedToDeleteSessions }
        : {}),
    } as unknown as RepoDocMetaPatch);
  }

  await deleteMachineFlockRowsBestEffort(
    runtime,
    machineId,
    [
      machineFlockKeys.archiveSessionCommand(sessionId),
      machineFlockKeys.deleteSessionCommand(sessionId),
    ],
    reason
  );
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
    options?: { dispatch?: boolean }
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
  touchSessionActivity: (sessionId: SessionId) => Promise<void>;
  updateSessionStatus: (sessionId: SessionId, status: SessionStatus) => Promise<void>;
  updateSessionTitle: (sessionId: SessionId, title: string) => Promise<void>;
  /** Reassign `SessionMeta.userId` to another workspace member. */
  transferSessionOwner: (sessionId: SessionId, nextUserId: string) => Promise<void>;
  markSessionRead: (sessionId: SessionId, lastMessageAt?: number | null) => Promise<void>;
  markSessionUnread: (sessionId: SessionId) => Promise<void>;
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

/**
 * Fire the `session/dispatch-turn` Machine RPC fast path for a user turn that
 * is (or is about to be) durable. Returns a promise resolving to whether the
 * machine accepted the offer, or null when the offer cannot be built. The RPC
 * only accelerates dispatch — the durable `latestUserMsgId` pointer write
 * remains recovery truth.
 */
function fireSessionDispatchTurnRpc(
  runtime: WorkspaceRuntime,
  store: ReturnType<typeof useStore>,
  args: {
    sessionId: SessionId;
    userTurnId: string;
    machineId: MachineId | null | undefined;
    timestamp: string | undefined;
    inputConfig: SessionTurnInputConfig | undefined;
    dispatchUserId: string | undefined;
  }
): Promise<boolean> | null {
  const { sessionId, userTurnId, machineId, timestamp, inputConfig, dispatchUserId } = args;
  // The Machine RPC fast path rides the facade's per-target routing: local
  // machines go over the local socket RPC, remote machines over the cloud
  // JSON stream.
  if (!machineId || !timestamp || !inputConfig || !dispatchUserId) {
    return null;
  }
  const rpcArgs = {
    sessionId,
    userTurnId,
    userId: dispatchUserId,
    timestamp,
    inputConfig,
  };
  // Attachments ride as R2/local references, so payloads are normally
  // small; skip the fast path for pathological sizes rather than risk an
  // oversized stream append.
  try {
    if (JSON.stringify(rpcArgs).length > 256 * 1024) {
      return null;
    }
  } catch {
    return null;
  }
  return runtime
    .requestSessionDispatchTurn(machineId, rpcArgs)
    .then((response) => {
      if (response?.accepted) {
        store.set(rpcDeliveredTurnsAtom, (previous) =>
          addRpcDeliveredTurn(previous, getRpcDeliveredTurnKey(sessionId, userTurnId))
        );
        return true;
      }
      log(
        'session dispatch-turn rpc not accepted for %s/%s: %s',
        sessionId,
        userTurnId,
        response
          ? `${response.disposition}${response.error ? `: ${response.error}` : ''}`
          : 'timeout'
      );
      return false;
    })
    .catch((error) => {
      log('session dispatch-turn rpc threw for %s/%s: %o', sessionId, userTurnId, error);
      return false;
    });
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

  const getSessionLifecycleMetas = useCallback(
    (sessionId: SessionId, rootMeta: SessionMeta): SessionMeta[] => {
      const cache = store.get(sessionMetaCacheAtom);
      const sessionsById = new Map(
        Object.values(cache).map((session) => [session.id, session] as const)
      );
      sessionsById.set(sessionId, { ...rootMeta, id: rootMeta.id ?? sessionId });
      return collectSessionLifecycleIds(sessionId, [...sessionsById.values()]).map((id) => {
        const session = sessionsById.get(id);
        if (!session) throw new Error(`Session metadata missing for lifecycle child ${id}`);
        return session;
      });
    },
    [store]
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

  const createSession = useCallback(
    async (payload: SessionToCreate): Promise<CreateSessionResult> => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const { sessionId, sessionMeta } = buildSessionCreateResult(payload);
      const sessionRoomId = getSessionRoomId(sessionId);
      // The local Flock index is the session-count source of truth. Incomplete
      // local state fails open so session creation never depends on Convex
      // availability or a server-side reservation.
      assertSessionCreateAllowed(sessionId);
      if (payload.parentSessionId) {
        // Creating a child session (filter/sieve) is an explicit active user action.
        recordWorkspaceActivity(runtime.workspaceId);
      }

      const metaWrite = runtime.writer.upsertDocMeta(sessionRoomId, sessionMeta);
      // Stream pre-creation is a warm-up, not part of accepting the user's turn.
      // Rejected: awaiting it here lets a stuck createStream() prevent history
      // and dispatch writes. Room join/retry handles stream_not_found recovery.
      void runtime.ensureDocStream(sessionRoomId).catch((error: unknown) => {
        console.warn('Failed to pre-create session doc stream', { sessionId, error });
      });
      await metaWrite;
      setDocMetaByRoomId(sessionRoomId, sessionMeta);

      return { sessionId, sessionMeta };
    },
    [assertSessionCreateAllowed, recordWorkspaceActivity, runtime, setDocMetaByRoomId]
  );

  const startSession = useCallback(
    async (
      payload: SessionToCreate,
      history: Omit<SessionHistoryInput, 'id'>
    ): Promise<StartSessionResult> => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const { sessionId, sessionMeta } = buildSessionCreateResult(payload);
      // The accept unit includes the first user message, so the meta it
      // publishes already carries that activity. Written here, not by a
      // follow-up touch: a close between acceptance and the first turn must
      // never make the session look empty (empty tabs are deleted, not
      // archived).
      sessionMeta.lastMessageAt = getServerNow();
      const sessionRoomId = getSessionRoomId(sessionId);
      const historyEntry = { ...history, id: uuidv4() } as SessionHistory;
      const inputConfig = normalizeSessionTurnInputConfig(historyEntry.inputConfig);
      const userId = historyEntry.userId?.trim();
      const timestamp = historyEntry.timestamp?.trim();
      if (historyEntry.role !== 'user' || !userId || !timestamp || !inputConfig) {
        throw new Error(`Cannot start session with invalid user history (sessionId=${sessionId})`);
      }

      assertSessionCreateAllowed(sessionId);
      recordWorkspaceActivity(runtime.workspaceId);
      void runtime.ensureDocStream(sessionRoomId).catch((error: unknown) => {
        console.warn('Failed to pre-create session doc stream', { sessionId, error });
      });
      await runtime.writer.startSession(
        sessionId,
        sessionMeta as unknown as Record<string, unknown>,
        historyEntry as unknown as Record<string, unknown>,
        {
          userTurnId: historyEntry.id,
          userId,
          timestamp,
          inputConfig: inputConfig as unknown as Record<string, unknown>,
        }
      );
      setDocMetaByRoomId(sessionRoomId, sessionMeta);
      capturePostHogEvent(postHog, 'session/chat', {
        user_id: sessionMeta.userId,
        workspace_id: runtime.workspaceId,
        session_id: sessionId,
        machine_id: sessionMeta.machineId,
        agent_config_id: sessionMeta.agentConfigId,
        cli_type: sessionMeta.cliType,
        agent_type: sessionMeta.agentType,
        project_kind: sessionMeta.project?.kind ?? null,
        is_first_message: true,
        session_type: resolveSessionChatType(sessionMeta),
        ...countSessionMentions(history.items),
      });
      return { sessionId, sessionMeta, historyEntry };
    },
    [postHog, recordWorkspaceActivity, assertSessionCreateAllowed, runtime, setDocMetaByRoomId]
  );

  const addSessionHistory = useCallback(
    async (
      sessionId: SessionId,
      history: Omit<SessionHistoryInput, 'id'>,
      options?: { dispatch?: boolean }
    ) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }

      // Sending any user message (new chat, reply, child-session/filter reply)
      // counts as an explicit active user action.
      if (history.role === 'user') {
        recordWorkspaceActivity(runtime.workspaceId);
      }

      const entry = { ...history, id: uuidv4() } as SessionHistory;

      // The pending user turn is authored through the writer seam. In direct
      // (web/cloud) mode the writer authors it into the renderer's own repo,
      // exactly as `sessionStore.setState(history.push(entry))` did before. In
      // intent (Electron local-first) mode it forwards the append to the CLI —
      // the sole author — which relays the authored op back into the local
      // mirror and up to Loro Streams. This resolves when the write is ACCEPTED
      // (the send hot-path accept boundary), not when remote sync completes; the
      // caller may clear the composer / navigate once it returns. It REJECTS
      // when the write did not happen (intent failed after bounded retries),
      // which propagates to the send paths' failure branches — the composer
      // stays intact and the error is surfaced instead of the message silently
      // vanishing.
      //
      let dispatch:
        | {
            userTurnId: string;
            userId: string;
            timestamp: string;
            inputConfig: Record<string, unknown>;
          }
        | undefined;
      if (options?.dispatch) {
        const inputConfig = normalizeSessionTurnInputConfig(entry.inputConfig);
        const userId = entry.userId?.trim();
        const timestamp = entry.timestamp?.trim();
        if (!userId || !timestamp || !inputConfig) {
          throw new Error(`Cannot dispatch invalid user history entry (sessionId=${sessionId})`);
        }
        dispatch = {
          userTurnId: entry.id,
          userId,
          timestamp,
          inputConfig: inputConfig as unknown as Record<string, unknown>,
        };
      }
      await runtime.writer.appendSessionTurn(
        sessionId,
        entry as unknown as Record<string, unknown>,
        dispatch
      );
      // session/chat fires once for every user message dispatched through Lody —
      // the session-creating turn AND every follow-up — so it tracks active-use
      // frequency, unlike session/start_success which only covers creation. This
      // is the single convergence point for both the chat-landing (new session)
      // and session-chat-interface (reply/queue/child) send paths.
      if (history.role === 'user') {
        const sessionMeta = store.get(sessionMetaCacheAtom)[getSessionRoomId(sessionId)];
        capturePostHogEvent(postHog, 'session/chat', {
          user_id: sessionMeta?.userId,
          workspace_id: runtime.workspaceId,
          session_id: sessionId,
          machine_id: sessionMeta?.machineId,
          agent_config_id: sessionMeta?.agentConfigId,
          cli_type: sessionMeta?.cliType,
          agent_type: sessionMeta?.agentType,
          project_kind: sessionMeta?.project?.kind ?? null,
          is_first_message: false,
          session_type: resolveSessionChatType(sessionMeta),
          ...countSessionMentions(history.items),
        });
      }
      return entry;
    },
    [runtime, recordWorkspaceActivity, postHog, store]
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

  const requestSessionDispatch = useCallback(
    async (
      sessionId: SessionId,
      userTurnId: string,
      options?: { inputConfig?: SessionTurnInputConfig; machineId?: MachineId | null }
    ) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const entry = await runtime.withSessionStore(sessionId, (sessionStore) =>
        sessionStore
          .getState()
          .history.find((item) => item.id === userTurnId && item.role === 'user')
      );
      const inputConfig =
        options?.inputConfig ?? normalizeSessionTurnInputConfig(entry?.inputConfig);
      const dispatchUserId = entry?.userId?.trim();
      let rpcAcceptedPromise: Promise<boolean> | null = null;
      const startDispatchTurnRpc = (machineId: MachineId | null | undefined): void => {
        // The durable pointer write below remains recovery truth.
        rpcAcceptedPromise = fireSessionDispatchTurnRpc(runtime, store, {
          sessionId,
          userTurnId,
          machineId,
          timestamp: entry?.timestamp,
          inputConfig,
          dispatchUserId,
        });
      };

      // Local history writes are the accept boundary. Remote document sync is a
      // sibling of dispatch signaling, never a blocker for clearing the composer.
      // Hold a store ref for the flush so eviction cannot unload the doc mid-flush.
      void runtime
        .withSessionStore(sessionId, (sessionStore) => sessionStore.waitUntilSynced())
        .catch((error: unknown) => {
          console.warn('Failed to sync session doc after dispatch request', {
            sessionId,
            userTurnId,
            error,
          });
        });
      startDispatchTurnRpc(options?.machineId ?? null);
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(existing)) {
        return;
      }
      if (!options?.machineId) {
        const meta = existing?.meta as SessionMeta | undefined;
        startDispatchTurnRpc(meta?.machineId ?? null);
      }
      try {
        await runtime.writer.upsertDocMeta(roomId, {
          latestUserMsgId: userTurnId,
        } as Partial<SessionMeta>);
      } catch (error) {
        // The RPC fast path may already have delivered this turn to the CLI; a
        // rejection here would make callers toast "failed to send" for a turn
        // that is actually running, inviting a duplicate resend. Only surface
        // the failure when the fast path did not deliver.
        if (await rpcAcceptedPromise) {
          console.warn('Dispatch metadata write failed after RPC fast-path delivery', {
            sessionId,
            userTurnId,
            error,
          });
          return;
        }
        throw error;
      }
    },
    [runtime, store]
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

  const requestSessionSteer = useCallback(
    async (
      sessionId: SessionId,
      expectedTurnId: string,
      userTurnId: string,
      options?: { machineId?: MachineId | null }
    ): Promise<boolean> => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const entry = await runtime.withSessionStore(sessionId, (sessionStore) =>
        sessionStore
          .getState()
          .history.find((item) => item.id === userTurnId && item.role === 'user')
      );
      const inputConfig = normalizeSessionTurnInputConfig(entry?.inputConfig);
      const userId = entry?.userId?.trim();
      const roomId = getSessionRoomId(sessionId);
      let machineId = options?.machineId ?? null;
      if (!machineId) {
        const existing = await runtime.repo.getDocMeta(roomId);
        const meta = isLoroRepoDocDeleted(existing)
          ? undefined
          : (existing?.meta as SessionMeta | undefined);
        machineId = meta?.machineId ?? null;
      }
      if (!entry || !inputConfig || !userId || !machineId) {
        return false;
      }
      const response = await runtime.requestSessionSteer(machineId, {
        sessionId,
        expectedTurnId,
        userTurnId,
        userId,
        timestamp: entry.timestamp,
        inputConfig,
      });
      if (response?.applied) {
        store.set(rpcDeliveredTurnsAtom, (previous) =>
          addRpcDeliveredTurn(previous, getRpcDeliveredTurnKey(sessionId, userTurnId))
        );
        return true;
      }
      if (response?.disposition === 'no-active-turn') {
        // The target prompt ended before the CLI submitted the steer. Reuse
        // the same user turn as a normal follow-up instead of leaving it stuck
        // in pending_apply. Other failures must not fall back because the
        // provider may already have committed the steer.
        // Re-acquire the store for the write: the steer RPC above can run long,
        // and we must not hold a store ref across it.
        const promoted = await runtime.withSessionStore(sessionId, (sessionStore) => {
          let didPromote = false;
          sessionStore.setState((draft: SessionDocMeta) => {
            const pendingEntry = draft.history.find(
              (item) => item.id === userTurnId && item.role === 'user'
            );
            if (pendingEntry?.status === 'pending_apply') {
              pendingEntry.status = 'pending';
              pendingEntry.read = false;
              didPromote = true;
            }
          });
          return didPromote;
        });
        // A duplicate response must not reset a turn that another request has
        // already promoted, started, or completed.
        if (!promoted) {
          return false;
        }
        await requestSessionDispatch(sessionId, userTurnId, {
          inputConfig,
          machineId,
        });
        log(
          'session steer promoted to ordinary dispatch for %s/%s after target turn ended',
          sessionId,
          userTurnId
        );
        return false;
      }
      log(
        'session steer not applied for %s/%s: %s',
        sessionId,
        userTurnId,
        response
          ? `${response.disposition}${response.error ? `: ${response.error}` : ''}`
          : 'timeout'
      );
      return false;
    },
    [requestSessionDispatch, runtime, store]
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
      const sessions = Object.values(store.get(sessionMetaCacheAtom));
      const allIds = new Set(sessionIds);
      for (const id of sessionIds) {
        for (const lifecycleId of collectSessionLifecycleIds(id, sessions)) {
          allIds.add(lifecycleId);
        }
      }
      const uniqueIds = Array.from(allIds);
      await Promise.all(
        uniqueIds.map(async (id) => {
          await deleteSessionDocuments(id);
        })
      );
    },
    [runtime, store, deleteSessionDocuments]
  );

  const archiveSession = useCallback(
    async (sessionId: SessionId) => {
      log('[session-archive] start', { sessionId });
      if (!runtime) {
        throw new Error('Runtime not ready');
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

      const lifecycleSessions = getSessionLifecycleMetas(sessionId, sessionMeta);
      for (const session of lifecycleSessions) {
        if (typeof window !== 'undefined') {
          sendIpc('terminal.closeSession', { sessionId: session.id });
        }
        await runtime.writer.upsertDocMeta(getSessionRoomId(session.id), {
          isArchived: true,
          status: SessionStatusFactory.idle(),
        } as Partial<SessionMeta>);

        // Child tabs share the owning Session's workspace and machine command.
        if (session.parentSessionId) continue;

        const machineId = session.machineId;
        const requestedAt = getServerNow();
        await writeMachineFlockRowBestEffort(
          runtime,
          machineId,
          {
            key: machineFlockKeys.archiveSessionCommand(session.id),
            value: buildMachineArchiveSessionCommand({ requestedAt }),
          },
          'archiveSession'
        );
        const machineRoomId = getMachineRoomId(machineId);
        const machineMeta = (await runtime.repo.getDocMeta(machineRoomId))?.meta as
          | MachineLegacyMetaFields
          | undefined;
        await runtime.writer.upsertDocMeta(machineRoomId, {
          needToArchiveSessions: {
            ...(machineMeta?.needToArchiveSessions ?? {}),
            [session.id]: true,
          },
        } as unknown as RepoDocMetaPatch);
      }
      log('[session-archive] lifecycle archived', {
        sessionId,
        lifecycleSessionIds: lifecycleSessions.map((session) => session.id),
      });
    },
    [runtime, store, getSessionLifecycleMetas]
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
      const lifecycleSessions = getSessionLifecycleMetas(sessionId, sessionMeta);

      for (const session of lifecycleSessions) {
        await runtime.writer.upsertDocMeta(getSessionRoomId(session.id), {
          isArchived: false,
        } as Partial<SessionMeta>);
        if (!session.parentSessionId) {
          await cleanupMachineSessionCommandQueues(
            runtime,
            session.machineId,
            session.id,
            'restoreSession'
          );
        }
      }
      log('[session-restore] lifecycle restored', {
        sessionId,
        lifecycleSessionIds: lifecycleSessions.map((session) => session.id),
      });
    },
    [runtime, getSessionLifecycleMetas]
  );

  const deleteArchivedSessionMeta = useCallback(
    async (sessionMeta: SessionMeta) => {
      if (!runtime) throw new Error('Runtime not ready');
      const sessionId = sessionMeta.id;
      const shouldQueueMachineCleanup = shouldQueueMachineDeleteSession(sessionMeta);

      if (!shouldQueueMachineCleanup) {
        if (sessionMeta.machineId) {
          await cleanupMachineSessionCommandQueues(
            runtime,
            sessionMeta.machineId,
            sessionId,
            'deleteSession'
          );
        }
        await deleteSessionDocuments(sessionId);
        return;
      }

      const machineId = sessionMeta.machineId;
      const machineRoomId = getMachineRoomId(machineId);
      const machineMeta = (await runtime.repo.getDocMeta(machineRoomId))?.meta as
        | MachineLegacyMetaFields
        | undefined;
      const machineFlockHandle = await runtime.repo.openFlockDoc(
        getMachineFlockDocId(runtime.workspaceId, machineId)
      );
      const machineMetaForCleanup = {
        localProjects: {
          ...(machineMeta?.localProjects ?? {}),
          ...getMachineFlockLocalProjects(
            readMachineFlockRowsFromFlock(machineFlockHandle.flock, {
              families: ['localProject'],
            })
          ),
        },
      } satisfies Pick<MachineLegacyMetaFields, 'localProjects'>;
      const needToArchiveSessions = machineMeta?.needToArchiveSessions ?? {};
      const needToDeleteSessions = machineMeta?.needToDeleteSessions ?? {};
      const requestedAt = getServerNow();
      let nextNeedToArchiveSessions: typeof needToArchiveSessions | undefined;
      if (needToArchiveSessions[sessionId] !== undefined) {
        const { [sessionId]: _, ...rest } = needToArchiveSessions;
        nextNeedToArchiveSessions = rest;
      }

      const deleteCommand = buildMachineDeleteSessionCommand({
        session: sessionMeta,
        machineMeta: machineMetaForCleanup,
        requestedAt,
        existing: needToDeleteSessions[sessionId],
      });

      await deleteMachineFlockRowsBestEffort(
        runtime,
        machineId,
        [machineFlockKeys.archiveSessionCommand(sessionId)],
        'deleteSession'
      );
      await runtime.writer.upsertDocMeta(machineRoomId, {
        ...(nextNeedToArchiveSessions !== undefined
          ? { needToArchiveSessions: nextNeedToArchiveSessions }
          : {}),
        ...(deleteCommand
          ? {
              needToDeleteSessions: {
                ...needToDeleteSessions,
                [sessionId]: machineDeleteCommandToQueueItem(deleteCommand),
              },
            }
          : {}),
      } as unknown as RepoDocMetaPatch);
      if (deleteCommand) {
        await writeMachineFlockRowRequired(runtime, machineId, {
          key: machineFlockKeys.deleteSessionCommand(sessionId),
          value: deleteCommand,
        });
      }
      await deleteSessionDocuments(sessionId, { cleanupLaunchConfig: false });
    },
    [runtime, deleteSessionDocuments]
  );

  const deleteArchivedSession = useCallback(
    async (sessionId: SessionId) => {
      log('[session-delete] start', { sessionId });
      if (!runtime) throw new Error('Runtime not ready');
      const loadedMeta = (await runtime.repo.getDocMeta(getSessionRoomId(sessionId)))?.meta as
        | SessionMeta
        | undefined;
      if (!loadedMeta) throw new Error(`Session metadata missing for ${sessionId}`);
      const rootMeta = { ...loadedMeta, id: loadedMeta.id ?? sessionId };
      const lifecycleSessions = getSessionLifecycleMetas(sessionId, rootMeta);

      for (const session of lifecycleSessions.reverse()) {
        await deleteArchivedSessionMeta(session);
      }
      log('[session-delete] lifecycle deleted', { sessionId });
    },
    [runtime, getSessionLifecycleMetas, deleteArchivedSessionMeta]
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
