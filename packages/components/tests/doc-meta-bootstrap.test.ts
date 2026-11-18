import { describe, expect, it, vi } from 'vitest';
import { mergeBootstrapMetaCache } from '../src/lib/doc-meta-bootstrap';
import { LoroRepo } from 'loro-repo';
import {
  createLegacyWorkspaceDirectory,
  createObservedWorkspaceDirectory,
  createLegacyWorkspaceDirectoryReader,
} from '@lody/shared/workspace-directory';
import { listDocMetaEntries, readSessionAndMachineMetas } from '../src/lib/doc-meta-batch';
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
  it('keeps preview and schedule leaf metadata out of the actual background Session activity input', async () => {
    const repo = await LoroRepo.create({});
    try {
      for (const roomId of [
        'session-live',
        'preview-comment-live',
        'schedule-live',
        'session-comment-legacy',
        'machine-live',
      ])
        await repo.upsertDocMeta(roomId, { id: 'live', lastMessageAt: 50, title: roomId });
      const directory = createLegacyWorkspaceDirectory(repo);
      const before = await directory.listEntries();
      const activity = await readSessionAndMachineMetas(repo, undefined, directory);
      expect(Object.keys(activity.sessions)).toEqual(['session-live']);
      expect(Object.keys(activity.machines)).toEqual(['machine-live']);
      expect(activity.sessions['session-live']).toMatchObject({ id: 'live', lastMessageAt: 50 });
      expect(await directory.listEntries()).toEqual(before);
      expect(before.map((entry) => entry.docId)).toEqual(
        expect.arrayContaining(['preview-comment-live', 'schedule-live', 'session-comment-legacy'])
      );
    } finally {
      await repo.destroy();
    }
  });

  describe('listDocMetaEntries', () => {
    it.skipIf(typeof Reflect.get(LoroRepo, 'createWithExternalMetadata') !== 'function')(
      'reads external directory snapshots and live changes without opening raw Meta',
      async () => {
        let snapshot = {
          revision: 1,
          docs: [
            { docId: 'session-visible', deleted: false, meta: { title: 'Initial' } },
            { docId: 'session-deleted', deleted: true, meta: { title: 'Deleted' } },
          ],
          flockDocs: [],
        };
        let publish: ((event: { snapshot: typeof snapshot; by: 'sync' }) => void) | undefined;
        const repo: LoroRepo = await Reflect.apply(
          Reflect.get(LoroRepo, 'createWithExternalMetadata'),
          LoroRepo,
          [
            {},
            {
              capability: 'loro-external-metadata-v1',
              open: async (listener: typeof publish) => {
                publish = listener;
                return {
                  snapshot,
                  unsubscribe: () => {
                    publish = undefined;
                  },
                };
              },
              read: async () => snapshot,
              commit: async () => {
                throw new Error('Reader cannot author');
              },
              flush: async () => ({ outcome: 'committed', snapshot }),
            },
          ]
        );
        const directory = createObservedWorkspaceDirectory(repo, {
          listActiveIds: async () =>
            snapshot.docs.filter((row) => !row.deleted).map((row) => row.docId),
          listEntries: async () => snapshot.docs.map((row) => ({ ...row, exists: !row.deleted })),
        });
        const titles: string[] = [];
        const observation = directory.observe((event) => {
          if (event.kind === 'doc-metadata' && typeof event.patch.title === 'string')
            titles.push(event.patch.title);
        });
        try {
          expect(() => repo.getMeta()).toThrow('Legacy Meta Flock is unavailable');
          expect(await directory.listActiveIds()).toEqual(['session-visible']);
          expect(await directory.listEntries()).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ docId: 'session-deleted', deleted: true }),
            ])
          );
          expect((await directory.getEntry('session-visible'))?.meta.title).toBe('Initial');
          snapshot = {
            ...snapshot,
            revision: 2,
            docs: snapshot.docs.map((row) =>
              row.docId === 'session-visible' ? { ...row, meta: { title: 'Updated' } } : row
            ),
          };
          publish?.({ snapshot, by: 'sync' });
          expect((await directory.getEntry('session-visible'))?.meta.title).toBe('Updated');
          expect(titles).toEqual(['Updated']);
        } finally {
          observation.unsubscribe();
          await repo.destroy();
        }
      }
    );

    it('observes directory edits without opening document bodies and releases each reader independently', async () => {
      const repo = await LoroRepo.create({});
      const directory = createLegacyWorkspaceDirectory(repo);
      const first: string[] = [];
      const second: string[] = [];
      let changed!: () => void;
      const nextChange = () =>
        new Promise<void>((resolve) => {
          changed = resolve;
        });
      const a = directory.observe((event) => {
        if (event.kind === 'doc-metadata' && typeof event.patch.title === 'string') {
          first.push(event.patch.title);
        }
      });
      const b = directory.observe((event) => {
        if (event.kind === 'doc-metadata' && typeof event.patch.title === 'string') {
          second.push(event.patch.title);
          changed();
        }
      });
      try {
        const initial = nextChange();
        await repo.upsertDocMeta('session-observed', { title: 'First' });
        await initial;
        expect(await directory.getEntry('session-observed')).toMatchObject({
          docId: 'session-observed',
          meta: { title: 'First' },
          deleted: false,
        });
        a.unsubscribe();
        const renamed = nextChange();
        await repo.upsertDocMeta('session-observed', { title: 'Second' });
        await renamed;
        expect(first).toEqual(['First']);
        expect(second).toEqual(['First', 'Second']);
        await repo.deleteDoc('session-observed');
        expect(await directory.listActiveIds()).toEqual([]);
        expect((await directory.getEntry('session-observed'))?.deleted).toBe(true);
      } finally {
        a.unsubscribe();
        b.unsubscribe();
        await repo.destroy();
      }
    });
    it('shares active directory queries with the CLI contract without changing stored metadata', async () => {
      const repo = await LoroRepo.create({});
      try {
        await repo.upsertDocMeta('session-visible', {
          title: 'Visible',
          futureField: { retained: true },
        });
        await repo.upsertDocMeta('session-deleted', { title: 'Deleted' });
        await repo.deleteDoc('session-deleted');
        await repo.flush();
        const directory = createLegacyWorkspaceDirectoryReader(repo);
        expect(await directory.listActiveIds()).toEqual(['session-visible']);
        expect(await listDocMetaEntries(repo)).toEqual(await directory.listEntries());
        expect(await directory.listEntries()).toEqual([
          {
            docId: 'session-visible',
            exists: true,
            meta: { title: 'Visible', futureField: { retained: true } },
          },
        ]);
        await repo.upsertDocMeta('session-visible', { title: 'Renamed' });
        expect((await directory.listEntries())[0]?.meta).toEqual({
          title: 'Renamed',
          futureField: { retained: true },
        });
        expect((await repo.getDocMeta('session-visible'))?.meta).toEqual({
          title: 'Renamed',
          futureField: { retained: true },
        });
      } finally {
        await repo.destroy();
      }
    });

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
