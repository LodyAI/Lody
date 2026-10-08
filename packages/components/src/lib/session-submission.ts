import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import { acceptSessionUserTurn } from './session-send-admission';
import { dispatchUserTurn, steerUserTurn } from './session-send-delivery';
import type {
  SessionHistory,
  SessionHistoryInput,
  SessionId,
  SessionMeta,
  SessionToCreate,
  MachineId,
  SessionTurnInputConfig,
} from '@lody/shared';
import {
  getSessionRoomId,
  getServerNow,
  LEGACY_SESSION_HISTORY_BACKEND,
  normalizeSessionTurnInputConfig,
  type SessionHistoryBackendKind,
  SessionStatusFactory,
} from '@lody/shared';
import { v4 as uuidv4 } from 'uuid';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { resolveSessionCreateRepoFullName } from './session-repo';

export type CreateSessionResult = { sessionId: SessionId; sessionMeta: SessionMeta };
export type StartSessionResult = CreateSessionResult & { historyEntry: SessionHistory };

/** UI bindings supply observation/admission, not another history writer. */
export type SessionSubmissionPorts = {
  runtime: WorkspaceRuntime | null;
  /** Default backend for new sessions when the payload has no explicit choice. */
  defaultHistoryBackend?: SessionHistoryBackendKind;
  assertSessionCreateAllowed: (sessionId: SessionId) => void;
  recordWorkspaceActivity: (workspaceId: string | undefined) => void;
  publishSessionMeta: (roomId: string, meta: SessionMeta) => void;
  readSessionMeta: (sessionId: SessionId) => SessionMeta | undefined;
  recordChat: (
    meta: SessionMeta | undefined,
    sessionId: SessionId,
    first: boolean,
    items: SessionHistoryInput['items']
  ) => void;
  onRpcDelivered: (sessionId: SessionId, turnId: string) => void;
};

function buildSessionCreateResult(
  payload: SessionToCreate,
  defaultHistoryBackend: SessionHistoryBackendKind
): CreateSessionResult {
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
    // Backend selection is a creation policy, not caller-provided turn data.
    // The backend identity is persisted at creation and remains immutable for
    // the session lifetime. Existing sessions retain their stored backend.
    historyBackend: payload.historyBackend ?? defaultHistoryBackend,
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

/** Ordinary Promise boundary shared by all existing submission entry points. */
export function createSessionSubmission(ports: SessionSubmissionPorts) {
  const {
    runtime,
    defaultHistoryBackend = LEGACY_SESSION_HISTORY_BACKEND,
    assertSessionCreateAllowed,
    recordWorkspaceActivity,
    publishSessionMeta,
    readSessionMeta,
    recordChat,
    onRpcDelivered,
  } = ports;

  const createSession = async (payload: SessionToCreate): Promise<CreateSessionResult> => {
    if (!runtime) {
      throw new Error('Runtime not ready');
    }
    const { sessionId, sessionMeta } = buildSessionCreateResult(payload, defaultHistoryBackend);
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
    publishSessionMeta(sessionRoomId, sessionMeta);

    return { sessionId, sessionMeta };
  };

  const startSession = async (
    payload: SessionToCreate,
    history: Omit<SessionHistoryInput, 'id'>,
    attachments?: SessionAttachmentDraft[]
  ): Promise<StartSessionResult> => {
    if (!runtime) {
      throw new Error('Runtime not ready');
    }
    const { sessionId, sessionMeta } = buildSessionCreateResult(payload, defaultHistoryBackend);
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
    const accepted = await acceptSessionUserTurn(
      runtime,
      sessionId,
      historyEntry,
      { kind: 'dispatch' },
      sessionMeta,
      undefined,
      attachments
    );
    // A held creation shows through the local placeholder until it is written.
    if (accepted === 'written') publishSessionMeta(sessionRoomId, sessionMeta);
    recordChat(sessionMeta, sessionId, true, history.items);
    return { sessionId, sessionMeta, historyEntry };
  };

  const addSessionHistory = async (
    sessionId: SessionId,
    history: Omit<SessionHistoryInput, 'id'>,
    options?: {
      dispatch?: boolean;
      guideExpectedTurnId?: string;
      attachments?: SessionAttachmentDraft[];
      onAccepted?: () => void;
    }
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

    // User turns go through the shared admission (local write, or the
    // in-memory queue while attachments prepare); other roles append directly.
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
    if (entry.role === 'user') {
      await acceptSessionUserTurn(
        runtime,
        sessionId,
        entry,
        options?.guideExpectedTurnId
          ? { kind: 'guide', expectedTurnId: options.guideExpectedTurnId }
          : { kind: options?.dispatch ? 'dispatch' : 'history' },
        undefined,
        undefined,
        options?.attachments,
        options?.onAccepted
      );
    } else {
      await runtime.writer.appendSessionTurn(sessionId, entry, dispatch);
    }
    // session/chat fires once for every user message dispatched through Lody —
    // the session-creating turn AND every follow-up — so it tracks active-use
    // frequency, unlike session/start_success which only covers creation. This
    // is the single convergence point for both the chat-landing (new session)
    // and session-chat-interface (reply/queue/child) send paths.
    if (history.role === 'user') {
      const sessionMeta = readSessionMeta(sessionId);
      recordChat(sessionMeta, sessionId, false, history.items);
    }
    return entry;
  };

  const requestSessionDispatch = async (
    sessionId: SessionId,
    userTurnId: string,
    options?: { inputConfig?: SessionTurnInputConfig; machineId?: MachineId | null }
  ) => {
    if (!runtime) {
      throw new Error('Runtime not ready');
    }
    // A held send is written and dispatched by the pending queue.
    if (runtime.pendingSends?.has(userTurnId)) return;
    await dispatchUserTurn(runtime, sessionId, userTurnId, {
      ...options,
      onAccepted: () => onRpcDelivered(sessionId, userTurnId),
    });
  };

  const requestSessionSteer = async (
    sessionId: SessionId,
    expectedTurnId: string,
    userTurnId: string,
    options?: { machineId?: MachineId | null }
  ): Promise<boolean> => {
    if (!runtime) {
      throw new Error('Runtime not ready');
    }
    // A held guide is offered by the pending queue once it is written.
    if (runtime.pendingSends?.has(userTurnId)) return false;
    return steerUserTurn(runtime, sessionId, expectedTurnId, userTurnId, {
      machineId: options?.machineId,
      onApplied: () => onRpcDelivered(sessionId, userTurnId),
    });
  };

  return {
    createSession,
    startSession,
    addSessionHistory,
    requestSessionDispatch,
    requestSessionSteer,
  };
}
