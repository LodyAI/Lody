import { describe, expect, it, vi } from 'vitest';
import type { SessionHistoryInput, SessionId } from '@lody/shared';
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
