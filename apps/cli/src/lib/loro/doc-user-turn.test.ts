import { describe, expect, it, vi } from 'vitest';
import { createSessionMirror, type SessionHistoryInput, type SessionId } from '@lody/shared';
import { LoroDoc, LoroList, LoroMap } from 'loro-crdt';
import type { LoroRepo } from 'loro-repo';

import type { Logger } from '@/utils/logger';
import { SessionDocument } from './doc';

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

/**
 * Builds a real `SessionDocument` over a stub mirror so the binding's own body
 * runs; `history` mirrors what the CRDT would hold.
 */
const createSessionDocument = (repo: Partial<LoroRepo>) => {
  const state: { history: SessionHistoryInput[] } = { history: [] };
  const doc = new SessionDocument(
    repo as LoroRepo,
    'session-append-1' as SessionId,
    async () => {},
    createLogger()
  );
  doc.mirror = {
    setState: (updateFn: (prev: typeof state) => typeof state) => {
      updateFn(state);
    },
  } as unknown as SessionDocument['mirror'];
  return { doc, state };
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
    const { doc } = createSessionDocument({});
    doc.mirror = null;
    const loro = new LoroDoc();
    createSessionMirror({
      doc: loro,
      initialState: { session: { id: 'session-append-1' as SessionId }, history: [] },
    }).dispose();
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
    // Exercise the actual CLI constructor hook without unrelated repo/network startup.
    (doc as unknown as { createMirror(handle: { doc: LoroDoc }): void }).createMirror({
      doc: loro,
    });
    expect(loro.version().toJSON()).toEqual(version);
    expect(loro.getList('history').toJSON()).toEqual(history);
    doc.mirror?.dispose();
  });

  it('rejects malformed history before publishing dispatch through the real writer', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const { doc } = createSessionDocument({ upsertDocMeta });
    const loro = new LoroDoc();
    doc.mirror = createSessionMirror({
      doc: loro,
      initialState: { session: { id: 'session-append-1' as SessionId }, history: [] },
    });
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
    doc.mirror.dispose();
  });

  it('publishes the dispatch pointer together with the history entry', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const { doc, state } = createSessionDocument({ upsertDocMeta });

    await doc.appendUserTurn(createUserTurn('turn-1'));

    expect(state.history.map((entry) => entry.id)).toEqual(['turn-1']);
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
    const { doc, state } = createSessionDocument({ upsertDocMeta });

    await expect(
      doc.appendUserTurn({ ...createUserTurn('turn-3'), role: 'assistant' })
    ).rejects.toThrow(/requires a user entry/);
    expect(state.history).toEqual([]);
    expect(upsertDocMeta).not.toHaveBeenCalled();
  });
});
