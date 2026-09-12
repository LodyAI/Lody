import { describe, expect, it, vi } from 'vitest';

import { LoroRepo } from 'loro-repo';
import { v4 as uuidv4 } from 'uuid';

import { SessionDocument } from '../src/lib/loro/doc';
import type { MessageContent, SessionHistoryInput, SessionId } from '@lody/shared';

const createUserEntry = (id: string, text: string): SessionHistoryInput => ({
  id,
  role: 'user',
  items: [{ type: 'text', text }] satisfies MessageContent[],
  timestamp: new Date().toISOString(),
  status: 'pending',
  read: false,
  userId: undefined,
});

describe('SessionDocument auto read', () => {
  it('marks latest user entry as read on history updates', async () => {
    const repo = await LoroRepo.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });

      await doc.updateHistory((history) => history.concat(createUserEntry('h1', 'hi')));
      // Auto-read is a background port command now: wait for the accepted write
      // instead of assuming a single microtask.
      await vi.waitFor(async () => {
        expect((await doc.getHistory())[0]!.status).toBe('seen');
      });

      const history = await doc.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.role).toBe('user');
      expect(history[0]!.status).toBe('seen');
      expect(history[0]!.read).toBe(true);
    } finally {
      await repo.destroy();
    }
  });

  it('only marks the latest user entry when multiple are unread', async () => {
    const repo = await LoroRepo.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });

      await doc.updateHistory((history) =>
        history.concat([createUserEntry('h1', 'first'), createUserEntry('h2', 'second')])
      );
      await vi.waitFor(async () => {
        const current = await doc.getHistory();
        expect(current.find((entry) => entry.id === 'h2')?.status).toBe('seen');
      });

      const history = await doc.getHistory();
      expect(history).toHaveLength(2);
      const first = history.find((entry) => entry.id === 'h1');
      const second = history.find((entry) => entry.id === 'h2');
      expect(first?.status).toBe('pending');
      expect(first?.read).not.toBe(true);
      expect(second?.status).toBe('seen');
      expect(second?.read).toBe(true);
    } finally {
      await repo.destroy();
    }
  });

  it('can mark the latest user entry as read for existing history', async () => {
    const repo = await LoroRepo.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });
      await doc.updateHistory(() => [
        createUserEntry('h1', 'first'),
        createUserEntry('h2', 'second'),
      ]);
      await vi.waitFor(async () => {
        const current = await doc.getHistory();
        expect(current.find((entry) => entry.id === 'h2')?.status).toBe('seen');
      });

      const before = await doc.getHistory();
      expect(before).toHaveLength(2);
      const beforeFirst = before.find((entry) => entry.id === 'h1');
      const beforeSecond = before.find((entry) => entry.id === 'h2');
      expect(beforeFirst?.status).toBe('pending');
      expect(beforeFirst?.read).not.toBe(true);
      expect(beforeSecond?.status).toBe('seen');
      expect(beforeSecond?.read).toBe(true);

      await doc.markLatestUserHistoryAsSeenIfNeeded();

      const history = await doc.getHistory();
      expect(history).toHaveLength(2);
      const first = history.find((entry) => entry.id === 'h1');
      const second = history.find((entry) => entry.id === 'h2');
      expect(first?.status).toBe('pending');
      expect(first?.read).not.toBe(true);
      expect(second?.status).toBe('seen');
      expect(second?.read).toBe(true);
    } finally {
      await repo.destroy();
    }
  });

  it('does not pop the first queued message while it is being edited', async () => {
    const repo = await LoroRepo.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });

      await doc.pushMessageQueue({
        task: 'queued draft',
        project: undefined,
        userId: 'user-1',
        timestamp: new Date().toISOString(),
        isEditing: true,
        editingStartedAt: Date.now(),
        acpSessionConfig: {
          prompt: 'queued draft',
          inputBlocks: [{ type: 'text', text: 'queued draft' }],
          cliType: 'builtin',
          agentType: 'codex',
        },
      });

      await expect(doc.popMessageQueue()).resolves.toBeNull();
      await expect(doc.getMessageQueue()).resolves.toEqual([
        expect.objectContaining({
          task: 'queued draft',
          isEditing: true,
        }),
      ]);
    } finally {
      await repo.destroy();
    }
  });

  it('pops a queued message whose editing lease has expired', async () => {
    const repo = await LoroRepo.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });

      // editingStartedAt 10 minutes in the past — well past the 5-minute lease
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      await doc.pushMessageQueue({
        task: 'stuck draft',
        project: undefined,
        userId: 'user-1',
        timestamp: new Date().toISOString(),
        isEditing: true,
        editingStartedAt: tenMinutesAgo,
        acpSessionConfig: {
          prompt: 'stuck draft',
          inputBlocks: [{ type: 'text', text: 'stuck draft' }],
          cliType: 'builtin',
          agentType: 'codex',
        },
      });

      const popped = await doc.popMessageQueue();
      expect(popped?.task).toBe('stuck draft');
      await expect(doc.getMessageQueue()).resolves.toEqual([]);
    } finally {
      await repo.destroy();
    }
  });

  it('treats a missing editingStartedAt as an expired lease (legacy item)', async () => {
    const repo = await LoroRepo.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });

      await doc.pushMessageQueue({
        task: 'legacy draft',
        project: undefined,
        userId: 'user-1',
        timestamp: new Date().toISOString(),
        isEditing: true,
        acpSessionConfig: {
          prompt: 'legacy draft',
          inputBlocks: [{ type: 'text', text: 'legacy draft' }],
          cliType: 'builtin',
          agentType: 'codex',
        },
      });

      const popped = await doc.popMessageQueue();
      expect(popped?.task).toBe('legacy draft');
      await expect(doc.getMessageQueue()).resolves.toEqual([]);
    } finally {
      await repo.destroy();
    }
  });
});
