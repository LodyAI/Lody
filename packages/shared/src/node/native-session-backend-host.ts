import type { SessionMeta, SessionHistoryInput } from '@lody/shared';
import type { NativeSessionBackendHostPorts } from './native-session-backend';
import type {
  NativeSessionControlPort,
  NativeSessionMetadataPort,
} from './native-session-document';
import type { NativeSessionReader } from './native-session-reader';
import type { NativeSessionWriter } from './native-session-writer';
import type { SessionBackend } from './native-session-contract';
import { promoteSessionQueuedTurn } from './native-session-queue-promotion';
import {
  prepareSessionQueuePromotionLedger,
  prepareSessionSteerOperationLedger,
} from './native-session-meta-plan';

/** Real SessionBackend host methods over native control and the existing
 * independently owned workspace Meta domain. No old Session body is accessed. */
export function createNativeSessionBackendHost(options: {
  readonly sessionId: string;
  readonly reader: NativeSessionReader;
  readonly writer: NativeSessionWriter;
  readonly control: NativeSessionControlPort;
  readonly metadata: NativeSessionMetadataPort;
  readonly backend: () => SessionBackend;
  readonly now: () => number;
  initialize(options: { skipAutoRead: boolean }): Promise<void>;
  assertCurrent(): void;
  flush(): Promise<void>;
  waitUntilSynced(options?: { timeoutMs?: number }): Promise<boolean>;
  dispose(): Promise<void>;
}): NativeSessionBackendHostPorts {
  const readMeta = async () => {
    options.assertCurrent();
    return options.metadata.read();
  };
  const patchMeta = async (fields: Partial<SessionMeta>) => {
    options.assertCurrent();
    await options.metadata.patch(fields);
  };
  const publishActivation = async (id: string) => {
    options.assertCurrent();
    const turn = options.reader.history.readTurn(id);
    if (turn.state !== 'ready' || turn.turn.role !== 'user')
      throw new Error('User activation requires accepted native history');
    const plan = (meta: SessionMeta): Partial<SessionMeta> | undefined => {
      options.assertCurrent();
      if (meta.isArchived || meta.latestUserMsgId === id) return;
      const latest = meta.latestUserMsgId;
      if (latest) {
        const order = options.reader.query((view) => ({
          target: view.positionOfTurn(id) ?? -1,
          latest: view.positionOfTurn(latest) ?? -1,
        })).value;
        if (order.target < 0) throw new Error('User activation requires accepted native history');
        if (order.latest > order.target) return;
      }
      return { latestUserMsgId: id };
    };
    if (options.metadata.update) await options.metadata.update(plan);
    else {
      // The old in-process Meta facade keeps its existing local commit behavior.
      // Real native whole-workspace grants always supply the room-CAS planner.
      const meta = await readMeta();
      if (meta) {
        const patch = plan(meta);
        if (patch) await patchMeta(patch);
      }
    }
  };
  return {
    initialize: options.initialize,
    async getTurnStorageMetadata(turnId) {
      options.assertCurrent();
      return options.reader.query((view) => {
        const rows = view.history.readDirectory(0, view.history.count());
        for (let index = rows.length - 1; index >= 0; index--) {
          const current = rows[index];
          if (current?.scalars?.role !== 'assistant' || current.turnId !== turnId) continue;
          let timestamp = current.scalars.timestamp;
          if (current.scalars.userTurnId)
            for (let user = index - 1; user >= 0; user--) {
              const row = rows[user];
              if (row?.scalars?.role === 'user' && row.turnId === current.scalars.userTurnId) {
                timestamp = row.scalars.timestamp;
                break;
              }
            }
          const capturedAtMs = Date.parse(timestamp);
          if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) return;
          return {
            capturedAtMs,
            orderKey: `${capturedAtMs.toString().padStart(16, '0')}:${options.sessionId}:${current.position.toString().padStart(10, '0')}:${turnId}`,
          };
        }
        return undefined;
      }).value;
    },
    applyAcpRuntimeConfigPatch: options.control.applyAcpRuntimeConfigPatch,
    async appendUserTurn(entry: SessionHistoryInput) {
      if (entry.role !== 'user') throw new Error('appendUserTurn requires a user entry');
      options.assertCurrent();
      await options.writer.appendTurn(entry);
      await publishActivation(entry.id);
    },
    publishUserTurnActivation: publishActivation,
    promoteQueuedTurn: (input) =>
      promoteSessionQueuedTurn(
        options.backend(),
        (entry) => options.writer.appendTurn(entry),
        input,
        options.now
      ),
    getMessageQueue: options.control.getMessageQueue,
    peekReadyMessageQueue: options.control.peekReadyMessageQueue,
    removeMessageQueueItem: options.control.removeMessageQueueItem,
    getMetaState: readMeta,
    async getQueuePromotionRecord(id) {
      return (await readMeta())?.queuePromotionLedger?.[id];
    },
    async setQueuePromotionRecord(id, record) {
      await patchMeta({
        queuePromotionLedger: prepareSessionQueuePromotionLedger(await readMeta(), id, record),
      });
    },
    async getSteerTurnStatuses() {
      return (await readMeta())?.steerTurnStatuses;
    },
    replaceSteerTurnStatuses: (statuses) => patchMeta({ steerTurnStatuses: statuses }),
    async getSteerOperationRecord(id) {
      return (await readMeta())?.steerOperationLedger?.[id];
    },
    async getSteerOperationLedger() {
      return (await readMeta())?.steerOperationLedger;
    },
    async setSteerOperationRecord(id, record) {
      await patchMeta({
        steerOperationLedger: prepareSessionSteerOperationLedger(await readMeta(), id, record),
      });
    },
    flushLocalWrites: options.flush,
    waitUntilSynced: options.waitUntilSynced,
    getQueueOperationId: (item) =>
      item.operationId ?? `queue:${item.userTurnId?.trim() || item.$cid}`,
    dispose: options.dispose,
  };
}
