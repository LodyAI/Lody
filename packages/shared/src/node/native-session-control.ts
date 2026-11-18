import type { MessageQueueItem } from '@lody/shared';
import {
  LODY_SESSION_DOC_SCHEMA,
  type JsonPatch,
  type RepoClient,
  type RoomKey,
} from '@loro-dev/loro-repo-client';

type QueueClient = Pick<RepoClient, 'readDoc' | 'applyDocPatch' | 'transactCas'>;

/** Trusted host port. No client, room selector, or arbitrary patch is exposed to UI. */
export function createNativeSessionQueuePort(options: {
  readonly client: QueueClient;
  readonly namespace: string;
  readonly sessionId: string;
  readonly writer: string;
  readonly now: () => number;
  readonly editingLeaseMs: number;
  readonly assertCurrent?: () => void;
}) {
  const { client, namespace, writer } = options;
  const room: RoomKey = { kind: 'loro_doc', id: `session-${options.sessionId}` };

  const readQueue = async (): Promise<{ roomTxId: number; rows: MessageQueueItem[] }> => {
    options.assertCurrent?.();
    let result;
    try {
      result = await client.readDoc(namespace, room, ['mq']);
    } catch (error) {
      // The published 0.1.0 protocol has no optional-path read. Do not turn
      // transport/storage/corruption errors into an authoritative empty queue.
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'invalid_patch' &&
        'detail' in error &&
        error.detail === 'path not found'
      )
        return { roomTxId: -1, rows: [] };
      throw error;
    }
    if (!Array.isArray(result.value)) throw new Error('Invalid native Session queue projection');
    const ids = new Set<string>();
    for (const row of result.value) {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        !('$cid' in row) ||
        typeof row.$cid !== 'string' ||
        ids.has(row.$cid)
      ) {
        throw new Error('Invalid native Session queue identity');
      }
      ids.add(row.$cid);
    }
    // Existing unknown fields and legacy payloads remain opaque on read. This
    // port authors no queue body and never parses/reconstructs a stored row.
    return { roomTxId: result.roomTxId, rows: result.value as unknown as MessageQueueItem[] };
  };

  const mutate = async (plan: (rows: readonly MessageQueueItem[]) => JsonPatch) => {
    await client.transactCas(async () => {
      const current = await readQueue();
      const patch = plan(current.rows);
      options.assertCurrent?.();
      if (patch.length === 0) return;
      await client.applyDocPatch(namespace, room, patch, {
        writer,
        docSchema: LODY_SESSION_DOC_SCHEMA,
        precondition: { mode: 'cas', expected_room_tx_id: current.roomTxId },
      });
    });
  };

  return {
    async getMessageQueue(): Promise<MessageQueueItem[]> {
      return (await readQueue()).rows;
    },
    async peekReadyMessageQueue(): Promise<MessageQueueItem | null> {
      const first = (await readQueue()).rows[0];
      if (!first) return null;
      if (first.isEditing && options.now() - (first.editingStartedAt ?? 0) < options.editingLeaseMs)
        return null;
      return first;
    },
    async removeMessageQueueItem(cid: string): Promise<void> {
      await mutate((rows) => {
        const at = rows.findIndex((row) => row.$cid === cid);
        return at < 0 ? [] : [{ op: 'arr_splice', path: ['mq'], at, del: 1, items: [] }];
      });
    },
    async reorderMessageQueue(orderedCids: readonly string[]): Promise<void> {
      await mutate((rows) => {
        const current = rows.map((row) => row.$cid);
        const remaining = new Set(current);
        const ordered: string[] = [];
        for (const cid of orderedCids) {
          if (remaining.delete(cid)) ordered.push(cid);
        }
        ordered.push(...current.filter((cid) => remaining.has(cid)));
        const patch: Exclude<JsonPatch[number], undefined>[] = [];
        for (let to = 0; to < ordered.length; to++) {
          const from = current.indexOf(ordered[to]!, to);
          if (from === to) continue;
          patch.push({ op: 'move', from: ['mq', from], to: ['mq', to] });
          current.splice(to, 0, current.splice(from, 1)[0]!);
        }
        return patch;
      });
    },
  };
}

