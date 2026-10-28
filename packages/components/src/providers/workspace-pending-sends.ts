import {
  getMachineRoomId,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isSessionHistoryStatusAwaitingStart,
  machineSupportsSessionInputAcceptance,
  machineSupportsSessionInputDispatch,
  type MachineId,
  type MachineMeta,
  type SessionMeta,
  type SessionId,
} from '@lody/shared';
import i18next from 'i18next';
import { prepareDraftAttachments } from '../lib/session-attachment-preparation';
import { createPendingSessionSends, type PendingSessionSend } from '../lib/session-pending-sends';
import {
  createAcceptedSessionInputs,
  SessionInputNotSentError,
} from '../lib/session-accepted-inputs';
import { createSessionInputStorage } from '../lib/session-input-storage';
import { encryptedLocalInstance, type E2eeLocalDataIdentity } from '../lib/e2ee-local-data';
import { recordClientLog } from '../lib/client-log';
import {
  deliverUserTurn,
  writeUserTurn,
  prepareUserTurnWrite,
  persistHumanInputReceipt,
  type SessionSendRuntime,
} from '../lib/session-send-delivery';
import { throwIfSendAborted } from '../lib/session-send-resources';

/** One workspace projection over held attachments and locally accepted ready input. */
export function createWorkspacePendingSends(args: {
  runtime: SessionSendRuntime;
  accountId: string;
  workspaceId: string;
  localIdentity?: E2eeLocalDataIdentity;
  paused?: boolean;
  token(): string | null;
  localMachineId(): MachineId | null;
  onDelivered?(sessionId: SessionId, turnId: string): void;
}) {
  const { runtime } = args;
  if (runtime.contentMode === 'e2ee' && !args.localIdentity)
    throw new Error('e2ee_local_identity_required');
  const scope = args.localIdentity
    ? encryptedLocalInstance(args.localIdentity)
    : JSON.stringify([args.accountId, args.workspaceId]);
  const channel =
    typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel(`lody-session-inputs:${scope}`);
  const validateTarget = async (send: PendingSessionSend) => {
    const found = await runtime.repo.getDocMeta(getSessionRoomId(send.sessionId));
    const meta = found?.meta as SessionMeta | undefined;
    if (isLoroRepoDocDeleted(found) || meta?.isArchived)
      throw new SessionInputNotSentError(i18next.t('sessions.inputTargetUnavailable'));
    const target = meta?.machineId ?? send.creation?.machineId;
    const backend = meta?.historyBackend ?? send.creation?.historyBackend;
    if (!send.targetMachineId || target !== send.targetMachineId || backend !== 'roost') {
      throw new SessionInputNotSentError(i18next.t('sessions.inputTargetChanged'));
    }
    const machine = await runtime.repo.getDocMeta(getMachineRoomId(send.targetMachineId));
    if (
      !machineSupportsSessionInputAcceptance(machine?.meta as MachineMeta | undefined) ||
      (send.delivery.kind === 'dispatch' &&
        !machineSupportsSessionInputDispatch(machine?.meta as MachineMeta | undefined))
    ) {
      throw new SessionInputNotSentError(i18next.t('sessions.inputOwnerNeedsUpdate'));
    }
  };
  const inputOwner = createAcceptedSessionInputs({
    resources: runtime.sendResources,
    storage: createSessionInputStorage(
      args.accountId,
      args.workspaceId,
      undefined,
      args.localIdentity
    ),
    paused: args.paused,
    lock: async <T>(
      sessionId: import('@lody/shared').SessionId,
      signal: AbortSignal,
      work: () => Promise<T>
    ): Promise<T> => {
      if (!navigator.locks)
        return Promise.reject(
          new SessionInputNotSentError(i18next.t('sessions.inputStorageUnavailable'))
        );
      return navigator.locks.request(`lody-session-input:${scope}:${sessionId}`, { signal }, work);
    },
    write: async (send, signal) => {
      await validateTarget(send);
      await prepareUserTurnWrite(runtime, send, signal);
      await persistHumanInputReceipt(runtime, send.sessionId, send.entry, signal);
      throwIfSendAborted(signal);
      return runtime.sendResources.withSessionStore(
        send.sessionId,
        async (store) => {
          if (!store.sessionData.inputAcceptance)
            throw new SessionInputNotSentError(i18next.t('sessions.inputOwnerNeedsUpdate'));
          await validateTarget(send);
          if (store.sessionData.inputAcceptance.targetMachineId !== send.targetMachineId)
            throw new SessionInputNotSentError(i18next.t('sessions.inputTargetChanged'));
          throwIfSendAborted(signal);
          if (send.delivery.kind === 'dispatch') {
            const accept = store.sessionData.inputAcceptance.acceptAndDispatch;
            if (!accept)
              throw new SessionInputNotSentError(i18next.t('sessions.inputOwnerNeedsUpdate'));
            return {
              ...(await accept.call(store.sessionData.inputAcceptance, send.entry)),
              dispatchHandled: true,
            };
          }
          return store.sessionData.inputAcceptance.accept(send.entry);
        },
        signal
      );
    },
    lookup: async (send, signal) => {
      await validateTarget(send);
      return runtime.sendResources.withSessionStore(
        send.sessionId,
        async (store) => {
          if (!store.sessionData.inputAcceptance)
            throw new SessionInputNotSentError(i18next.t('sessions.inputOwnerNeedsUpdate'));
          await validateTarget(send);
          if (store.sessionData.inputAcceptance.targetMachineId !== send.targetMachineId)
            throw new SessionInputNotSentError(i18next.t('sessions.inputTargetChanged'));
          throwIfSendAborted(signal);
          return store.sessionData.inputAcceptance.lookup(send.entry);
        },
        signal
      );
    },
    confirmed: (send) => {
      if (send.delivery.kind !== 'guide') args.onDelivered?.(send.sessionId, send.id);
    },
    deliver: async (send, signal, receipt) => {
      if (send.delivery.kind === 'dispatch' && receipt.dispatchHandled) return undefined;
      await validateTarget(send);
      throwIfSendAborted(signal);
      if (send.delivery.kind === 'dispatch') {
        return runtime.sendResources.withSessionStore(
          send.sessionId,
          (store) => {
            const port = store.sessionData.inputAcceptance;
            if (!port?.acceptAndDispatch || port.targetMachineId !== send.targetMachineId)
              throw new SessionInputNotSentError(i18next.t('sessions.inputOwnerNeedsUpdate'));
            return port.acceptAndDispatch(send.entry);
          },
          signal
        );
      }
      const current = await runtime.sendResources.withSessionStore(
        send.sessionId,
        (store) => store.sessionData.history.readTurn(send.id),
        signal
      );
      if (current.state !== 'ready') {
        if (current.state === 'missing') return undefined;
        throw new Error('Accepted Roost input history is not readable');
      }
      if (
        !isSessionHistoryStatusAwaitingStart(current.turn.status) &&
        send.delivery.kind !== 'guide'
      )
        return undefined;
      throwIfSendAborted(signal);
      await deliverUserTurn(runtime, send);
      return undefined;
    },
    visible: (send, signal) =>
      runtime.sendResources.withSessionStore(
        send.sessionId,
        (store) => {
          const index = store.history.indexOf(send.id);
          return index >= 0 && store.history.turn(index) !== undefined;
        },
        signal
      ),
    unknownMessage: () => i18next.t('sessions.inputOutcomeUnknown'),
    changed: () => channel?.postMessage('changed'),
    diagnose: (level, event, details) => recordClientLog(level, event, undefined, details),
  });
  const barriers = new Map<string, Promise<readonly string[]>>();
  const admissionOrder = new Map<string, number>();
  let nextAdmission = 0;
  const held = createPendingSessionSends({
    prepare: (send, signal, update) => {
      let attachments = send.attachments;
      const publish = (next: typeof attachments) => {
        attachments = next;
        update(next);
      };
      return prepareDraftAttachments({
        content: { mode: runtime.contentMode === 'e2ee' ? 'protected' : 'plaintext' },
        record: send,
        signal,
        resources: runtime.sendResources,
        token: args.token,
        localMachineId: args.localMachineId,
        update: publish,
        report: (id, progress) =>
          publish(
            attachments.map((attachment) =>
              attachment.id === id ? { ...attachment, progress } : attachment
            )
          ),
      });
    },
    write: (send, signal) =>
      runtime.sendResources.run(async (owned) => {
        if (send.historyBackend !== 'roost') return writeUserTurn(runtime, send, owned);
        const predecessors = (await barriers.get(send.id)) ?? [];
        if (!send.queue) {
          throwIfSendAborted(owned);
          if (!inputOwner.getSnapshot().some((input) => input.id === send.id))
            inputOwner.enqueue(send);
          return inputOwner.afterInputs(
            send.sessionId,
            [...predecessors, send.id],
            owned,
            async () => {}
          );
        }
        return inputOwner.afterInputs(send.sessionId, predecessors, owned, () =>
          writeUserTurn(runtime, send, owned)
        );
      }, signal),
    deliver: (send) =>
      send.historyBackend === 'roost' && !send.queue
        ? Promise.resolve()
        : deliverUserTurn(runtime, send),
  });
  let snapshot: readonly PendingSessionSend[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    const merged = [
      ...new Map(
        [...held.getSnapshot(), ...inputOwner.getSnapshot()].map((send) => [send.id, send])
      ).values(),
    ];
    const live = new Set(merged.map((send) => send.id));
    for (const id of admissionOrder.keys())
      if (!live.has(id)) {
        admissionOrder.delete(id);
        barriers.delete(id);
      }
    snapshot = merged.sort((left, right) => {
      if (left.persisted && right.persisted) return left.sequence - right.sequence;
      const a = admissionOrder.get(left.id),
        b = admissionOrder.get(right.id);
      if (a === undefined && b === undefined) return left.sequence - right.sequence;
      if (a === undefined) return -1;
      if (b === undefined) return 1;
      return a - b;
    });
    for (const listener of listeners) listener();
  };
  const unsubscribe = [held.subscribe(changed), inputOwner.subscribe(changed)];
  channel?.addEventListener('message', () => {
    void inputOwner.refresh().catch(() => {});
  });
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    has: (id: string) => snapshot.some((send) => send.id === id),
    ownsDelivery: inputOwner.ownsDelivery,
    hasSession: (sessionId: string) => snapshot.some((send) => send.sessionId === sessionId),
    hasPendingCreation: (sessionId: string) =>
      snapshot.some((send) => send.sessionId === sessionId && send.creation),
    enqueue(send: Parameters<typeof held.enqueue>[0]) {
      if (
        runtime.contentMode === 'e2ee' &&
        (send.historyBackend === 'roost' ||
          send.attachments.some(
            (attachment) =>
              !attachment.ready ||
              attachment.ready.type !== 'file' ||
              attachment.ready.transport !== 'local'
          ))
      )
        throw new Error('e2ee_feature_unavailable');
      admissionOrder.set(send.id, ++nextAdmission);
      if (
        send.historyBackend === 'roost' &&
        !send.queue &&
        !send.attachments.some((attachment) => !attachment.ready) &&
        !held.hasSession(send.sessionId)
      )
        inputOwner.enqueue(send);
      else {
        if (send.historyBackend === 'roost') {
          const barrier = inputOwner.capturePredecessors(send.sessionId);
          void barrier.catch(() => {});
          barriers.set(send.id, barrier);
        }
        held.enqueue(send);
      }
      if (send.historyBackend === 'roost' && !send.queue) inputOwner.rememberDelivery(send);
    },
    retry(id: string) {
      // Prepared sends remain held until the durable input finishes delivery.
      if (inputOwner.getSnapshot().some((input) => input.id === id)) inputOwner.retry(id);
      else held.retry(id);
    },
    cancel: (id: string) =>
      Promise.all([held.cancel(id), inputOwner.cancel(id)]).then(() => undefined),
    cancelSessions: (ids: Iterable<import('@lody/shared').SessionId>) => {
      const targets = [...ids];
      return Promise.all([held.cancelSessions(targets), inputOwner.cancelSessions(targets)]).then(
        () => undefined
      );
    },
    acknowledgeLanded: inputOwner.acknowledgeLanded,
    resume: inputOwner.resume,
    async dispose() {
      held.dispose();
      for (const release of unsubscribe) release();
      listeners.clear();
      channel?.close();
      await inputOwner.dispose();
    },
  };
}
