import {
  getMachineRoomId,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isSessionHistoryStatusAwaitingStart,
  machineSupportsSessionInputAcceptance,
  machineSupportsSessionInputDispatch,
  normalizeSessionInputBlocks,
  type MachineMeta,
  type SessionMeta,
  type SessionId,
} from '@lody/shared';
import i18next from 'i18next';
import { createAcceptedSessionInputs, SessionInputNotSentError } from './session-accepted-inputs';
import { createSessionInputStorage } from './session-input-storage';
import { encryptedLocalInstance, type E2eeLocalDataIdentity } from './e2ee-local-data';
import {
  deliverUserTurn,
  prepareUserTurnWrite,
  persistHumanInputReceipt,
  type SessionSendRuntime,
} from './session-send-delivery';
import type { PendingSessionSend } from './session-pending-sends';
import { throwIfSendAborted } from './session-send-resources';

type InputPorts = Parameters<typeof createAcceptedSessionInputs>[0];

/** Own ready Roost input for one workspace. The host supplies its existing document and RPC ports. */
export function createWorkspaceAcceptedInputs(args: {
  runtime: SessionSendRuntime;
  runtimeForDelivery?(signal: AbortSignal): SessionSendRuntime;
  accountId: string;
  workspaceId: string;
  localIdentity?: E2eeLocalDataIdentity;
  paused?: boolean;
  /** Additional host admission for device-local references, beyond shared preparation. */
  validateLocalAttachments?(send: PendingSessionSend): Promise<void>;
  visible: InputPorts['visible'];
  diagnose?: InputPorts['diagnose'];
  onDelivered?(sessionId: SessionId, turnId: string): void;
  onGuideOutcome?: Parameters<typeof deliverUserTurn>[2];
}) {
  const { runtime } = args;
  const text = (key: string) => i18next.t(key) ?? key;
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
    if (
      normalizeSessionInputBlocks(send.entry.inputConfig?.inputBlocks, '').some(
        (block) => block.type === 'local_attachment'
      )
    )
      await args.validateLocalAttachments?.(send);
    const found = await runtime.repo.getDocMeta(getSessionRoomId(send.sessionId));
    const meta = found?.meta as SessionMeta | undefined;
    if (isLoroRepoDocDeleted(found) || meta?.isArchived)
      throw new SessionInputNotSentError(text('sessions.inputTargetUnavailable'));
    const target = meta?.machineId ?? send.creation?.machineId;
    const backend = meta?.historyBackend ?? send.creation?.historyBackend;
    if (!send.targetMachineId || target !== send.targetMachineId || backend !== 'roost') {
      throw new SessionInputNotSentError(text('sessions.inputTargetChanged'));
    }
    const machine = await runtime.repo.getDocMeta(getMachineRoomId(send.targetMachineId));
    if (
      !machineSupportsSessionInputAcceptance(machine?.meta as MachineMeta | undefined) ||
      (send.delivery.kind === 'dispatch' &&
        !machineSupportsSessionInputDispatch(machine?.meta as MachineMeta | undefined))
    ) {
      throw new SessionInputNotSentError(text('sessions.inputOwnerNeedsUpdate'));
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
          new SessionInputNotSentError(text('sessions.inputStorageUnavailable'))
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
            throw new SessionInputNotSentError(text('sessions.inputOwnerNeedsUpdate'));
          await validateTarget(send);
          if (store.sessionData.inputAcceptance.targetMachineId !== send.targetMachineId)
            throw new SessionInputNotSentError(text('sessions.inputTargetChanged'));
          throwIfSendAborted(signal);
          if (send.delivery.kind === 'dispatch') {
            const accept = store.sessionData.inputAcceptance.acceptAndDispatch;
            if (!accept) throw new SessionInputNotSentError(text('sessions.inputOwnerNeedsUpdate'));
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
            throw new SessionInputNotSentError(text('sessions.inputOwnerNeedsUpdate'));
          await validateTarget(send);
          if (store.sessionData.inputAcceptance.targetMachineId !== send.targetMachineId)
            throw new SessionInputNotSentError(text('sessions.inputTargetChanged'));
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
              throw new SessionInputNotSentError(text('sessions.inputOwnerNeedsUpdate'));
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
      await deliverUserTurn(
        args.runtimeForDelivery?.(signal) ?? runtime,
        send,
        args.onGuideOutcome
      );
      return undefined;
    },
    visible: args.visible,
    unknownMessage: () => text('sessions.inputOutcomeUnknown'),
    changed: () => channel?.postMessage('changed'),
    diagnose: args.diagnose,
  });
  channel?.addEventListener('message', () => {
    void inputOwner.refresh().catch(() => {});
  });
  return {
    ...inputOwner,
    async dispose() {
      channel?.close();
      await inputOwner.dispose();
    },
  };
}
