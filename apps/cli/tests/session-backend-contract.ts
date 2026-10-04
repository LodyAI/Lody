import { describe, expect, it } from 'vitest';
import type {
  MessageQueueItem,
  SessionHistoryInput,
  SessionQueuePromotionRecord,
} from '@lody/shared';
import type { SessionBackend } from '../src/session/session-backend';

export type QueuePromotionFailurePoint =
  | 'prepared_receipt'
  | 'history_acceptance'
  | 'history_receipt'
  | 'activation_publication'
  | 'activation_receipt'
  | 'queue_consumption'
  | 'consumed_receipt';

export type SessionBackendContractFixture = {
  backend: SessionBackend;
  queueItem: MessageQueueItem;
  entry: SessionHistoryInput;
  /** Inspect logical rows by ID, including physical duplicate copies. */
  readCopies(turnId: string): Promise<readonly SessionHistoryInput[]>;
  readQueueCids(): Promise<readonly string[]>;
  readActivation(): Promise<string | undefined>;
  readPromotionRecord(operationId: string): Promise<SessionQueuePromotionRecord | undefined>;
  dispose?(): Promise<void>;
};

export type SessionBackendContractFixtureFactory = (options?: {
  failOnceAt?: QueuePromotionFailurePoint;
}) => Promise<SessionBackendContractFixture>;

/**
 * Backend-independent behavioral checks. An adapter test supplies real storage
 * plus one-shot failures at durable boundaries; assertions stay on logical state.
 */
export function defineSessionBackendContract(
  name: string,
  createFixture: SessionBackendContractFixtureFactory
): void {
  describe(`${name} session backend contract`, () => {
    it.each([
      'prepared_receipt',
      'history_acceptance',
      'history_receipt',
      'activation_publication',
      'activation_receipt',
      'queue_consumption',
      'consumed_receipt',
    ] as const)('recovers one logical turn after %s fails', async (failOnceAt) => {
      const fixture = await createFixture({ failOnceAt });
      try {
        const operationId = fixture.backend.getQueueOperationId(fixture.queueItem);
        const queueBefore = await fixture.readQueueCids();

        await expect(
          fixture.backend.promoteQueuedTurn({
            item: fixture.queueItem,
            entry: fixture.entry,
            operationId,
          })
        ).rejects.toThrow();

        await fixture.backend.promoteQueuedTurn({
          item: fixture.queueItem,
          entry: fixture.entry,
          operationId,
        });

        const copies = await fixture.readCopies(fixture.entry.id);
        expect(copies).toHaveLength(1);
        expect(copies[0]).toMatchObject({
          id: fixture.entry.id,
          role: fixture.entry.role,
          items: fixture.entry.items,
        });
        expect(await fixture.readQueueCids()).toEqual(
          queueBefore.filter((cid) => cid !== fixture.queueItem.$cid)
        );
        expect(await fixture.readActivation()).toBe(fixture.entry.id);
        expect(await fixture.readPromotionRecord(operationId)).toMatchObject({
          queueCid: fixture.queueItem.$cid,
          userTurnId: fixture.entry.id,
          state: 'queue_consumed',
        });
      } finally {
        await fixture.dispose?.();
      }
    });

    it('rejects an operation ID that does not identify the queue row without changing logical state', async () => {
      const fixture = await createFixture();
      try {
        const queueBefore = await fixture.readQueueCids();
        await expect(
          fixture.backend.promoteQueuedTurn({
            item: fixture.queueItem,
            entry: fixture.entry,
            operationId: 'queue:another-turn',
          })
        ).rejects.toThrow(/does not match queue row/);

        expect(await fixture.readCopies(fixture.entry.id)).toEqual([]);
        expect(await fixture.readQueueCids()).toEqual(queueBefore);
        expect(await fixture.readActivation()).toBeUndefined();
      } finally {
        await fixture.dispose?.();
      }
    });

    it('rejects a fork snapshot owned by another backend before importing it', async () => {
      const fixture = await createFixture();
      try {
        const otherBackend = fixture.backend.kind === 'loro' ? 'roost' : 'loro';

        await expect(
          fixture.backend.importForkHistory(
            {
              backendKind: otherBackend,
              history: [],
              storageSnapshot: {},
            },
            []
          )
        ).rejects.toThrow(
          `Cannot import ${otherBackend} fork snapshot into ${fixture.backend.kind}`
        );

        expect(await fixture.readCopies(fixture.entry.id)).toEqual([]);
      } finally {
        await fixture.dispose?.();
      }
    });
  });
}
