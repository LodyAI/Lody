import { describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import {
  getShortcutBodyStreamId,
  getShortcutIndexStreamId,
  getShortcutResourceStreamId,
  getWorkspaceShortcutBodyStreamId,
  getWorkspaceShortcutIndexStreamId,
  LocalShortcutStore,
  parsePromptShortcut,
  parseShortcutIndex,
  projectShortcutIndex,
  PromptShortcutCatalog,
  PromptShortcutDocument,
  PromptShortcutRuntime,
  ShortcutSyncTransportError,
  type PromptShortcut,
  type ShortcutResource,
} from '../src/prompt-shortcuts';

function makeShortcut(overrides: Partial<PromptShortcut> = {}): PromptShortcut {
  return {
    v: 1,
    id: 'sc-1',
    workspaceId: 'ws-1',
    ownerUserId: 'user-1',
    name: 'Review PR',
    slug: 'review-pr',
    prompt: 'Review the diff carefully.',
    mentions: [],
    scope: {},
    revision: 'rev-1',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe('Prompt Shortcuts UserSpace stream naming & schema compatibility', () => {
  it('places workspace shortcut streams under the {workspaceId}: UserSpace prefix', () => {
    expect(getWorkspaceShortcutIndexStreamId('ws_abc123')).toBe('ws_abc123:shortcut-index');
    expect(getWorkspaceShortcutBodyStreamId('ws_abc123', 'doc-1')).toBe('ws_abc123:shortcut:doc-1');
    expect(getShortcutResourceStreamId({ kind: 'workspace-index', workspaceId: 'ws_abc123' })).toBe(
      'ws_abc123:shortcut-index'
    );
    expect(
      getShortcutResourceStreamId({
        kind: 'workspace-body',
        workspaceId: 'ws_abc123',
        bodyDocId: 'doc-1',
      })
    ).toBe('ws_abc123:shortcut:doc-1');
  });

  it('strips legacy visibility on stored bodies and index entries while keeping strict validation', () => {
    const legacyRaw = {
      ...makeShortcut(),
      visibility: 'private',
    };
    const parsed = parsePromptShortcut(legacyRaw);
    expect('visibility' in parsed).toBe(false);

    const legacyIndexRaw = {
      ...projectShortcutIndex(parsed, 'body-1'),
      visibility: 'workspace',
    };
    const parsedIndex = parseShortcutIndex(legacyIndexRaw);
    expect('visibility' in parsedIndex).toBe(false);
    expect(JSON.stringify(projectShortcutIndex(parsed, 'body-1'))).toBe(
      JSON.stringify(parsedIndex)
    );

    expect(() =>
      parsePromptShortcut({
        ...makeShortcut(),
        unexpectedField: true,
      })
    ).toThrow();
  });
});

describe('LocalShortcutStore in-place bodyDocId lifecycle', () => {
  it('keeps bodyDocId stable across saves and preparePublication without rotating UUIDs', async () => {
    const repo = await LoroRepo.create({});
    const store = await LocalShortcutStore.open({
      repo,
      workspaceId: 'ws-1',
      userId: 'user-1',
    });
    try {
      const first = makeShortcut({ id: 'sc-stable', revision: 'rev-1' });
      const saved1 = await store.save({ value: first, base: null });
      expect(saved1.entry.bodyDocId).toBe('sc-stable');

      const pub1 = await store.preparePublication('sc-stable');
      expect(pub1?.entry.bodyDocId).toBe('sc-stable');
      await store.acknowledge(pub1!);

      const second = {
        ...first,
        prompt: 'Updated prompt v2',
        revision: 'rev-2',
        updatedAt: 200,
      };
      const saved2 = await store.save({
        value: second,
        base: saved1.entry,
      });
      expect(saved2.entry.bodyDocId).toBe('sc-stable');

      const pub2 = await store.preparePublication('sc-stable');
      expect(pub2?.entry.bodyDocId).toBe('sc-stable');
      await store.acknowledge(pub2!);

      const readBack = await store.read(saved2.entry);
      expect(readBack.prompt).toBe('Updated prompt v2');
      expect(readBack.revision).toBe('rev-2');
    } finally {
      await store.dispose();
      await repo.destroy();
    }
  });
});

describe('PromptShortcutRuntime workspace writes & Phase 1 dual-read', () => {
  async function createCloudHarness(userId = 'user-1') {
    const serverRepo = await LoroRepo.create({});
    const clientRepo = await LoroRepo.create({});
    const acquired: Array<{ streamId: string; write: boolean }> = [];
    const existingStreams = new Set<string>();
    const revokedLegacy: unknown[] = [];

    const syncStream = async (streamId: string, write: boolean, isFlock: boolean) => {
      if (!write && !existingStreams.has(streamId)) {
        throw new ShortcutSyncTransportError('stream_not_found', `Missing ${streamId}`);
      }
      existingStreams.add(streamId);
      if (isFlock) {
        const s = await serverRepo.acquireFlockDoc(streamId);
        const c = await clientRepo.acquireFlockDoc(streamId);
        try {
          if (write) {
            s.flock.importFile(c.flock.exportFile());
          }
          c.flock.importFile(s.flock.exportFile());
        } finally {
          await c.release();
          await s.release();
        }
      } else {
        const s = await serverRepo.acquireDoc(streamId);
        const c = await clientRepo.acquireDoc(streamId);
        try {
          if (write) {
            s.doc.import(c.doc.export({ mode: 'snapshot' }));
          }
          c.doc.import(s.doc.export({ mode: 'snapshot' }));
        } finally {
          await c.release();
          await s.release();
        }
      }
    };

    const store = await LocalShortcutStore.open({
      repo: clientRepo,
      workspaceId: 'ws-1',
      userId,
    });
    const runtime = new PromptShortcutRuntime(store, {
      acquire: async (resource: ShortcutResource, write: boolean) => {
        const streamId = getShortcutResourceStreamId(resource);
        const isFlock = resource.kind === 'workspace-index' || resource.kind === 'index';
        acquired.push({ streamId, write });
        return {
          sync: () => syncStream(streamId, write, isFlock),
          join: async () => {},
          release: async () => {},
        };
      },
      revokeLegacy: async (entry) => {
        revokedLegacy.push(entry);
      },
      dispose: async () => {},
    });

    return {
      serverRepo,
      clientRepo,
      store,
      runtime,
      acquired,
      existingStreams,
      revokedLegacy,
      cleanup: async () => {
        await runtime.dispose();
        await clientRepo.destroy();
        await serverRepo.destroy();
      },
    };
  }

  it('publishes creates and updates in-place to {workspaceId}:shortcut-index and {workspaceId}:shortcut:{bodyDocId}', async () => {
    const h = await createCloudHarness();
    try {
      await h.runtime.start();
      const v1 = makeShortcut({ id: 'sc-new', revision: 'rev-1' });
      const entry1 = await h.runtime.save({ value: v1, base: null });
      await h.runtime.flush();
      expect(h.runtime.getSnapshot().errors).toEqual({});

      expect(entry1.bodyDocId).toBe('sc-new');
      expect(h.existingStreams.has('ws-1:shortcut-index')).toBe(true);
      expect(h.existingStreams.has('ws-1:shortcut:sc-new')).toBe(true);
      expect(
        h.acquired.some(
          (call) =>
            call.streamId.startsWith('shortcut-index:') ||
            call.streamId.startsWith('shortcut-body:')
        )
      ).toBe(false);

      // Update in-place: bodyDocId stays identical and updates the same stream.
      const v2 = { ...v1, prompt: 'Second version', revision: 'rev-2', updatedAt: 200 };
      const entry2 = await h.runtime.save({ value: v2, base: entry1 });
      await h.runtime.flush();
      expect(h.runtime.getSnapshot().errors).toEqual({});

      expect(entry2.bodyDocId).toBe('sc-new');
      const serverBody = await h.serverRepo.acquireDoc('ws-1:shortcut:sc-new');
      try {
        const saved = new PromptShortcutDocument(serverBody.doc).read();
        expect(saved?.revision).toBe('rev-2');
        expect(saved?.prompt).toBe('Second version');
      } finally {
        await serverBody.release();
      }
    } finally {
      await h.cleanup();
    }
  });

  it('dual-reads unmigrated legacy shortcuts and prefers workspace-index entries and tombstones', async () => {
    const h = await createCloudHarness('viewer-user');
    try {
      await h.runtime.start();
      // Seed legacy index + legacy body on server (with legacy visibility field).
      const legacyDomain = {
        workspaceId: 'ws-1',
        ownerUserId: 'author-user',
        visibility: 'workspace' as const,
      };
      const legacyIndexStream = getShortcutIndexStreamId(legacyDomain);
      const legacyBodyStream = getShortcutBodyStreamId('legacy-body-1');
      h.existingStreams.add(legacyIndexStream);
      h.existingStreams.add(legacyBodyStream);

      const legacyShortcut = makeShortcut({
        id: 'sc-legacy',
        ownerUserId: 'author-user',
        slug: 'legacy-cmd',
        prompt: 'Legacy body text',
        revision: 'rev-legacy',
      });
      const sBody = await h.serverRepo.acquireDoc(legacyBodyStream);
      try {
        new PromptShortcutDocument(sBody.doc).save(legacyShortcut, []);
      } finally {
        await sBody.release();
      }
      const sIndex = await h.serverRepo.acquireFlockDoc(legacyIndexStream);
      try {
        sIndex.flock.set(['promptShortcut', 'sc-legacy'], {
          kind: 'active',
          entry: {
            ...projectShortcutIndex(legacyShortcut, 'legacy-body-1'),
            visibility: 'workspace',
          },
        });
        sIndex.flock.commit();
      } finally {
        await sIndex.release();
      }

      await h.runtime.setDirectory([
        {
          shortcutId: 'sc-legacy',
          bodyDocId: 'legacy-body-1',
          ownerUserId: 'author-user',
          visibility: 'workspace',
          revision: 'rev-legacy',
        },
      ]);

      expect(h.runtime.getSnapshot().entries.map((e) => e.id)).toEqual(['sc-legacy']);
      const readLegacy = await h.runtime.read(h.runtime.getSnapshot().entries[0]!);
      expect(readLegacy.prompt).toBe('Legacy body text');

      // Once tombstoned in {workspaceId}:shortcut-index, legacy entry disappears immediately.
      h.existingStreams.add('ws-1:shortcut-index');
      const wsIndex = await h.serverRepo.acquireFlockDoc('ws-1:shortcut-index');
      try {
        new PromptShortcutCatalog(wsIndex.flock).remove('sc-legacy', 'rev-del');
      } finally {
        await wsIndex.release();
      }
      const cWsIndex = await h.clientRepo.acquireFlockDoc('ws-1:shortcut-index');
      try {
        const wsServer = await h.serverRepo.acquireFlockDoc('ws-1:shortcut-index');
        try {
          cWsIndex.flock.importFile(wsServer.flock.exportFile());
        } finally {
          await wsServer.release();
        }
      } finally {
        await cWsIndex.release();
      }
      expect(h.runtime.getSnapshot().entries).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
});
