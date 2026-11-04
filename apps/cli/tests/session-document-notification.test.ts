import { publishTurnCompletionLegacy } from '../src/session/turn-completion-legacy';
import { resolveNotificationPresentation } from '@lody/shared/notifications';
import { describe, expect, it, vi } from 'vitest';
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

  it('publishes local completion without a remote transport and keeps delayed activity monotonic', async () => {
    const repo = await LoroRepo.create({});
    const parentId = uuid() as SessionId;
    const childId = uuid() as SessionId;
    const parent = new SessionDocument(repo, parentId, (roomId) => repo.unloadDoc(roomId));
    const child = new SessionDocument(repo, childId, (roomId) => repo.unloadDoc(roomId));
    const notifications: string[] = [];
    try {
      await parent.initOffline();
      await child.initOffline();
      await repo.upsertDocMeta(getSessionRoomId(parentId), { type: 'session', lastMessageAt: 1 });
      await repo.upsertDocMeta(getSessionRoomId(childId), {
        type: 'session',
        parentSessionId: parentId,
        lastMessageAt: 1,
      });
      await publishTurnCompletionLegacy({
        sessionDoc: child,
        workspaceDocument: { getRemoteStreamsGeneration: () => undefined },
        completedAt: 100,
        signal: new AbortController().signal,
        notify: async () => {
          notifications.push('local');
        },
      });
      expect(notifications).toEqual(['local']);
      expect((await child.getMetaState())?.lastMessageAt).toBe(100);
      expect((await parent.getMetaState())?.lastMessageAt).toBe(100);
      await Promise.all([
        child.setLastMessageAt(300),
        parent.setLastMessageAt(400),
        child.setLastMessageAt(200),
      ]);
      expect((await child.getMetaState())?.lastMessageAt).toBe(300);
      expect((await parent.getMetaState())?.lastMessageAt).toBe(400);
    } finally {
      await parent.destroy({ preserveStatus: true });
      await child.destroy({ preserveStatus: true });
      await repo.destroy();
    }
  });

  it('does not turn an old remote receipt into local success after transport replacement', async () => {
    const repo = await LoroRepo.create({});
    const id = uuid() as SessionId;
    const session = new SessionDocument(repo, id, (roomId) => repo.unloadDoc(roomId));
    const confirming = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<boolean>();
    let generation = 1;
    const notifications: string[] = [];
    try {
      await session.initOffline();
      await repo.upsertDocMeta(getSessionRoomId(id), { type: 'session', lastMessageAt: 1 });
      vi.useFakeTimers();
      session.waitUntilSynced = async () => {
        confirming.resolve();
        return receipt.promise;
      };
      const result = publishTurnCompletionLegacy({
        sessionDoc: session,
        workspaceDocument: { getRemoteStreamsGeneration: () => generation },
        completedAt: 100,
        signal: new AbortController().signal,
        notify: async () => {
          notifications.push('remote');
        },
      }).then(
        () => 'published',
        (error) => error
      );
      await confirming.promise;
      generation = 2;
      receipt.resolve(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({ _tag: 'TurnCompletionUnconfirmed' });
      expect(notifications).toEqual([]);
      expect((await session.getMetaState())?.lastMessageAt).toBe(1);
    } finally {
      receipt.resolve(true);
      vi.useRealTimers();
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
