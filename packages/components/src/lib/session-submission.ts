import { acceptSessionUserTurn } from './session-send-admission';
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
  isLoroRepoDocDeleted,
  normalizeSessionTurnInputConfig,
  SessionStatusFactory,
} from '@lody/shared';
import { v4 as uuidv4 } from 'uuid';
import debug from 'debug';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { resolveSessionCreateRepoFullName } from './session-repo';

const log = debug('lody:session-submission');

export type CreateSessionResult = { sessionId: SessionId; sessionMeta: SessionMeta };
export type StartSessionResult = CreateSessionResult & { historyEntry: SessionHistory };

/** UI bindings supply observation/admission, not another history writer. */
export type SessionSubmissionPorts = {
  runtime: WorkspaceRuntime | null;
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
 * Fire the `session/dispatch-turn` Machine RPC fast path for a user turn that
 * is (or is about to be) durable. Returns a promise resolving to whether the
 * machine accepted the offer, or null when the offer cannot be built. The RPC
 * only accelerates dispatch — the durable `latestUserMsgId` pointer write
 * remains recovery truth.
 */
function fireSessionDispatchTurnRpc(
  runtime: WorkspaceRuntime,
  onRpcDelivered: SessionSubmissionPorts['onRpcDelivered'],
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
        onRpcDelivered(sessionId, userTurnId);
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

/** Ordinary Promise boundary shared by all existing submission entry points. */
export function createSessionSubmission(ports: SessionSubmissionPorts) {
  const {
    runtime,
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
    publishSessionMeta(sessionRoomId, sessionMeta);

    return { sessionId, sessionMeta };
  };

  const startSession = async (
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
    await acceptSessionUserTurn(runtime, sessionId, historyEntry, { kind: 'dispatch' }, sessionMeta);
    publishSessionMeta(sessionRoomId, sessionMeta);
    recordChat(sessionMeta, sessionId, true, history.items);
    return { sessionId, sessionMeta, historyEntry };
  };

  const addSessionHistory = async (
    sessionId: SessionId,
    history: Omit<SessionHistoryInput, 'id'>,
    options?: { dispatch?: boolean; guideExpectedTurnId?: string }
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

    // Acceptance is the existing renderer writer boundary. Persistence and
    // independent delivery are introduced in the next layer of the stack.
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
      await acceptSessionUserTurn(runtime, sessionId, entry,
        options?.guideExpectedTurnId ? { kind: 'guide', expectedTurnId: options.guideExpectedTurnId } : { kind: options?.dispatch ? 'dispatch' : 'queue' });
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
    const saved = await runtime.sendJournal?.read(userTurnId);
    if (saved) {
      const active = await runtime.sendJournal!.activate(userTurnId, { kind: 'dispatch' });
      await runtime.sendJournal!.submit(sessionId);
      if (active) await runtime.sendJournal!.deliver(active);
      return;
    }
    const entry = await runtime.sendResources.withSessionStore(sessionId, async (sessionStore) => {
      const read = await sessionStore.sessionData.history.readTurn(userTurnId);
      return read.state === 'ready' && read.turn.role === 'user' ? read.turn : undefined;
    });
    const inputConfig = options?.inputConfig ?? normalizeSessionTurnInputConfig(entry?.inputConfig);
    const dispatchUserId = entry?.userId?.trim();
    let rpcAcceptedPromise: Promise<boolean> | null = null;
    const startDispatchTurnRpc = (machineId: MachineId | null | undefined): void => {
      // The durable pointer write below remains recovery truth.
      rpcAcceptedPromise = fireSessionDispatchTurnRpc(runtime, onRpcDelivered, {
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
    void runtime.sendResources
      .withSessionStore(sessionId, (sessionStore, signal) => sessionStore.waitUntilSynced(signal))
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
    const saved = await runtime.sendJournal?.read(userTurnId);
    if (saved) {
      const active = await runtime.sendJournal!.activate(userTurnId, { kind: 'guide', expectedTurnId });
      await runtime.sendJournal!.submit(sessionId);
      if (active) await runtime.sendJournal!.deliver(active);
      const completed = await runtime.sendJournal!.read(userTurnId);
      if (completed?.guideOffer === 'applied') {
        onRpcDelivered(sessionId, userTurnId);
        return true;
      }
      if (completed?.guideOffer === 'not-applied') return false;
      throw new Error('Guide outcome is uncertain; the original message is retained');
    }
    const entry = await runtime.sendResources.withSessionStore(sessionId, async (sessionStore) => {
      const read = await sessionStore.sessionData.history.readTurn(userTurnId);
      return read.state === 'ready' && read.turn.role === 'user' ? read.turn : undefined;
    });
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
    const steerRequest = {
      sessionId,
      expectedTurnId,
      userTurnId,
      userId,
      timestamp: entry.timestamp,
      inputConfig,
    };
    let response = await runtime.requestSessionSteer(machineId, steerRequest);
    if (response?.recoveryOwned && response.disposition === 'promotion-failed') {
      // The CLI owns recovery for this verdict. Retry through that same owner;
      // a renderer-side promotion could overwrite a newer activation pointer.
      response = await runtime.requestSessionSteer(machineId, steerRequest);
      if (
        !response ||
        response.disposition === 'promotion-failed' ||
        response.disposition === 'error'
      ) {
        throw new Error(response?.error ?? 'Could not recover the undelivered guidance');
      }
    }
    if (response?.applied) {
      onRpcDelivered(sessionId, userTurnId);
      return true;
    }
    if (
      !response?.recoveryOwned &&
      (response?.disposition === 'no-active-turn' ||
        response?.disposition === 'promotion-failed')
    ) {
      // The CLI proved the steer was not applied, either before submission
      // or from the adapter's final verdict. Reuse the same user turn as an
      // ordinary follow-up. `delivery-unknown` and every other result stay
      // pending_apply because replay could deliver the input twice.
      // Re-acquire the store for the write: the steer RPC above can run long,
      // and we must not hold a store ref across it.
      const promoted = await runtime.sendResources.withSessionStore(
        sessionId,
        async (sessionStore) => {
          const changed =
            (
            await sessionStore.sessionData.commands.applyHistoryAction({
              kind: 'user-status',
              turnId: userTurnId,
              status: 'pending',
              onlyPendingApply: true,
            })
            ).matched ?? false;
          if (changed) return true;
          // CLI promotion can write history before its activation pointer
          // fails. Auto-seen may also have observed that pending entry.
          const read = await sessionStore.sessionData.history.readTurn(userTurnId);
          return (
            read.state === 'ready' &&
            read.turn.role === 'user' &&
            (read.turn.status === 'pending' || read.turn.status === 'seen')
          );
        }
      );
      // Pending promotion is repairable; a started, terminal, or removed turn is not.
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
      response ? `${response.disposition}${response.error ? `: ${response.error}` : ''}` : 'timeout'
    );
    throw new Error('Guide outcome is uncertain; the original message is retained');
  };

  return {
    createSession,
    startSession,
    addSessionHistory,
    requestSessionDispatch,
    requestSessionSteer,
  };
}
