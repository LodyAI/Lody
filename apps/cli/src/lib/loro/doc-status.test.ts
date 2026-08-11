import { describe, expect, it, vi } from 'vitest';
import { getSessionRoomId, SessionStatusFactory, type SessionId } from '@lody/shared';
import { LoroDoc, LoroMap } from 'loro-crdt';
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

const createSessionDocument = (
  repo: Partial<LoroRepo>,
  unloadDocRoom: (docId: string) => Promise<void> = async () => {}
): SessionDocument => {
  const doc = new SessionDocument(
    repo as LoroRepo,
    'session-status-1' as SessionId,
    unloadDocRoom,
    createLogger()
  );
  doc.mirror = {
    dispose: vi.fn(),
  } as SessionDocument['mirror'];
  return doc;
};

describe('SessionDocument status metadata', () => {
  it('writes lastRunningSeen together with active statuses', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const doc = createSessionDocument({
      getDocMeta: vi.fn(async () => ({ meta: {} })),
      upsertDocMeta,
    });

    await doc.setStatus(SessionStatusFactory.running());

    expect(upsertDocMeta).toHaveBeenCalledWith(
      doc.roomId,
      expect.objectContaining({
        status: SessionStatusFactory.running(),
        lastRunningSeen: expect.any(Number),
      })
    );
  });

  it('does not refresh lastRunningSeen when setting idle', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const doc = createSessionDocument({
      getDocMeta: vi.fn(async () => ({ meta: {} })),
      upsertDocMeta,
    });

    await doc.setStatus(SessionStatusFactory.idle());

    expect(upsertDocMeta).toHaveBeenCalledWith(doc.roomId, {
      status: SessionStatusFactory.idle(),
    });
  });

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

  it('deletes the key instead of persisting null when unsetting a history entry field', () => {
    // Raw LoroMap writes bypass loro-mirror's undefined-stripping; `set(field,
    // undefined)` would persist null and break strict readers.
    const doc = createSessionDocument({});
    const loroDoc = new LoroDoc();
    const entry = loroDoc.getList('history').insertContainer(0, new LoroMap());
    entry.set('id', 'entry-1');
    entry.set('role', 'assistant');
    entry.set('fileDiff', [{ path: 'a.ts', add: 1, del: 0 }]);
    doc.handle = { doc: loroDoc } as SessionDocument['handle'];

    expect(doc.setHistoryEntryField('entry-1', 'fileDiff', undefined)).toBe(true);

    const readBack = loroDoc.getList('history').get(0) as LoroMap;
    expect(readBack.keys()).not.toContain('fileDiff');
    expect(readBack.get('fileDiff')).toBeUndefined();

    expect(doc.setLatestAssistantHistoryFileDiff(undefined, 'entry-1')).toBe(true);
    expect((loroDoc.getList('history').get(0) as LoroMap).keys()).not.toContain('fileDiff');
  });

  it('derives stable turn storage metadata from the associated user entry', () => {
    const doc = createSessionDocument({});
    const loroDoc = new LoroDoc();
    const history = loroDoc.getList('history');
    const userEntry = history.insertContainer(0, new LoroMap());
    userEntry.set('id', 'user-1');
    userEntry.set('role', 'user');
    userEntry.set('timestamp', '2026-08-04T03:02:00.000Z');
    const entry = history.insertContainer(1, new LoroMap());
    entry.set('id', 'entry-1');
    entry.set('role', 'assistant');
    entry.set('userTurnId', 'user-1');
    entry.set('timestamp', '2026-08-04T03:02:01.000Z');
    doc.handle = { doc: loroDoc } as SessionDocument['handle'];

    const capturedAtMs = Date.parse('2026-08-04T03:02:00.000Z');
    expect(doc.getAssistantHistoryEntryTurnStorageMetadata('entry-1')).toEqual({
      capturedAtMs,
      orderKey: `${capturedAtMs.toString().padStart(16, '0')}:${doc.sessionId}:0000000001:entry-1`,
    });
    expect(doc.getAssistantHistoryEntryTurnStorageMetadata('missing')).toBeUndefined();
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
