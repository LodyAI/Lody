import { describe, expect, it, vi } from 'vitest';
import type { SessionHistoryInput, SessionId } from '@lody/shared';
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
const createSessionDocument = (repo: Partial<LoroRepo>, loroDoc?: LoroDoc) => {
  const doc = new SessionDocument(
    repo as LoroRepo,
    'session-append-1' as SessionId,
    async () => {},
    createLogger()
  );
  const loro = composeTestSessionDoc(doc, loroDoc ? { doc: loroDoc } : undefined);
  return { doc, loro };
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
    const { doc } = createSessionDocument({}, loro);
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
