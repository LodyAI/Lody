import { describe, expect, it, vi } from 'vitest';
import {
  getServerNow,
  queueItemRevision,
  type MessageQueueItem,
  type SessionHistoryInput,
  type SessionId,
} from '@lody/shared';
import { LoroDoc, LoroList, LoroMap } from 'loro-crdt';
import type { LoroRepo } from 'loro-repo';

import type { Logger } from '@/utils/logger';
import { SessionDocument } from './doc';
import { composeTestSessionDoc } from '../../../tests/session-doc-fixture';

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

/**
 * Builds a real `SessionDocument` composed over a real `LoroDoc` through
 * `composeSessionData`, so append/validation paths run against the production
 * storage entry. `loro.toJSON().history` is the stored state and
 * `doc.readHistorySnapshot()` reads it back through the session-data seam.
 */
const createSessionDocument = (
  repo: Partial<LoroRepo>,
  options: {
    loroDoc?: LoroDoc;
  } = {}
) => {
  const doc = new SessionDocument(
    repo as LoroRepo,
    'session-append-1' as SessionId,
    async () => {},
    createLogger()
  );
  const loro = composeTestSessionDoc(doc, {
    ...(options.loroDoc ? { doc: options.loroDoc } : {}),
  });
  return { doc, loro };
};

const seedMessageQueue = async (
  doc: SessionDocument,
  items: Array<Omit<MessageQueueItem, '$cid'>>
): Promise<MessageQueueItem[]> => {
  for (const item of items) await doc.pushMessageQueue(item);
  return await doc.getMessageQueue();
};

const createUserTurn = (id: string): SessionHistoryInput => ({
  id,
  role: 'user',
  items: [{ type: 'text', text: 'hello' }],
  timestamp: new Date().toISOString(),
  status: 'pending',
  read: false,
  userId: 'user-1',
});

describe('SessionDocument.consumeMessageQueueItemAsUserTurn', () => {
  it('rejects stale edits, missing rows and stale reorder snapshots without losing accepted content', async () => {
    const { doc } = createSessionDocument({ upsertDocMeta: async () => {} });
    const rows = await seedMessageQueue(
      doc,
      ['A', 'B', 'C'].map((task) => ({
        task,
        userId: 'user-1',
        timestamp: '2026-09-14T00:00:00.000Z',
      }))
    );
    const selected = rows[2]!;
    const update = {
      kind: 'update' as const,
      queueItemId: selected.$cid,
      expectedRevision: queueItemRevision(selected),
      patch: { task: 'Roll back instead' },
    };
    await doc.mutateMessageQueue(update);
    await expect(
      doc.mutateMessageQueue({ ...update, patch: { task: 'Stale edit' } })
    ).rejects.toThrow('changed');
    expect((await doc.getMessageQueue())[2]?.task).toBe('Roll back instead');
    await doc.removeMessageQueueItem(selected.$cid);
    await expect(doc.mutateMessageQueue(update)).rejects.toThrow('no longer');
    await expect(
      doc.mutateMessageQueue({
        kind: 'reorder',
        expectedItemIds: rows.map((row) => row.$cid),
        orderedItemIds: rows.map((row) => row.$cid).reverse(),
      })
    ).rejects.toThrow('changed');
    expect((await doc.getMessageQueue()).map((row) => row.task)).toEqual(['A', 'B']);
  });
  it('consumes the named later row after activation without reordering the survivors', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const { doc } = createSessionDocument({ upsertDocMeta });
    const queue = await seedMessageQueue(
      doc,
      ['A', 'B', 'C'].map((label) => ({
        task: `task ${label}`,
        timestamp: '2026-09-13T00:00:00.000Z',
      }))
    );
    const target = queue[2]!;

    const result = await doc.consumeMessageQueueItemAsUserTurn(target.$cid, () =>
      createUserTurn('user:C')
    );

    expect(result).toMatchObject({ type: 'consumed', entry: { id: 'user:C' } });
    expect((await doc.sessionData.history.readAll()).map((entry) => entry.id)).toEqual(['user:C']);
    expect((await doc.getMessageQueue()).map((item) => item.task)).toEqual(['task A', 'task B']);
    expect(upsertDocMeta).toHaveBeenCalledWith(doc.roomId, { latestUserMsgId: 'user:C' });
  });

  it('retains the queue row and resumes publication without duplicating history', async () => {
    const upsertDocMeta = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockResolvedValue(undefined);
    const { doc } = createSessionDocument({ upsertDocMeta });
    const [target] = await seedMessageQueue(doc, [
      {
        task: 'task C',
        timestamp: '2026-09-13T00:00:00.000Z',
      },
    ]);

    await expect(
      doc.consumeMessageQueueItemAsUserTurn(target!.$cid, () => createUserTurn('user:C'))
    ).rejects.toThrow('metadata unavailable');
    expect((await doc.sessionData.history.readAll()).map((entry) => entry.id)).toEqual(['user:C']);
    expect((await doc.getMessageQueue()).map((item) => item.task)).toEqual(['task C']);

    await expect(
      doc.consumeMessageQueueItemAsUserTurn(target!.$cid, () => createUserTurn('user:C'))
    ).resolves.toMatchObject({ type: 'consumed', entry: { id: 'user:C' } });
    expect((await doc.sessionData.history.readAll()).map((entry) => entry.id)).toEqual(['user:C']);
    expect(await doc.getMessageQueue()).toEqual([]);
    expect(upsertDocMeta).toHaveBeenCalledTimes(2);
  });

  it('does not write history or a dispatch pointer when the identity is absent', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const { doc } = createSessionDocument({ upsertDocMeta });
    await seedMessageQueue(doc, [
      {
        task: 'task A',
        timestamp: '2026-09-13T00:00:00.000Z',
      },
    ]);

    await expect(
      doc.consumeMessageQueueItemAsUserTurn('missing', () => createUserTurn('user:C'))
    ).resolves.toEqual({ type: 'missing' });
    expect(await doc.sessionData.history.readAll()).toEqual([]);
    expect((await doc.getMessageQueue()).map((item) => item.task)).toEqual(['task A']);
    expect(upsertDocMeta).not.toHaveBeenCalled();
  });

  it('does not consume an item while another client holds its editing lease', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const { doc } = createSessionDocument({ upsertDocMeta });
    const queue = await seedMessageQueue(doc, [
      {
        task: 'task C',
        timestamp: '2026-09-13T00:00:00.000Z',
        isEditing: true,
        editingStartedAt: getServerNow(),
      },
    ]);
    const target = queue[0]!;

    await expect(
      doc.consumeMessageQueueItemAsUserTurn(target.$cid, () => createUserTurn('user:C'))
    ).resolves.toEqual({ type: 'editing' });
    expect(await doc.sessionData.history.readAll()).toEqual([]);
    expect((await doc.getMessageQueue()).map((item) => item.task)).toEqual(['task C']);
    expect(upsertDocMeta).not.toHaveBeenCalled();
  });

  it('can reserve an exact item for native steer without publishing ordinary dispatch', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const { doc } = createSessionDocument({ upsertDocMeta });
    const queue = await seedMessageQueue(doc, [
      {
        task: 'task C',
        timestamp: '2026-09-13T00:00:00.000Z',
      },
    ]);
    const target = queue[0]!;

    await expect(
      doc.consumeMessageQueueItemAsUserTurn(
        target.$cid,
        () => ({ ...createUserTurn('user:C'), status: 'pending_apply' }),
        { publishDispatch: false }
      )
    ).resolves.toMatchObject({ type: 'consumed', entry: { id: 'user:C' } });
    await expect(
      doc.consumeMessageQueueItemAsUserTurn(
        target.$cid,
        () => ({ ...createUserTurn('user:C'), status: 'pending_apply' }),
        { publishDispatch: false }
      )
    ).resolves.toMatchObject({ type: 'consumed', entry: { id: 'user:C' } });
    expect((await doc.sessionData.history.readAll()).map((entry) => entry.id)).toEqual(['user:C']);
    expect((await doc.getMessageQueue()).map((item) => item.task)).toEqual(['task C']);
    expect(upsertDocMeta).not.toHaveBeenCalled();
  });
});

