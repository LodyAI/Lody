import { describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { v4 as uuid } from 'uuid';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { SessionDocument } from '../src/lib/loro/doc';

describe('terminal notification projection', () => {
  it('publishes a small discovery index and replaces only the latest projection', async () => {
    const repo = await LoroRepo.create({});
    const id = uuid() as SessionId;
    const session = new SessionDocument(repo, id);
    try {
      await session.initOffline({ history: [] });
      await repo.upsertDocMeta(getSessionRoomId(id), { type: 'session' });
      const first = {
        id: uuid(),
        recipientId: 'user',
        turnId: 'turn-1',
        outcome: 'failed' as const,
        createdAt: 100,
      };
      await session.publishTerminalNotification(first);
      expect((await session.getDocState())?.notification).toEqual(first);
      expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta.notificationId).toBe(first.id);
      const second = { ...first, id: uuid(), turnId: 'turn-2', outcome: 'succeeded' as const };
      await session.publishTerminalNotification(second);
      expect((await session.getDocState())?.notification).toEqual(second);
      expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta.notificationId).toBe(second.id);
      expect(await session.sessionData.history.readAll()).toEqual([]);
    } finally {
      await repo.destroy();
    }
  });
});
