import { resolveNotificationPresentation } from '@lody/shared/notifications';
import { describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { v4 as uuid } from 'uuid';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { SessionDocument } from '../src/lib/loro/doc';

describe('terminal notification projection', () => {
  it('preserves scheduled input identity through the real history writer without marking later human inputs', async () => {
    const repo = await LoroRepo.create({});
    const id = uuid() as SessionId;
    const session = new SessionDocument(repo, id, (roomId) => repo.unloadDoc(roomId));
    try {
      await session.initOffline({ history: [] });
      const scheduled = {
        id: 'scheduled',
        role: 'user' as const,
        timestamp: '2026-10-18T00:00:00Z',
        fileDiff: [],
        scheduleRun: { scheduleId: 'daily', turnId: 'scheduled', title: 'Daily check' },
      };
      await session.sessionData.commands.appendTurn(scheduled);
      await session.sessionData.commands.appendTurn({
        ...scheduled,
        id: 'manual',
        scheduleRun: undefined,
      });
      const original = await session.sessionData.history.readTurn('scheduled');
      const manual = await session.sessionData.history.readTurn('manual');
      expect(original.state).toBe('ready');
      expect(manual.state).toBe('ready');
      if (original.state !== 'ready' || manual.state !== 'ready') throw new Error('Missing inputs');
      expect(
        resolveNotificationPresentation({ title: 'Conversation' }, [original.turn])
      ).toMatchObject({
        kind: 'schedule',
        conversationTitle: 'Conversation',
        scheduleName: 'Daily check',
      });
      expect(
        resolveNotificationPresentation({ title: 'Conversation' }, [manual.turn])
      ).toMatchObject({
        kind: 'conversation',
        conversationTitle: 'Conversation',
        scheduleName: undefined,
      });
    } finally {
      await session.destroy({ preserveStatus: true });
      await repo.destroy();
    }
  });

  it('publishes a small discovery index and replaces only the latest projection', async () => {
    const repo = await LoroRepo.create({});
    const id = uuid() as SessionId;
    const session = new SessionDocument(repo, id, (roomId) => repo.unloadDoc(roomId));
    try {
      await session.initOffline({ history: [] });
      await repo.upsertDocMeta(getSessionRoomId(id), { type: 'session' });
      const first = {
        id: uuid(),
        recipientId: 'user',
        turnId: 'turn-1',
        outcome: 'failed' as const,
        presentation: {
          kind: 'schedule' as const,
          conversationTitle: 'Dependency review',
          scheduleName: 'Daily review',
          projectName: 'lody',
          pullRequestNumber: 1555,
        },
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
      await session.destroy({ preserveStatus: true });
      await repo.destroy();
    }
  });
});
