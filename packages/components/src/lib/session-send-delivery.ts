import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isSessionHistoryStatusAwaitingStart,
  normalizeSessionTurnInputConfig,
  type MachineId,
  type SessionHistory,
  type SessionId,
  type SessionMeta,
  type SessionTurnInputConfig,
} from '@lody/shared';
import debug from 'debug';
import type { WorkspaceRuntime } from '@/atoms/runtime';
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
  Partial<Pick<WorkspaceRuntime, 'isMachineRpcUnreachable'>>;

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
 * then activation, as local commits on the live document. Nothing here waits
 * for the network; the transports upload local commits.
 */
export async function writeUserTurn(
  runtime: SessionSendRuntime,
  send: UserTurnSend,
  signal?: AbortSignal
): Promise<void> {
  const { sessionId, entry } = send;
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
  throwIfSendAborted(signal);
  if (send.queue) await runtime.writer.enqueueSessionMessage(sessionId, send.queue);
  else await runtime.writer.appendSessionTurn(sessionId, entry);
  if (send.delivery.kind === 'dispatch') await activateUserTurn(runtime, sessionId, entry.id);
  await runtime.repo.flush();
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
  // Local history writes are the accept boundary; nudge the room upload
  // without holding the caller on it.
  void runtime.sendResources
    .withSessionStore(sessionId, (store, signal) => store.waitUntilSynced(signal))
    .catch((error: unknown) => {
      log('session doc sync after dispatch request failed for %s/%s: %o', sessionId, userTurnId, error);
    });
  const machineId = options?.machineId ?? (await readMachineId(runtime, sessionId));
  let rpc: Promise<boolean> = Promise.resolve(false);
  if (machineId && inputConfig && userId && timestamp) {
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
