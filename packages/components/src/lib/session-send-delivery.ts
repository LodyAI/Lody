import {
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isSessionHistoryStatusAwaitingStart,
  isSessionHistoryPendingForDispatch,
  normalizeSessionTurnInputConfig,
  queuedInputEvidence,
  type MachineId,
  type MessageQueueItem,
  type SessionHistory,
  type SessionId,
  type SessionMeta,
  type SessionTurnInputConfig,
} from '@lody/shared';
import debug from 'debug';
import i18next from 'i18next';
import { v4 as uuidv4 } from 'uuid';
import type { SessionDocDraft, WorkspaceRuntime } from '@/atoms/runtime';
import { QueueSignalError, SessionInputNotSentError } from './session-accepted-inputs';
import {
  EncryptedPrepareTimeout,
  isKnownMachineWithdrawal,
  type PreparedEncryptedDispatch,
} from './encrypted-dispatch-outcome';
import { throwIfSendAborted } from './session-send-resources';

const log = debug('lody:session-send');

/**
 * What happens after the local write. `history` only appends; `queue` writes a
 * message-queue row instead; `dispatch` also activates the turn; `guide` offers
 * the `pending_apply` turn to the running assistant turn.
 */
export type SessionSendDelivery =
  | { kind: 'history' }
  | { kind: 'queue' }
  | { kind: 'dispatch' }
  | { kind: 'guide'; expectedTurnId: string };

export type UserTurnSend = {
  sessionId: SessionId;
  /** `entry.id` is the user turn id; queue rows carry it as `userTurnId`. */
  entry: SessionHistory;
  delivery: SessionSendDelivery;
  /** New conversation metadata, written before the first turn. */
  creation?: SessionMeta;
  /** A message-queue row; written instead of a history turn. */
  queue?: Record<string, unknown>;
};

export type SessionSendRuntime = Pick<
  WorkspaceRuntime,
  'repo' | 'writer' | 'sendResources' | 'requestSessionDispatchTurn' | 'requestSessionSteer'
> &
  Partial<
    Pick<
      WorkspaceRuntime,
      'isMachineRpcUnreachable' | 'contentMode' | 'prepareEncryptedDispatch' | 'attachmentToken'
    >
  >;

/** Trusted human-send provenance, committed before history or queue activation. */
export async function persistHumanInputReceipt(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  entry: Pick<SessionHistory, 'id' | 'userId'>,
  signal?: AbortSignal
): Promise<void> {
  const userId = entry.userId?.trim();
  if (!userId) throw new Error('Human input requires an explicit user identity');
  await runtime.sendResources.withSessionStore(
    sessionId,
    (store) => {
      if (store.getState().humanInputReceipts?.[entry.id]?.userId === userId) return;
      store.setState((draft: SessionDocDraft) => {
        draft.humanInputReceipts ??= {};
        draft.humanInputReceipts[entry.id] = { userId };
      });
    },
    signal
  );
}

/**
 * Point the CLI's activation watermark at this turn unless a later local user
 * turn already owns it. The CLI dispatches pending/seen user turns from synced
 * history; this pointer only wakes its watcher.
 */
export async function activateUserTurn(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  turnId: string
): Promise<void> {
  const roomId = getSessionRoomId(sessionId);
  const found = await runtime.repo.getDocMeta(roomId);
  const meta = found?.meta as SessionMeta | undefined;
  // Archived conversations keep their history but never launch work.
  if (isLoroRepoDocDeleted(found) || meta?.isArchived) return;
  const latest = meta?.latestUserMsgId;
  if (latest === turnId) return;
  if (latest) {
    const newer = await runtime.sendResources.withSessionStore(sessionId, async (store) => {
      const rows = await store.sessionData.history.readDirectory(
        0,
        await store.sessionData.history.count()
      );
      return (
        rows.findIndex((row) => row.turnId === latest) >
        rows.findIndex((row) => row.turnId === turnId)
      );
    });
    if (newer) return;
  }
  await runtime.writer.upsertDocMeta(roomId, { latestUserMsgId: turnId } as Partial<SessionMeta>);
}