describe('SessionDocument.appendUserTurn', () => {
  it('opens old malformed notices without sanitizing stored history', () => {
    const loro = new LoroDoc();
    const row = loro.getList('history').pushContainer(new LoroMap());
    row.set('id', 'legacy');
    row.set('role', 'assistant');
    row.set('timestamp', 'synthetic');
    const notice = row.setContainer('items', new LoroList()).pushContainer(new LoroMap());
    notice.set('type', 'system_notice');
    notice.set('name', 'future_notice');
    notice.set('meta', 42);
    loro.commit();
    const version = loro.version().toJSON();
    const history = loro.getList('history').toJSON();
    // Exercise the actual production composition over pre-existing storage.
    const { doc } = createSessionDocument({}, { loroDoc: loro });
    expect(loro.version().toJSON()).toEqual(version);
    expect(loro.getList('history').toJSON()).toEqual(history);
    doc.mirror?.dispose();
  });

  it('rejects malformed history before publishing dispatch through the real writer', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const { doc, loro } = createSessionDocument({ upsertDocMeta });
    const version = loro.version().toJSON();
    await expect(
      doc.appendUserTurn({
        ...createUserTurn('bad'),
        items: [{ type: 'text' }],
      } as SessionHistoryInput)
    ).rejects.toThrow('Invalid history write');
    expect(loro.version().toJSON()).toEqual(version);
    expect(upsertDocMeta).not.toHaveBeenCalled();
    await doc.appendUserTurn(createUserTurn('valid'));
    expect(loro.toJSON().history[0].id).toBe('valid');
    expect(upsertDocMeta).toHaveBeenCalledWith(doc.roomId, { latestUserMsgId: 'valid' });
  });

  it('publishes the dispatch pointer together with the history entry', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const { doc } = createSessionDocument({ upsertDocMeta });

    await doc.appendUserTurn(createUserTurn('turn-1'));

    expect((await doc.sessionData.history.readAll()).map((entry) => entry.id)).toEqual(['turn-1']);
    expect(upsertDocMeta).toHaveBeenCalledWith(doc.roomId, { latestUserMsgId: 'turn-1' });
  });

  it('does not clear the missing-history marker', async () => {
    // Clearing it belongs to producers that first supersede the acknowledged
    // entry; appending a new turn does not, so the stale copy must stay skipped.
    const upsertDocMeta = vi.fn(async () => {});
    const { doc } = createSessionDocument({ upsertDocMeta });

    await doc.appendUserTurn(createUserTurn('turn-2'));

    expect(upsertDocMeta.mock.calls[0]?.[1]).not.toHaveProperty('lastMissingHistoryUserMsgId');
  });

  it('rejects a non-user entry instead of publishing a pointer for it', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const { doc } = createSessionDocument({ upsertDocMeta });

    await expect(
      doc.appendUserTurn({ ...createUserTurn('turn-3'), role: 'assistant' })
    ).rejects.toThrow(/requires a user entry/);
    expect(await doc.sessionData.history.readAll()).toEqual([]);
    expect(upsertDocMeta).not.toHaveBeenCalled();
  });
});
