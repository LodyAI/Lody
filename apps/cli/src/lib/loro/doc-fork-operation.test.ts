import { describe, expect, it, vi } from 'vitest';
import { Loro } from 'loro-crdt';
import { createSessionMirror, type SessionForkOperation, type SessionId } from '@lody/shared';
import type { LoroRepo, RepoDocHandle } from 'loro-repo';
import type { Logger } from '@/utils/logger';
import { SessionDocument } from './doc';

const createDocument = () => {
  const doc = new SessionDocument({} as LoroRepo, 'fork-target' as SessionId, async () => {}, {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger);
  const loro = new Loro();
  doc.handle = { doc: loro } as RepoDocHandle;
  doc.mirror = createSessionMirror({
    doc: loro,
    initialState: {
      session: { id: doc.sessionId },
      history: [],
    },
  });
  return doc;
};

const operation = (phase: SessionForkOperation['phase']): SessionForkOperation => ({
  id: 'session-fork:fork-target',
  sourceSessionId: 'fork-source' as SessionId,
  sourceTurnId: 'assistant-turn-1',
  requestedByUserId: 'user-1',
  targetContext: 'new-worktree',
  capturedHeadSha: 'a'.repeat(40),
  sourceWasDirty: false,
  state: 'preparing',
  phase,
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
});

describe('SessionDocument fork operation', () => {
  it('clears the root map after commit and permits a later fork operation', () => {
    const doc = createDocument();

    doc.setForkOperation(operation('preparing-worktree'));
    doc.setForkOperation(operation('committing'));

    expect(() => doc.setForkOperation(undefined)).not.toThrow();
    expect(doc.getForkOperation()).toBeUndefined();
    expect(doc.handle?.doc.getMap('forkOperation').toJSON()).toEqual({});

    doc.setForkOperation(operation('preparing-worktree'));
    expect(doc.getForkOperation()).toEqual(operation('preparing-worktree'));
  });
});