/**
 * The local accept boundary: creation metadata, then the turn (or queue row),
 * then activation, as local commits on the live document. Repo persistence and
 * transport upload run independently; unrelated dirty documents must not delay dispatch.
 */
export async function writeUserTurn(
  runtime: SessionSendRuntime,
  send: UserTurnSend,
  signal?: AbortSignal
): Promise<void> {
  // The machine writes a promoted row, so a queued input carries its own signed original.
  const queuedOriginal =
    send.queue && runtime.contentMode === 'e2ee'
      ? await prepareQueuedOriginal(runtime, send.sessionId, {
          ...send.entry,
          machineId: send.creation?.machineId as MachineId | undefined,
          signal,
        })
      : undefined;
  const late = queuedOriginal ? undefined : (await refuseKnownWithdrawnTarget(runtime, send))?.late;
  await prepareUserTurnWrite(runtime, send, signal);
  await persistHumanInputReceipt(runtime, send.sessionId, send.entry, signal);
  throwIfSendAborted(signal);
  if (queuedOriginal) {
    await storeQueuedOriginal(runtime, send.sessionId, send.entry.id, queuedOriginal);
    try {
      await runtime.writer.enqueueSessionMessage(send.sessionId, send.queue!);
    } catch (error) {
      // A committed row can run, so a failed signal still means the send happened.
      if (!(error instanceof QueueSignalError)) {
        await releaseQueuedOriginal(runtime, send.sessionId, send.entry.id);
        throw error;
      }
      log('queue signal failed after %s/%s was written: %o', send.sessionId, send.entry.id, error);
    }
    // No abort check follows: from here the row exists, so the send cannot be reported as stopped.
  } else if (send.queue) await runtime.writer.enqueueSessionMessage(send.sessionId, send.queue);
  else await runtime.writer.appendSessionTurn(send.sessionId, send.entry);
  if (late && !send.queue) settleOnLateWithdrawal(runtime, send, late);
  if (send.delivery.kind === 'dispatch')
    await activateUserTurn(runtime, send.sessionId, send.entry.id);
}

/** How long a queued send waits for its original past the shared preparation deadline. */
export const QUEUED_ORIGINAL_DEADLINE_MS = 10_000;

