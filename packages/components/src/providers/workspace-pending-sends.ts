import { isElectronRenderer } from '../lib/electron';
import { resolveAttachmentRoute } from '../lib/session-attachment-routing';
import { assertProtectedAttachmentReferences } from '../lib/encrypted-session-attachment';
import { requireEncryptedRoostOwner } from '../lib/encrypted-roost-history';
import {
  getMachineRoomId,
  getServerNow,
  normalizeSessionInputBlocks,
  type MachineMeta,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import { prepareDraftAttachments } from '../lib/session-attachment-preparation';
import { createPendingSessionSends, type PendingSessionSend } from '../lib/session-pending-sends';
import { createWorkspaceAcceptedInputs } from '../lib/workspace-accepted-inputs';
import type { E2eeLocalDataIdentity } from '../lib/e2ee-local-data';
import { recordClientLog } from '../lib/client-log';
import {
  deliverUserTurn,
  writeUserTurn,
  type SessionSendRuntime,
} from '../lib/session-send-delivery';
import { throwIfSendAborted } from '../lib/session-send-resources';
import { QUEUED_EDIT_RENEW_INTERVAL_MS } from '../lib/queued-edit-lease';

/** Refresh a held edit's row lease every interval until stopped. */
function holdQueuedEditLease(runtime: SessionSendRuntime, sessionId: SessionId, cid: string) {
  const renew = () => {
    void runtime.writer
      .updateSessionMessage(sessionId, cid, { isEditing: true, editingStartedAt: getServerNow() })
      .catch((error: unknown) => {
        console.warn('Failed to renew a queued edit lease', { sessionId, cid, error });
      });
  };
  const timer = setInterval(renew, QUEUED_EDIT_RENEW_INTERVAL_MS);
  return () => clearInterval(timer);
}

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
  /** Called before held in-memory sends are discarded on runtime disposal. */
  onDisposeHeld?(sends: readonly PendingSessionSend[]): void;
}) {
  const { runtime } = args;
  const content = {
    mode: runtime.contentMode === 'e2ee' ? 'protected' : 'plaintext',
  } as const;
  const inputOwner = createWorkspaceAcceptedInputs({
    ...args,
    visible: (send, signal) =>
      runtime.sendResources.withSessionStore(
        send.sessionId,
        (store) => {
          const index = store.history.indexOf(send.id);
          return index >= 0 && store.history.turn(index) !== undefined;
        },
        signal
      ),
    diagnose: (level, event, details) => recordClientLog(level, event, undefined, details),
  });
  const barriers = new Map<string, Promise<readonly string[]>>();
  const admissionOrder = new Map<string, number>();
  let nextAdmission = 0;
  const checkRoostOwner = async (send: PendingSessionSend) => {
    if (runtime.contentMode !== 'e2ee' || send.historyBackend !== 'roost') return;
    const machine = send.targetMachineId
      ? await runtime.repo.getDocMeta(getMachineRoomId(send.targetMachineId))
      : undefined;
    requireEncryptedRoostOwner(machine?.meta as MachineMeta | undefined);
  };
  const held = createPendingSessionSends({
    prepare: async (send, signal, update) => {
      await checkRoostOwner(send);
      // An edit holds its row while it prepares: keep the CLI's editing lease
      // fresh until the replacement lands (or the edit is canceled).
      const stopLease = send.queueReplace
        ? holdQueuedEditLease(runtime, send.sessionId, send.queueReplace.cid)
        : undefined;
      try {
        return await prepareDraftAttachments({
          content,
          record: send,
          signal,
          resources: runtime.sendResources,
          token: args.token,
          attachmentToken: runtime.attachmentToken,
          localMachineId: args.localMachineId,
          update,
        });
      } finally {
        stopLease?.();
      }
    },
    write: (send, signal) =>
      runtime.sendResources.run(async (owned) => {
        if (runtime.contentMode === 'e2ee')
          assertProtectedAttachmentReferences([
            ...normalizeSessionInputBlocks(send.entry.inputConfig?.inputBlocks, ''),
            ...send.attachments.flatMap((item) => (item.ready ? [item.ready] : [])),
          ]);
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
        return inputOwner.afterInputs(send.sessionId, predecessors, owned, async () => {
          await checkRoostOwner(send);
          await writeUserTurn(runtime, send, owned);
        });
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
  return {
    canPrepareAttachmentsLocally: (machineId: MachineId) =>
      resolveAttachmentRoute({
        content,
        native: isElectronRenderer(),
        localMachineId: args.localMachineId(),
        targetMachineId: machineId,
      }) === 'local',
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
      if (send.workspaceId !== args.workspaceId) throw new Error('attachment_workspace_mismatch');
      if (runtime.contentMode === 'e2ee') {
        assertProtectedAttachmentReferences([
          ...normalizeSessionInputBlocks(send.entry.inputConfig?.inputBlocks, ''),
          ...send.attachments.flatMap((item) => (item.ready ? [item.ready] : [])),
        ]);
      }
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
      const remainingHeld = held.getSnapshot();
      if (remainingHeld.length > 0) {
        try {
          args.onDisposeHeld?.(remainingHeld);
        } catch (error) {
          console.warn('Preserving held send drafts failed', error);
        }
      }
      held.dispose();
      for (const release of unsubscribe) release();
      listeners.clear();
      await inputOwner.dispose();
    },
  };
}
