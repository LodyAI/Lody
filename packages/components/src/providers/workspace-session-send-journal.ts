import {
  evaluateBillingQuota,
  evaluateSessionCreateQuota,
  formatSessionQuotaRejection,
  FREE_SESSION_TURN_LIMIT,
  countPendingQueuedUserTurns,
  type BillingQuotaEntitlement,
} from '@lody/shared';
import { prepareDraftAttachments } from '../lib/session-attachment-preparation';
import { readGuideTurnOutcome } from '../lib/session-guide-outcome';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isSessionHistoryStatusAwaitingStart,
  normalizeSessionTurnInputConfig,
  type MachineId,
  type MessageQueueItem,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import type { SessionDocDraft, SessionDocStore, WorkspaceRuntime } from '../atoms/runtime';
import { createSessionSendJournal, type SessionSendRecord } from '../lib/session-send-journal';
import {
  createSessionSendJournalStorage,
  SESSION_SEND_STORAGE_LOCK,
} from '../lib/session-send-journal-storage';
import { throwIfSendAborted } from '../lib/session-send-resources';

export function createWorkspaceSessionSendJournal(args: {
  accountId: string;
  getAdmissionContext?: () => {
    entitlement?: BillingQuotaEntitlement;
    sessionCount: number | null;
  };
  token(): string | null;
  localMachineId(): MachineId | null;
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
  const readTarget = async (record: SessionSendRecord) => {
    if (record.accountId !== accountId || record.workspaceId !== runtime.workspaceId)
      throw new Error('Submission belongs to another account or workspace');
    // A new window can have a fresh replica. Merge persisted metadata before
    // deciding that a saved target is absent, using the repo's existing CRDT.
    if (record.sourceReplica !== args.sourceReplica) {
      const original = new IndexedDBStorageAdaptor({ dbName: record.sourceReplica });
      try {
        const baseline = await original.loadMeta();
        if (baseline) runtime.repo.getMeta().importJson(baseline.exportJson());
      } finally {
        await original.close();
      }
    }
    return runtime.repo.getDocMeta(getSessionRoomId(record.sessionId));
  };
  const requireAvailable = async (record: SessionSendRecord) => {
    const found = await readTarget(record);
    const meta = found?.meta as SessionMeta | undefined;
    if (isLoroRepoDocDeleted(found) || meta?.isArchived)
      throw new Error('Target conversation was deleted or archived');
    if (!record.creation && !meta?.id)
      throw new Error('Target conversation is not available in this replica');
    return meta;
  };
  const checkEligibility = async (record: SessionSendRecord, signal: AbortSignal) => {
    const context = args.getAdmissionContext?.();
    if (!context) return;
    const entitlement = context.entitlement ?? { effectivePlanTier: undefined };
    const meta = (await runtime.repo.getDocMeta(getSessionRoomId(record.sessionId)))?.meta;
    if (record.creation && !meta?.id) {
      const admission = evaluateSessionCreateQuota({
        ...entitlement,
        sessionCount: context.sessionCount,
      });
      if (!admission.allowed)
        throw new Error(formatSessionQuotaRejection('session_create', admission));
    }
    await runtime.sendResources.withSessionStore(
      record.sessionId,
      async (store) => {
        const rows = await store.sessionData.history.readDirectory(
          0,
          await store.sessionData.history.count()
        );
        const queue = store.getState().mq ?? [];
        if (
          rows.some((row) => row.turnId === record.id) ||
          queue.some((item) => item.userTurnId === record.id)
        )
          return;
        const current =
          rows.filter((row) => row.scalars?.role === 'user').length +
          countPendingQueuedUserTurns(queue);
        const admission = evaluateBillingQuota({
          ...entitlement,
          current,
          limit: FREE_SESSION_TURN_LIMIT,
        });
        if (!admission.allowed)
          throw new Error(formatSessionQuotaRejection('session_turn', admission));
      },
      signal
    );
  };
  const isWritten = async (record: SessionSendRecord, store: SessionDocStore) =>
    (await store.sessionData.history.readTurn(record.id)).state !== 'missing' ||
    (!!record.queue && (store.getState().mq ?? []).some((item) => item.userTurnId === record.id));
  const restoreReplica = async (record: SessionSendRecord, store: SessionDocStore) => {
    if (record.sourceReplica === args.sourceReplica) return;
    const original = new IndexedDBStorageAdaptor({ dbName: record.sourceReplica });
    try {
      const source = await original.loadDoc(getSessionRoomId(record.sessionId));
      if (source) {
        try {
          store.doc.import(source.export({ mode: 'snapshot' }));
        } finally {
          source.free();
        }
      }
    } finally {
      await original.close();
    }
  };
  const activateLocalTurn = async (record: SessionSendRecord, store: SessionDocStore) => {
    const found = await runtime.repo.getDocMeta(getSessionRoomId(record.sessionId));
    if (isLoroRepoDocDeleted(found)) return;
    const latest = found?.meta?.latestUserMsgId;
    if (latest === record.id) return;
    if (latest) {
      const rows = await store.sessionData.history.readDirectory(
        0,
        await store.sessionData.history.count()
      );
      if (
        rows.findIndex((row) => row.turnId === latest) >
        rows.findIndex((row) => row.turnId === record.id)
      )
        return;
    }
    await runtime.writer.upsertDocMeta(getSessionRoomId(record.sessionId), {
      latestUserMsgId: record.id,
    });
  };
  let notify = () => {};
  let interrupt = (_sessionId: SessionId) => {};
  return createSessionSendJournal({
    resources: runtime.sendResources,
    preparationReplica: args.sourceReplica,
    storage,
    targetState: async (record) => {
      const found = await readTarget(record);
      if (isLoroRepoDocDeleted(found)) return 'deleted';
      return found?.meta?.isArchived ? 'archived' : 'active';
    },
    admitted: async (record, signal) => {
      if (!record.creation) return;
      const meta = await requireAvailable(record);
      await checkEligibility(record, signal);
      throwIfSendAborted(signal);
      const patch = Object.fromEntries(
        Object.entries(record.creation).filter(([key]) => !meta || !(key in meta))
      );
      if (Object.keys(patch).length)
        await runtime.writer.upsertDocMeta(getSessionRoomId(record.sessionId), patch);
      await runtime.repo.flush();
    },
    observeExternal: (refresh, interruptSession) => {
      if (typeof BroadcastChannel === 'undefined') return () => {};
      const channel = new BroadcastChannel(
        `lody-session-send:${JSON.stringify([accountId, runtime.workspaceId])}`
      );
      channel.onmessage = (event) => {
        if (event.data?.type === 'interrupt' && typeof event.data.sessionId === 'string')
          interruptSession(event.data.sessionId as SessionId);
        refresh();
      };
      notify = () => channel.postMessage(null);
      interrupt = (sessionId) => channel.postMessage({ type: 'interrupt', sessionId });
      return () => {
        notify = () => {};
        interrupt = () => {};
        channel.close();
      };
    },
    notifyExternal: () => notify(),
    interruptExternal: (sessionId) => interrupt(sessionId),
    activeSessions: async () => {
      const inventory = await navigator.locks?.query?.();
      const sessions = new Set<string>();
      for (const lock of [...(inventory?.held ?? []), ...(inventory?.pending ?? [])]) {
        if (!lock.name?.startsWith('lody-session-send:[')) continue;
        try {
          const [account, workspace, key] = JSON.parse(
            lock.name.slice('lody-session-send:'.length)
          );
          if (account !== accountId || workspace !== runtime.workspaceId || typeof key !== 'string')
            continue;
          if (key.startsWith('submit:') || key.startsWith('delivery:'))
            sessions.add(key.slice(key.indexOf(':') + 1));
        } catch {
          /* Unrelated lock names do not describe this journal. */
        }
      }
      return sessions;
    },
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
    prepareInput: async (record, signal, checkpoint, report) => {
      await requireAvailable(record);
      await prepareDraftAttachments({
        record,
        signal,
        checkpoint,
        report,
        resources: runtime.sendResources,
        token: args.token,
        localMachineId: args.localMachineId,
      });
    },
    prepare: async (record, signal) => {
      await requireAvailable(record);
      await checkEligibility(record, signal);
      await runtime.sendResources.withSessionStore(
        record.sessionId,
        async (store) => {
          await restoreReplica(record, store);
          const current = await store.sessionData.history.readTurn(record.id);
          if (current.state !== 'missing')
            throw new Error('Submission identity already exists in this conversation');
          // The outbox can now name this replica before its first publication.
          await runtime.repo.flush();
        },
        signal
      );
    },
    commit: async (record, signal, { resumed }) => {
      const meta = await requireAvailable(record);
      await checkEligibility(record, signal);
      if (record.creation) {
        // Target routing resolves the owning machine from this metadata, so it
        // precedes catch-up. Repair only absent fields; retain later edits.
        const patch = Object.fromEntries(
          Object.entries(record.creation).filter(([key]) => !meta || !(key in meta))
        );
        if (Object.keys(patch).length)
          await runtime.writer.upsertDocMeta(getSessionRoomId(record.sessionId), patch);
      }
      // Ordinary sends never wait for the network. For an interrupted write,
      // the original persisted turn suffices too. Only a missing uncertain
      // turn needs reconciliation: it may have reached a peer before local
      // persistence failed, and appending again would manufacture a duplicate.
      if (resumed) {
        const written = await runtime.sendResources.withSessionStore(
          record.sessionId,
          async (store) => {
            await restoreReplica(record, store);
            return isWritten(record, store);
          },
          signal
        );
        if (!written) await args.waitForTargetSync(record.sessionId, signal);
      }
      await runtime.sendResources.withSessionStore(
        record.sessionId,
        async (store) => {
          await restoreReplica(record, store);
          throwIfSendAborted(signal);
          await requireAvailable(record);
          if (!(await isWritten(record, store))) {
            // Local commits are what the transports upload; never write via import.
            if (record.queue) {
              const item = record.queue as MessageQueueItem;
              store.setState((draft: SessionDocDraft) => {
                draft.mq = [...((draft.mq ?? []) as MessageQueueItem[]), item];
              });
            } else {
              await store.sessionData.commands.appendTurn(record.entry);
            }
          }
          if (record.queue)
            await runtime.writer.upsertDocMeta(getSessionRoomId(record.sessionId), {
              messageQueueUpdatedAt: Date.now(),
            });
          else if (record.delivery.kind === 'dispatch') await activateLocalTurn(record, store);
          await runtime.repo.flush();
        },
        signal
      );
    },
    deliver: async (record, signal, checkpoint) => {
      const found = await readTarget(record);
      if (isLoroRepoDocDeleted(found)) return;
      const meta = found?.meta as SessionMeta | undefined;
      await runtime.sendResources.withSessionStore(
        record.sessionId,
        (store) => restoreReplica(record, store),
        signal
      );
      if (meta?.isArchived) {
        // Synchronize the local archive and history, but never launch work in it.
        if (record.delivery.kind === 'dispatch') {
          await runtime.sendResources.withSessionStore(
            record.sessionId,
            (store) => activateLocalTurn(record, store),
            signal
          );
          await runtime.repo.flush();
        }
        await args.waitForTargetSync(record.sessionId, signal);
        return;
      }
      const machineId = record.targetMachineId ?? meta?.machineId ?? record.creation?.machineId;
      if (!machineId) throw new Error('Target machine is unavailable');
      const inputConfig = normalizeSessionTurnInputConfig(record.entry.inputConfig);
      const userId = record.entry.userId?.trim();
      if (!inputConfig || !userId)
        throw new Error('Saved submission has invalid input configuration');
      if (meta?.acpSessionId) inputConfig.resume = meta.acpSessionId;
      let dispatch = record.delivery.kind === 'dispatch';
      if (record.delivery.kind === 'guide') {
        let offer = record.guideOffer;
        const readGuide = async () =>
          readGuideTurnOutcome(
            await runtime.sendResources.withSessionStore(
              record.sessionId,
              (store) => store.sessionData.history.readTurn(record.id),
              signal
            )
          );
        if (offer === 'offered') {
          const outcome = await readGuide();
          if (outcome === 'uncertain') {
            throw new Error('Guide outcome is uncertain; retry only reconciles the original turn');
          }
          offer = outcome;
          await checkpoint({ guideOffer: offer });
        }
        if (!offer) {
          const expectedTurnId = record.delivery.expectedTurnId;
          const target = await runtime.sendResources.withSessionStore(
            record.sessionId,
            (store) => store.sessionData.history.readTurn(expectedTurnId),
            signal
          );
          if (
            target.state === 'ready' &&
            target.turn.role === 'assistant' &&
            target.turn.finished
          ) {
            offer = 'not-applied';
            await checkpoint({ guideOffer: offer });
          }
        }
        if (!offer) {
          await checkpoint({ guideOffer: 'offered' });
          const steerRequest = {
            sessionId: record.sessionId,
            expectedTurnId: record.delivery.expectedTurnId,
            userTurnId: record.id,
            userId,
            timestamp: record.entry.timestamp,
            inputConfig,
          };
          const [rpc, sync] = await Promise.allSettled([
            runtime.requestSessionSteer(machineId as MachineId, steerRequest),
            args.waitForTargetSync(record.sessionId, signal),
          ]);
          if (rpc.status === 'rejected') throw rpc.reason;
          let response = rpc.value;
          if (response?.recoveryOwned && response.disposition === 'promotion-failed') {
            // The daemon owns this recovery; retry through it, never by dispatching here.
            response = await runtime.requestSessionSteer(machineId as MachineId, steerRequest);
          }
          if (response?.applied) offer = 'applied';
          else if (response?.recoveryOwned) {
            // The daemon already requeued (or settled) a guide it proved undelivered.
            // Its history write, not the disposition, says whether it did.
            await args.waitForTargetSync(record.sessionId, signal);
            if ((await readGuide()) === 'uncertain')
              throw new Error(
                response.error ?? 'Guide outcome is uncertain; the original turn is retained'
              );
            offer = 'recovered';
          } else if (response?.disposition === 'no-active-turn') offer = 'not-applied';
          else throw new Error('Guide outcome is uncertain; the original turn is retained');
          await checkpoint({ guideOffer: offer });
          if (sync.status === 'rejected') throw sync.reason;
        }
        throwIfSendAborted(signal);
        if (offer === 'recovered') return;
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
      let activate = false;
      if (dispatch) {
        // Recheck under the session delivery lock: UI state can predate another send.
        dispatch = await runtime.sendResources.withSessionStore(
          record.sessionId,
          async (store) => {
            const rows = await store.sessionData.history.readDirectory(
              0,
              await store.sessionData.history.count()
            );
            const position = rows.findIndex((row) => row.turnId === record.id);
            if (position < 0 || rows[position]?.state !== 'ready')
              throw new Error('Saved turn is not available for dispatch');
            // Auto-read can mark a locally committed turn `seen` before this
            // recheck; only an execution state means the CLI claimed it.
            const status = rows[position]?.scalars?.status;
            if (status && !isSessionHistoryStatusAwaitingStart(status)) return false;
            // Even when the fast path waits behind another turn, the CLI must
            // discover this committed input after restart. Legacy/imported
            // rows can look unfinished here; only the CLI owns dispatch order.
            activate = true;
            if ((store.getState().mq ?? []).some((item) => item.userTurnId !== record.id))
              return false;
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
      if (activate) {
        await runtime.sendResources.withSessionStore(
          record.sessionId,
          (store) => activateLocalTurn(record, store),
          signal
        );
        await runtime.repo.flush();
        throwIfSendAborted(signal);
      }
      if (dispatch) {
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