async function awaitQueuedOriginal(
  prepare: Promise<PreparedEncryptedDispatch>,
  signal?: AbortSignal
): Promise<PreparedEncryptedDispatch> {
  const answer = prepare.catch((error: unknown) => {
    if (error instanceof EncryptedPrepareTimeout) return error.late;
    throw error;
  });
  // A late answer stays observed after this send stops waiting; a retry reuses the original.
  answer.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('e2ee_rpc_prepare_timeout')),
      QUEUED_ORIGINAL_DEADLINE_MS
    );
    onAbort = () => reject(new Error('e2ee_rpc_prepare_aborted'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([answer, stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** A queue row with no original cannot start, so an unsigned input is not sent at all. */
async function prepareQueuedOriginal(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  input: Pick<SessionHistory, 'id' | 'userId' | 'timestamp' | 'inputConfig'> & {
    machineId?: MachineId;
    signal?: AbortSignal;
  }
): Promise<string> {
  const notSent = (key: string) => new SessionInputNotSentError(i18next.t(key));
  const inputConfig = normalizeSessionTurnInputConfig(input.inputConfig);
  const userId = input.userId?.trim();
  const machineId = input.machineId ?? (await readMachineId(runtime, sessionId));
  if (!runtime.prepareEncryptedDispatch || !machineId || !inputConfig || !userId)
    throw notSent('sessions.sendError');
  if (!input.timestamp) throw notSent('sessions.sendError');
  try {
    const prepared = await awaitQueuedOriginal(
      runtime.prepareEncryptedDispatch(machineId, {
        sessionId,
        userTurnId: input.id,
        userId,
        timestamp: input.timestamp,
        inputConfig,
      }),
      input.signal
    );
    return prepared.original.frameHex;
  } catch (error) {
    throw notSent(
      isKnownMachineWithdrawal(error) ? 'e2ee.machineSharing.issue.notShared' : 'sessions.sendError'
    );
  }
}

async function storeQueuedOriginal(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  userTurnId: string,
  frameHex: string
) {
  await runtime.sendResources.withSessionStore(sessionId, (store) => {
    store.setState((draft: SessionDocDraft) => {
      const existing = draft.queueDispatchOriginals?.[userTurnId];
      if (existing !== undefined && existing !== frameHex)
        throw new Error('e2ee_rpc_original_conflict');
      draft.queueDispatchOriginals ??= {};
      draft.queueDispatchOriginals[userTurnId] = frameHex;
    });
  });
}

/** Drops a Turn's original once no queue row or history row in this replica uses it. */
export async function removeQueuedOriginal(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  userTurnId: string
) {
  if (runtime.contentMode !== 'e2ee') return;
  await runtime.sendResources.withSessionStore(sessionId, async (store) => {
    const state = store.getState();
    if (state.queueDispatchOriginals?.[userTurnId] === undefined) return;
    if ((state.mq ?? []).some((item) => item.userTurnId === userTurnId)) return;
    if ((await store.sessionData.history.readTurn(userTurnId)).state === 'ready') return;
    store.setState((draft: SessionDocDraft) => {
      if (draft.queueDispatchOriginals) delete draft.queueDispatchOriginals[userTurnId];
    });
  });
}

/** Cleanup after a failed or finished write must not replace that write's own outcome. */
async function releaseQueuedOriginal(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  userTurnId: string
) {
  await removeQueuedOriginal(runtime, sessionId, userTurnId).catch((error: unknown) => {
    log('queued original cleanup failed for %s/%s: %o', sessionId, userTurnId, error);
  });
}

/** Writes a queue edit; each original's cleanup follows what the row ends up naming. */
export async function replaceQueueItem(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  cid: string,
  current: MessageQueueItem,
  next: MessageQueueItem
): Promise<void> {
  const sealed = await sealEditedQueueItem(runtime, sessionId, current, next);
  try {
    await runtime.writer.updateSessionMessage(
      sessionId,
      cid,
      sealed as unknown as Record<string, unknown>
    );
  } finally {
    if (sealed.userTurnId !== current.userTurnId) {
      if (sealed.userTurnId) await releaseQueuedOriginal(runtime, sessionId, sealed.userTurnId);
      if (current.userTurnId) await releaseQueuedOriginal(runtime, sessionId, current.userTurnId);
    }
  }
}

/**
 * Originals are immutable per Turn, so an encrypted edit that changes the input
 * becomes a new Turn with its own original. Editing flags keep the row's identity.
 */
export async function sealEditedQueueItem(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  current: MessageQueueItem,
  next: MessageQueueItem
): Promise<MessageQueueItem> {
  if (
    runtime.contentMode !== 'e2ee' ||
    queuedInputEvidence(current.acpSessionConfig) === queuedInputEvidence(next.acpSessionConfig)
  )
    return next;
  const userTurnId = uuidv4();
  const timestamp = new Date(getServerNow()).toISOString();
  const frameHex = await prepareQueuedOriginal(runtime, sessionId, {
    id: userTurnId,
    userId: next.userId,
    timestamp,
    inputConfig: next.acpSessionConfig as SessionHistory['inputConfig'],
  });
  await persistHumanInputReceipt(runtime, sessionId, { id: userTurnId, userId: next.userId });
  await storeQueuedOriginal(runtime, sessionId, userTurnId, frameHex);
  return { ...next, userTurnId, operationId: `queue:${userTurnId}`, timestamp };
}

/**
 * A withdrawal verified after the deadline cancels the written turn while every copy
 * still awaits a start; a machine that already claimed it keeps its own decision.
 */
function settleOnLateWithdrawal(
  runtime: SessionSendRuntime,
  send: UserTurnSend,
  late: Promise<unknown>
) {
  void late.then(
    () => undefined,
    async (error: unknown) => {
      if (!isKnownMachineWithdrawal(error)) return;
      try {
        await runtime.sendResources.withSessionStore(send.sessionId, (store) =>
          store.sessionData.commands.applyHistoryAction({
            kind: 'user-status',
            turnId: send.entry.id,
            status: 'canceled',
            onlyAwaitingStart: true,
          })
        );
      } catch (cause) {
        log('late withdrawal could not settle %s/%s: %o', send.sessionId, send.entry.id, cause);
      }
    }
  );
}

/**
 * Encrypted machines also start pending input discovered in synced history, so a
 * withdrawal this host has already verified must refuse the send before anything
 * is written. Every other preparation outcome is unknown here: the input is written
 * and the receiving machine still authorizes it.
 */
async function refuseKnownWithdrawnTarget(
  runtime: SessionSendRuntime,
  send: UserTurnSend
): Promise<{ late: Promise<unknown> } | undefined> {
  if (runtime.contentMode !== 'e2ee' || !runtime.prepareEncryptedDispatch) return undefined;
  const inputConfig = normalizeSessionTurnInputConfig(send.entry.inputConfig);
  const userId = send.entry.userId?.trim();
  const machineId =
    (send.creation?.machineId as MachineId | undefined) ??
    (await readMachineId(runtime, send.sessionId));
  if (!machineId || !inputConfig || !userId || !send.entry.timestamp) return undefined;
  try {
    await runtime.prepareEncryptedDispatch(machineId, {
      sessionId: send.sessionId,
      userTurnId: send.entry.id,
      userId,
      timestamp: send.entry.timestamp,
      inputConfig,
    });
  } catch (error) {
    if (isKnownMachineWithdrawal(error))
      throw new SessionInputNotSentError(i18next.t('e2ee.machineSharing.issue.notShared'));
    // Wrapped: an async function would otherwise wait for the late answer.
    if (error instanceof EncryptedPrepareTimeout) return { late: error.late };
  }
  return undefined;
}

/** Only local control metadata; this does not write history or start execution. */
export async function prepareUserTurnWrite(
  runtime: SessionSendRuntime,
  send: UserTurnSend,
  signal?: AbortSignal
): Promise<void> {
  const { sessionId } = send;
  const roomId = getSessionRoomId(sessionId);
  const found = await runtime.repo.getDocMeta(roomId);
  if (isLoroRepoDocDeleted(found)) throw new Error('Target conversation was deleted');
  const meta = found?.meta as SessionMeta | undefined;
  throwIfSendAborted(signal);
  if (send.creation) {
    // Target routing resolves the owning machine from this metadata, so it
    // precedes the turn. Only absent fields are written; later edits win.
    const patch = Object.fromEntries(
      Object.entries(send.creation).filter(([key]) => !meta || !(key in meta))
    );
    if (Object.keys(patch).length) await runtime.writer.upsertDocMeta(roomId, patch);
  } else if (!meta?.id) {
    throw new Error('Target conversation is no longer available');
  }
}

async function readUserTurn(runtime: SessionSendRuntime, sessionId: SessionId, turnId: string) {
  return runtime.sendResources.withSessionStore(sessionId, async (store) => {
    const read = await store.sessionData.history.readTurn(turnId);
    return read.state === 'ready' && read.turn.role === 'user' ? read.turn : undefined;
  });
}

async function readMachineId(runtime: SessionSendRuntime, sessionId: SessionId) {
  const existing = await runtime.repo.getDocMeta(getSessionRoomId(sessionId));
  if (isLoroRepoDocDeleted(existing)) return null;
  return ((existing?.meta as SessionMeta | undefined)?.machineId as MachineId | undefined) ?? null;
}

/**
 * Best-effort `session/dispatch-turn` fast path for a locally written turn.
 * The persisted turn and activation pointer are what the CLI dispatches from;
 * an RPC failure is logged, never a send failure.
 */
export async function dispatchUserTurn(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  userTurnId: string,
  options?: {
    inputConfig?: SessionTurnInputConfig;
    machineId?: MachineId | null;
    onAccepted?: () => void;
  }
): Promise<void> {
  const entry = await readUserTurn(runtime, sessionId, userTurnId);
  const inputConfig = options?.inputConfig ?? normalizeSessionTurnInputConfig(entry?.inputConfig);
  const userId = entry?.userId?.trim();
  const timestamp = entry?.timestamp;
  if (userId) await persistHumanInputReceipt(runtime, sessionId, { id: userTurnId, userId });
  // Local history writes are the accept boundary; nudge the room upload
  // without holding the caller on it.
  void runtime.sendResources
    .withSessionStore(sessionId, (store, signal) => store.waitUntilSynced(signal))
    .catch((error: unknown) => {
      log(
        'session doc sync after dispatch request failed for %s/%s: %o',
        sessionId,
        userTurnId,
        error
      );
    });
  const machineId = options?.machineId ?? (await readMachineId(runtime, sessionId));
  let rpc: Promise<boolean> = Promise.resolve(false);
  if (
    runtime.contentMode === 'e2ee' &&
    runtime.prepareEncryptedDispatch &&
    machineId &&
    inputConfig &&
    userId &&
    timestamp
  ) {
    const store = (prepared: PreparedEncryptedDispatch) =>
      runtime.sendResources.withSessionStore(sessionId, (store) => {
        store.setState((draft: SessionDocDraft) => {
          const existing = draft.rpcDispatchOriginals?.[userTurnId];
          if (existing !== undefined && existing !== prepared.original.frameHex)
            throw new Error('e2ee_rpc_original_conflict');
          draft.rpcDispatchOriginals ??= {};
          draft.rpcDispatchOriginals[userTurnId] = prepared.original.frameHex;
        });
      });
    const send = (prepared: PreparedEncryptedDispatch) =>
      prepared.send().then(
        (response) => {
          if (response?.accepted) options?.onAccepted?.();
          return response?.accepted ?? false;
        },
        () => false
      );
    const unavailable = () => {
      log('Encrypted dispatch acceleration unavailable for %s/%s', sessionId, userTurnId);
      return false;
    };
    try {
      const prepared = await runtime.prepareEncryptedDispatch(machineId, {
        sessionId,
        userTurnId,
        userId,
        timestamp,
        inputConfig,
      });
      await store(prepared);
      rpc = send(prepared);
    } catch (error) {
      // Preparation/storage failure cannot remove or delay durable activation. A host
      // that answers after the deadline still accelerates the activated turn.
      rpc =
        error instanceof EncryptedPrepareTimeout
          ? error.late
              .then(async (prepared) => {
                const current = await readUserTurn(runtime, sessionId, userTurnId);
                if (!isSessionHistoryPendingForDispatch(current)) return false;
                await store(prepared);
                // Durable activation may already be processing; it is still dispatchable.
                // The receiver deduplicates this turn id. Recheck after storage yields
                // so cancellation or terminal completion still stops the late send.
                const latest = await readUserTurn(runtime, sessionId, userTurnId);
                if (!isSessionHistoryPendingForDispatch(latest)) return false;
                return send(prepared);
              })
              .catch(unavailable)
          : Promise.resolve(unavailable());
    }
  }
  if (runtime.contentMode !== 'e2ee' && machineId && inputConfig && userId && timestamp) {
    const rpcArgs = { sessionId, userTurnId, userId, timestamp, inputConfig };
    // Attachments ride as references, so payloads are normally small; skip the
    // fast path for pathological sizes rather than risk an oversized append.
    let oversized = true;
    try {
      oversized = JSON.stringify(rpcArgs).length > 256 * 1024;
    } catch {
      /* unserializable input stays on the synced path */
    }
    if (!oversized)
      rpc = runtime.requestSessionDispatchTurn(machineId, rpcArgs).then(
        (response) => {
          if (response?.accepted) {
            options?.onAccepted?.();
            return true;
          }
          log(
            'dispatch-turn rpc not accepted for %s/%s: %s',
            sessionId,
            userTurnId,
            response
              ? `${response.disposition}${response.error ? `: ${response.error}` : ''}`
              : 'timeout'
          );
          return false;
        },
        (error: unknown) => {
          log('dispatch-turn rpc threw for %s/%s: %o', sessionId, userTurnId, error);
          return false;
        }
      );
  }
  try {
    await activateUserTurn(runtime, sessionId, userTurnId);
  } catch (error) {
    // A turn the fast path already delivered is running; reporting a failed
    // send would invite a duplicate resend.
    if (!(await rpc)) throw error;
    console.warn('Activation write failed after dispatch fast-path delivery', {
      sessionId,
      userTurnId,
      error,
    });
  }
  await rpc;
}

/** Turn a guide the daemon provably never applied into an ordinary follow-up. */
async function promoteGuideToFollowUp(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  userTurnId: string,
  options: { inputConfig: SessionTurnInputConfig; machineId: MachineId }
): Promise<void> {
  const promoted = await runtime.sendResources.withSessionStore(sessionId, async (store) => {
    const changed =
      (
        await store.sessionData.commands.applyHistoryAction({
          kind: 'user-status',
          turnId: userTurnId,
          status: 'pending',
          onlyPendingApply: true,
        })
      ).matched ?? false;
    if (changed) return true;
    // The CLI may already have promoted it; auto-read can mark that `seen`.
    const read = await store.sessionData.history.readTurn(userTurnId);
    return (
      read.state === 'ready' &&
      read.turn.role === 'user' &&
      isSessionHistoryStatusAwaitingStart(read.turn.status)
    );
  });
  // A started, terminal or removed turn is not repairable.
  if (!promoted) return;
  await dispatchUserTurn(runtime, sessionId, userTurnId, options);
  await runtime.repo.flush();
}

/**
 * Offer a locally written `pending_apply` turn to the running assistant turn.
 * Resolves whether the daemon applied it. Only proven non-delivery turns it
 * into a follow-up; an uncertain answer leaves the turn alone, because a
 * replay could run the input twice.
 */
export async function steerUserTurn(
  runtime: SessionSendRuntime,
  sessionId: SessionId,
  expectedTurnId: string,
  userTurnId: string,
  options?: { machineId?: MachineId | null; onApplied?: () => void }
): Promise<boolean> {
  const entry = await readUserTurn(runtime, sessionId, userTurnId);
  const inputConfig = normalizeSessionTurnInputConfig(entry?.inputConfig);
  const userId = entry?.userId?.trim();
  const machineId = options?.machineId ?? (await readMachineId(runtime, sessionId));
  if (!entry || !inputConfig || !userId || !machineId) return false;
  if (runtime.isMachineRpcUnreachable?.(machineId)) {
    // The request is never sent, so it provably cannot have been applied.
    await promoteGuideToFollowUp(runtime, sessionId, userTurnId, { inputConfig, machineId });
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
    await runtime.sendResources.withSessionStore(sessionId, (store) =>
      store.sessionData.commands.applyHistoryAction({
        kind: 'user-status',
        turnId: userTurnId,
        status: 'processing',
        deliveredSteer: true,
        onlyPendingApply: true,
      })
    );
    options?.onApplied?.();
    return true;
  }
  if (
    !response?.recoveryOwned &&
    (response?.disposition === 'no-active-turn' || response?.disposition === 'promotion-failed')
  ) {
    await promoteGuideToFollowUp(runtime, sessionId, userTurnId, { inputConfig, machineId });
    log('steer became an ordinary follow-up for %s/%s', sessionId, userTurnId);
    return false;
  }
  // `recoveryOwned`: the daemon requeues or settles the turn itself. Anything
  // else (delivery-unknown, timeout, transport error) is uncertain: leave the
  // turn as the daemon last wrote it.
  if (!response?.recoveryOwned)
    console.warn('Guide outcome is uncertain; the turn is left as written', {
      sessionId,
      userTurnId,
      disposition: response?.disposition ?? 'timeout',
    });
  return false;
}

/** Delivery for a send that was held in memory until its attachments were ready. */
export async function deliverUserTurn(
  runtime: SessionSendRuntime,
  send: UserTurnSend & { targetMachineId?: MachineId | null }
): Promise<void> {
  if (send.delivery.kind === 'dispatch') {
    await dispatchUserTurn(runtime, send.sessionId, send.entry.id, {
      machineId: send.targetMachineId ?? null,
    });
  } else if (send.delivery.kind === 'guide') {
    await steerUserTurn(runtime, send.sessionId, send.delivery.expectedTurnId, send.entry.id, {
      machineId: send.targetMachineId ?? null,
    });
  }
}
