import { describe, expect, it, vi } from 'vitest';
import { getSessionRoomId, SessionStatusFactory, type SessionId } from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import type { LoroRepo } from 'loro-repo';

import type { Logger } from '@/utils/logger';
import { SessionDocument } from './doc';
import { composeTestSessionDoc } from '../../../tests/session-doc-fixture';

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const createSessionDocument = (
  repo: Partial<LoroRepo>,
  unloadDocRoom: (docId: string) => Promise<void> = async () => {},
  loroDoc?: LoroDoc
): SessionDocument => {
  const doc = new SessionDocument(
    repo as LoroRepo,
    'session-status-1' as SessionId,
    unloadDocRoom,
    createLogger()
  );
  // Compose the real production storage entry: control-plane Mirror, the one
  // shared HistoryWriter and the session-data seam over the same doc.
  composeTestSessionDoc(doc, loroDoc ? { doc: loroDoc } : undefined);
  return doc;
};

describe('SessionDocument status metadata', () => {
  it('rolls child lastMessageAt up to the parent session', async () => {
    const parentSessionId = 'parent-session-1' as SessionId;
    const childRoomId = getSessionRoomId('session-status-1' as SessionId);
    const parentRoomId = getSessionRoomId(parentSessionId);
    const upsertDocMeta = vi.fn(async () => {});
    const doc = createSessionDocument({
      getDocMeta: vi.fn(async (roomId: string) => {
        if (roomId === childRoomId) {
          return { meta: { parentSessionId } };
        }
        if (roomId === parentRoomId) {
          return { meta: { lastMessageAt: 1_000 } };
        }
        return { meta: {} };
      }),
      upsertDocMeta,
    });

    await doc.setLastMessageAt(2_000);

    expect(upsertDocMeta).toHaveBeenCalledWith(doc.roomId, {
      lastMessageAt: 2_000,
    });
    expect(upsertDocMeta).toHaveBeenCalledWith(parentRoomId, {
      lastMessageAt: 2_000,
    });
  });

  it('does not move parent lastMessageAt backwards', async () => {
    const parentSessionId = 'parent-session-1' as SessionId;
    const childRoomId = getSessionRoomId('session-status-1' as SessionId);
    const parentRoomId = getSessionRoomId(parentSessionId);
    const upsertDocMeta = vi.fn(async () => {});
    const doc = createSessionDocument({
      getDocMeta: vi.fn(async (roomId: string) => {
        if (roomId === childRoomId) {
          return { meta: { parentSessionId } };
        }
        if (roomId === parentRoomId) {
          return { meta: { lastMessageAt: 3_000 } };
        }
        return { meta: {} };
      }),
      upsertDocMeta,
    });

    await doc.setLastMessageAt(2_000);

    expect(upsertDocMeta).toHaveBeenCalledWith(doc.roomId, {
      lastMessageAt: 2_000,
    });
    expect(upsertDocMeta).not.toHaveBeenCalledWith(parentRoomId, expect.anything());
  });

  it('resets initializing status to idle during destroy without publishing presence', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const unloadDoc = vi.fn(async () => {});
    // Destroy must go through the injected unloader, never `repo.unloadDoc`
    // directly: the injected one also invalidates the local data-plane room
    // bound to the evicted `LoroDoc` instance
    // (`LoroDocumentManager.unloadDocRoom`).
    const unloadDocRoom = vi.fn(async () => {});
    const doc = createSessionDocument(
      {
        getDocMeta: vi.fn(async () => ({
          meta: {
            machineId: 'machine-1',
            status: SessionStatusFactory.initializing(),
          },
        })),
        unloadDoc,
        upsertDocMeta,
      },
      unloadDocRoom
    );

    await doc.destroy();

    expect(upsertDocMeta).toHaveBeenCalledWith(
      doc.roomId,
      expect.objectContaining({
        status: SessionStatusFactory.idle(),
      })
    );
    expect(unloadDocRoom).toHaveBeenCalledWith(doc.roomId);
    expect(unloadDoc).not.toHaveBeenCalled();
  });
});
