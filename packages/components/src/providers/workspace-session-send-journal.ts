import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  normalizeSessionTurnInputConfig,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import type { WorkspaceRuntime } from '../atoms/runtime';
import { createSessionSendJournal, type SessionSendRecord } from '../lib/session-send-journal';
import {
  createSessionSendJournalStorage,
  SESSION_SEND_STORAGE_LOCK,
} from '../lib/session-send-journal-storage';
import { throwIfSendAborted } from '../lib/session-send-resources';

export function createWorkspaceSessionSendJournal(args: {
  accountId: string;
  sourceReplica: string;
  runtime: Pick<
    WorkspaceRuntime,
    | 'workspaceId'
    | 'repo'
    | 'writer'
    | 'sendResources'
    | 'requestSessionDispatchTurn'
    | 'requestSessionSteer'
  >;
  waitForTargetSync(sessionId: SessionId, signal: AbortSignal): Promise<void>;
}) {
  const { runtime, accountId } = args;
  const storage = createSessionSendJournalStorage({ accountId, workspaceId: runtime.workspaceId });
  const requireAvailable = async (record: SessionSendRecord) => {
    if (record.accountId !== accountId || record.workspaceId !== runtime.workspaceId)
      throw new Error('Submission belongs to another account or workspace');
    // A new window can have a fresh replica. Merge persisted metadata before
    // deciding that a saved target is absent, using the repo's existing CRDT.
    if (record.sourceReplica !== args.sourceReplica) {
      const original = new IndexedDBStorageAdaptor({ dbName: record.sourceReplica });
      try {
        const baseline = await original.loadMeta();
        if (!baseline)
          throw new Error('Original submission metadata is unavailable; recovery retained');
        runtime.repo.getMeta().importJson(baseline.exportJson());
      } finally {
        await original.close();
      }
    }
    const found = await runtime.repo.getDocMeta(getSessionRoomId(record.sessionId));
    const meta = found?.meta as SessionMeta | undefined;
    if (isLoroRepoDocDeleted(found) || meta?.isArchived)
      throw new Error('Target conversation was deleted or archived');
    if (!record.creation && !meta?.id)
      throw new Error('Target conversation is not available in this replica');
    return meta;
  };
  let notify = () => {};
  return createSessionSendJournal({
    resources: runtime.sendResources,
    preparationReplica: args.sourceReplica,
    storage,
    observeExternal: (refresh) => {
      if (typeof BroadcastChannel === 'undefined') return () => {};
      const channel = new BroadcastChannel(
        `lody-session-send:${JSON.stringify([accountId, runtime.workspaceId])}`
      );
      channel.onmessage = refresh;
      notify = () => channel.postMessage(null);
      return () => {
        notify = () => {};
        channel.close();
      };
    },
    notifyExternal: () => notify(),
    lock: async (key, signal, execute) => {
      if (!navigator.locks)
        throw new Error(
          'This application cannot safely coordinate pending messages across windows'
        );
      return navigator.locks.request(
        key === 'admission'
          ? SESSION_SEND_STORAGE_LOCK
          : `lody-session-send:${JSON.stringify([accountId, runtime.workspaceId, key])}`,
        { signal },
        execute
      );
    },
    prepare: async (record, signal) => {
      await requireAvailable(record);
      return runtime.sendResources.withSessionStore(
        record.sessionId,
        async (store) => {
          const current = await store.sessionData.history.readTurn(record.id);
          if (current.state !== 'missing')
            throw new Error(
              'Submission identity already exists; original operations are required for recovery'
            );
          const update = record.queue
            ? await runtime.writer.prepareSessionMessage(record.sessionId, record.queue)
            : await store.sessionData.commands.prepareAppendTurn(record.entry);
          // Captured dependencies must be persisted before publishing the prepared update.
          await runtime.repo.flush();
          throwIfSendAborted(signal);
          return update;
        },
        signal
      );
    },
    commit: async (record, signal) => {
      const meta = await requireAvailable(record);
      await runtime.sendResources.withSessionStore(
        record.sessionId,
        async (store) => {
          if (record.sourceReplica !== args.sourceReplica) {
            // Recover the original persisted baseline, never infer absence from a new window.
            const original = new IndexedDBStorageAdaptor({ dbName: record.sourceReplica });
            try {
              const source = await original.loadDoc(getSessionRoomId(record.sessionId));
              if (!source)
                throw new Error('Original submission replica is unavailable; recovery retained');
              try {
                store.doc.import(source.export({ mode: 'snapshot' }));
              } finally {
                source.free();
              }
            } finally {
              await original.close();
            }
          }
          throwIfSendAborted(signal);
          if (!record.update) throw new Error('Prepared submission has no saved operations');
          await store.sessionData.commands.applyPreparedTurn(record.update);
          if (record.queue)
            await runtime.writer.upsertDocMeta(getSessionRoomId(record.sessionId), {
              messageQueueUpdatedAt: Date.now(),
            });
          if (record.creation) {
            // Repair only absent creation fields after a partial write; retain later edits.
            const patch = Object.fromEntries(
              Object.entries(record.creation).filter(([key]) => !meta || !(key in meta))
            );
            if (Object.keys(patch).length)
              await runtime.writer.upsertDocMeta(getSessionRoomId(record.sessionId), patch);
          }
          await runtime.repo.flush();
        },
        signal
      );
    },
    deliver: async (record, signal, checkpoint) => {
      const meta = await requireAvailable(record);
      const machineId = meta?.machineId ?? record.creation?.machineId;
      if (!machineId) throw new Error('Target machine is unavailable');
      const inputConfig = normalizeSessionTurnInputConfig(record.entry.inputConfig);
      const userId = record.entry.userId?.trim();
      if (!inputConfig || !userId)
        throw new Error('Saved submission has invalid input configuration');
      let dispatch = record.delivery.kind === 'dispatch';
      if (record.delivery.kind === 'guide') {
        let offer = record.guideOffer;
        if (offer === 'offered') {
          const read = await runtime.sendResources.withSessionStore(
            record.sessionId,
            (store) => store.sessionData.history.readTurn(record.id),
            signal
          );
          if (read.state !== 'ready' || !read.turn.status || read.turn.status === 'pending_apply') {
            throw new Error('Guide outcome is uncertain; retry only reconciles the original turn');
          }
          offer =
            normalizeSessionTurnInputConfig(read.turn.inputConfig)?._lodyDeliveryKind === 'steer'
              ? 'applied'
              : 'not-applied';
          await checkpoint({ guideOffer: offer });
        }
        if (!offer) {
          await checkpoint({ guideOffer: 'offered' });
          const [rpc, sync] = await Promise.allSettled([
            runtime.requestSessionSteer(machineId as MachineId, {
              sessionId: record.sessionId,
              expectedTurnId: record.delivery.expectedTurnId,
              userTurnId: record.id,
              userId,
              timestamp: record.entry.timestamp,
              inputConfig,
            }),
            args.waitForTargetSync(record.sessionId, signal),
          ]);
          if (rpc.status === 'rejected') throw rpc.reason;
          if (rpc.value?.applied) offer = 'applied';
          else if (rpc.value?.disposition === 'no-active-turn') offer = 'not-applied';
          else throw new Error('Guide outcome is uncertain; the original turn is retained');
          await checkpoint({ guideOffer: offer });
          if (sync.status === 'rejected') throw sync.reason;
        }
        throwIfSendAborted(signal);
        await runtime.sendResources.withSessionStore(
          record.sessionId,
          (store) =>
            store.sessionData.commands.applyHistoryAction({
              kind: 'user-status',
              turnId: record.id,
              status: offer === 'applied' ? 'processing' : 'pending',
              deliveredSteer: offer === 'applied',
              onlyPendingApply: true,
            }),
          signal
        );
        await runtime.repo.flush();
        dispatch = offer === 'not-applied';
      }
      if (dispatch) {
        // Recheck under the session delivery lock: UI state can predate another send.
        dispatch = await runtime.sendResources.withSessionStore(
          record.sessionId,
          async (store) => {
            if ((store.getState().mq ?? []).some((item) => item.userTurnId !== record.id))
              return false;
            const rows = await store.sessionData.history.readDirectory(
              0,
              await store.sessionData.history.count()
            );
            const position = rows.findIndex((row) => row.turnId === record.id);
            if (position < 0 || rows[position]?.state !== 'ready')
              throw new Error('Saved turn is not available for dispatch');
            const status = rows[position]?.scalars?.status;
            if (status && status !== 'pending') return false;
            return !rows
              .slice(0, position)
              .some(
                (row) =>
                  row.state !== 'ready' ||
                  (row.scalars?.role === 'user' &&
                    ['pending', 'pending_apply', 'seen', 'processing'].includes(
                      row.scalars.status ?? 'pending'
                    )) ||
                  (row.scalars?.role === 'assistant' && !row.scalars.finished)
              );
          },
          signal
        );
      }
      if (dispatch) {
        await runtime.writer.upsertDocMeta(getSessionRoomId(record.sessionId), {
          latestUserMsgId: record.id,
        });
        await runtime.repo.flush();
        throwIfSendAborted(signal);
        // RPC accelerates already-persisted history; its acknowledgment alone never retires the journal.
        const [synced] = await Promise.allSettled([
          args.waitForTargetSync(record.sessionId, signal),
          runtime.requestSessionDispatchTurn(machineId as MachineId, {
            sessionId: record.sessionId,
            userTurnId: record.id,
            userId,
            timestamp: record.entry.timestamp,
            inputConfig,
          }),
        ]);
        if (synced.status === 'rejected') throw synced.reason;
        throwIfSendAborted(signal);
        return;
      }
      await args.waitForTargetSync(record.sessionId, signal);
    },
  });
}
