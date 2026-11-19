import { describe, expect, it, vi } from 'vitest';
import { mergeBootstrapMetaCache } from '../src/lib/doc-meta-bootstrap';
import type { LoroRepo } from 'loro-repo';
import { listDocMetaEntries } from '../src/lib/doc-meta-batch';
import {
  planPullRequestLifecycle,
  resolveSessionPullRequests,
  getSessionRoomId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { createStore } from 'jotai';
import {
  childSessionsAtomFamily,
  sessionListAtom,
  sessionMetaCacheAtom,
  sideSessionsAtomFamily,
} from '../src/atoms/doc-meta';
import { sessionHasUnreadMessages } from '../src/lib/session-read-receipt';

describe('doc-meta-bootstrap', () => {
  describe('mergeBootstrapMetaCache', () => {
    it('keeps snapshot fields when live cache only has a partial patch', () => {
      const merged = mergeBootstrapMetaCache(
        {
          'session-1': {
            id: 'session-1',
            title: 'Synced title',
            status: { type: 'running' },
          },
        },
        {
          'session-1': {
            id: 'session-1',
            status: { type: 'idle' },
          },
        }
      );

      expect(merged['session-1']).toEqual({
        id: 'session-1',
        title: 'Synced title',
        status: { type: 'idle' },
      });
    });

    it('drops docs marked deleted while bootstrap scan was still in flight', () => {
      const merged = mergeBootstrapMetaCache(
        {
          'session-1': {
            id: 'session-1',
            title: 'Should disappear',
          },
        },
        {},
        new Map([['session-1', 'deleted']])
      );

      expect(merged['session-1']).toBeUndefined();
    });

    it('keeps snapshot docs when the existence marker was cleared during bootstrap', () => {
      const merged = mergeBootstrapMetaCache(
        {
          'session-1': {
            id: 'session-1',
            title: 'Should stay visible',
          },
        },
        {},
        new Map([['session-1', 'missing']])
      );

      expect(merged['session-1']).toEqual({
        id: 'session-1',
        title: 'Should stay visible',
      });
    });

    it('keeps live docs that became active during bootstrap even if snapshot missed them', () => {
      const merged = mergeBootstrapMetaCache(
        {},
        {
          'session-2': {
            id: 'session-2',
            title: 'Restored task',
          },
        },
        new Map([['session-2', 'active']])
      );

      expect(merged['session-2']).toEqual({
        id: 'session-2',
        title: 'Restored task',
      });
    });
  });
});

describe('doc-meta-batch', () => {
  describe('listDocMetaEntries', () => {
    it('skips metadata rows without an active existence marker', async () => {
      const scan = vi.fn(async ({ prefix }: { prefix?: readonly unknown[] } = {}) => {
        if (prefix?.[0] === 'm') {
          return [
            { key: ['m', 'machine-active'], value: { id: 'machine-active' } },
            { key: ['m', 'machine-metadata-only'], value: { id: 'machine-metadata-only' } },
            { key: ['m', 'machine-deleted'], value: { id: 'machine-deleted' } },
            { key: ['m', 'machine-missing'], value: { id: 'machine-missing' } },
          ];
        }
        if (prefix?.[0] === 'e') {
          return [
            { key: ['e', 'machine-active'], value: true },
            { key: ['e', 'machine-deleted'], value: false },
            { key: ['e', 'machine-missing'] },
          ];
        }
        return [];
      });
      const repo = {
        getMeta: () => ({ scan }),
        listDoc: vi.fn(async () => []),
      } as unknown as LoroRepo;

      await expect(listDocMetaEntries(repo)).resolves.toEqual([
        {
          docId: 'machine-active',
          exists: true,
          meta: { id: 'machine-active' },
        },
      ]);
    });

    it('reads external metadata through listDoc when the repo has no legacy Meta Flock', async () => {
      // Native Workspace Meta: loro-repo's getter throws in external metadata mode.
      const repo = {
        getMeta: () => {
          throw new Error('Legacy Meta Flock is unavailable in external metadata mode');
        },
        listDoc: vi.fn(async () => [{ docId: 'session-a', meta: { id: 'a' } }]),
      } as unknown as LoroRepo;

      await expect(listDocMetaEntries(repo)).resolves.toEqual([
        { docId: 'session-a', meta: { id: 'a' } },
      ]);
    });
  });
});

describe('doc-meta-session-list', () => {
  const sessionId = 'session-with-ci' as SessionId;
  const roomId = getSessionRoomId(sessionId);
  const prUrl = 'https://github.com/loro-dev/lody/pull/42';

  const session: SessionMeta = {
    id: sessionId,
    machineId: 'machine-1' as MachineId,
    createdAt: '2026-07-19T00:00:00.000Z',
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'codex',
    pullRequests: [{ url: prUrl, status: 'open' }],
  };

  describe('sessionListAtom', () => {
    it('updates unread presentation when only the tab closure changes', () => {
      const store = createStore();
      const unread = { ...session, lastMessageAt: 200, lastReadAt: 100 };
      store.set(sessionMetaCacheAtom, { [roomId]: unread });
      expect(sessionHasUnreadMessages(store.get(sessionListAtom)[0]!)).toBe(true);
      store.set(sessionMetaCacheAtom, { [roomId]: { ...unread, isTabClosed: true } });
      expect(sessionHasUnreadMessages(store.get(sessionListAtom)[0]!)).toBe(false);
      store.set(sessionMetaCacheAtom, { [roomId]: { ...unread, isTabClosed: false } });
      expect(sessionHasUnreadMessages(store.get(sessionListAtom)[0]!)).toBe(true);
    });

    it('publishes a new list when only pullRequestState changes', () => {
      const store = createStore();
      store.set(sessionMetaCacheAtom, { [roomId]: session });
      const before = store.get(sessionListAtom);

      store.set(sessionMetaCacheAtom, {
        [roomId]: {
          ...session,
          pullRequestState: { [prUrl]: { s: 's', m: 'c', t: 1_752_000_000 } },
        },
      });
      const after = store.get(sessionListAtom);

      expect(after).not.toBe(before);
      expect(after[0]?.pullRequestState?.[prUrl]?.s).toBe('s');
    });

    it('projects side sessions into the right-panel list instead of child tabs', () => {
      const store = createStore();
      const parentId = 'parent-session' as SessionId;
      const childId = 'child-session' as SessionId;
      const sideId = 'side-session' as SessionId;
      store.set(sessionMetaCacheAtom, {
        [getSessionRoomId(parentId)]: { ...session, id: parentId },
        [getSessionRoomId(childId)]: {
          ...session,
          id: childId,
          parentSessionId: parentId,
        },
        [getSessionRoomId(sideId)]: {
          ...session,
          id: sideId,
          parentSessionId: parentId,
          childSessionPlacement: 'side-panel',
        },
      });

      expect(store.get(childSessionsAtomFamily(parentId)).map((item) => item.id)).toEqual([
        childId,
      ]);
      expect(store.get(sideSessionsAtomFamily(parentId)).map((item) => item.id)).toEqual([sideId]);
      expect(store.get(sessionListAtom).map((item) => item.id)).toEqual([parentId]);
    });

    it('orders child tabs by creation time when no local tab order exists', () => {
      const store = createStore();
      const parentId = 'parent-session' as SessionId;
      const olderChildId = 'older-child' as SessionId;
      const newerChildId = 'newer-child' as SessionId;

      store.set(sessionMetaCacheAtom, {
        [getSessionRoomId(parentId)]: { ...session, id: parentId },
        [getSessionRoomId(newerChildId)]: {
          ...session,
          id: newerChildId,
          parentSessionId: parentId,
          createdAt: '2026-07-19T00:02:00.000Z',
        },
        [getSessionRoomId(olderChildId)]: {
          ...session,
          id: olderChildId,
          parentSessionId: parentId,
          createdAt: '2026-07-19T00:01:00.000Z',
        },
      });

      expect(store.get(childSessionsAtomFamily(parentId)).map((item) => item.id)).toEqual([
        olderChildId,
        newerChildId,
      ]);
    });
  });

  it('refreshes sidebar lifecycle without association writes and suppresses revision-only renders', () => {
    const store = createStore();
    store.set(sessionMetaCacheAtom, { [roomId]: session });
    const before = store.get(sessionListAtom);
    const first = planPullRequestLifecycle(
      { url: prUrl, status: 'merged', updatedAt: '2026-01-01T00:00:00Z' },
      undefined,
      'webhook'
    )!;
    store.set(sessionMetaCacheAtom, { [roomId]: { ...session, [first.field]: first.value } });
    const after = store.get(sessionListAtom);
    expect(after).not.toBe(before);
    expect(resolveSessionPullRequests(after[0])[0]?.status).toBe('merged');
    expect(after[0]?.pullRequests).toEqual(session.pullRequests);
    const next = planPullRequestLifecycle(
      { url: prUrl, status: 'merged', updatedAt: '2026-01-02T00:00:00Z' },
      undefined,
      'webhook'
    )!;
    store.set(sessionMetaCacheAtom, { [roomId]: { ...session, [next.field]: next.value } });
    expect(store.get(sessionListAtom)).toBe(after);
  });

  it('excludes noncontained and cross-machine records from a root history tab projection', () => {
    const store = createStore();
    const parentId = 'parent' as SessionId;
    const parent = { ...session, id: parentId };
    const make = (id: string, extra: object) =>
      ({ ...session, id, parentSessionId: parentId, ...extra }) as unknown as SessionMeta;
    const valid = make('tab', {});
    const unknown = make('independent', { childSessionPlacement: 'sidebar' });
    const foreign = make('foreign', { machineId: 'another-machine' });
    const opened = make('opened', { parentSessionId: undefined, openedBySessionId: parentId });
    store.set(
      sessionMetaCacheAtom,
      Object.fromEntries(
        [parent, valid, unknown, foreign, opened].map((meta) => [getSessionRoomId(meta.id), meta])
      )
    );
    expect(store.get(childSessionsAtomFamily(parentId)).map((meta) => meta.id)).toEqual(['tab']);
  });
});
