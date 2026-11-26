import { describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { createCipheriv, createDecipheriv } from 'node:crypto';
const capturedStreamsCrdtOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('../src/streams-crdt-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/streams-crdt-factory')>();
  return {
    ...actual,
    createStreamsCrdt: (options: Parameters<typeof actual.createStreamsCrdt>[0]) => {
      capturedStreamsCrdtOptions.push(options);
      return actual.createStreamsCrdt(options);
    },
  };
});
import { PromptShortcutSync } from '../src/prompt-shortcuts/sync';
import {
  encryptedWorkspaceResolver,
  type WorkspaceStreamsContent,
} from '../src/workspace-streams-content';
import {
  encodeStreamsRoomAdditionalData,
  type StreamsRoomIdentity,
} from 'loro-repo/transport/streams';
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
    const leaseOps: Array<{ streamId: string; op: 'sync' | 'join' | 'release' }> = [];
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
          sync: async () => {
            leaseOps.push({ streamId, op: 'sync' });
            await syncStream(streamId, write, isFlock);
          },
          join: async () => {
            leaseOps.push({ streamId, op: 'join' });
            await syncStream(streamId, write, isFlock);
          },
          release: async () => {
            leaseOps.push({ streamId, op: 'release' });
          },
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
      leaseOps,
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

describe('PromptShortcut phase-0 HTTP reduction', () => {
  it('joins workspace-index directly without pre-syncing and pulls legacy index via one-shot sync without join', async () => {
    const serverRepo = await LoroRepo.create({});
    const clientRepo = await LoroRepo.create({});
    const leaseOps: Array<{ streamId: string; op: 'sync' | 'join' | 'release' }> = [];
    const store = await LocalShortcutStore.open({
      repo: clientRepo,
      workspaceId: 'ws-opt',
      userId: 'viewer-user',
    });
    const legacyDomain = {
      workspaceId: 'ws-opt',
      ownerUserId: 'author-user',
      visibility: 'workspace' as const,
    };
    const legacyIndexStream = getShortcutIndexStreamId(legacyDomain);
    const legacyShortcut = makeShortcut({
      id: 'sc-leg-1',
      workspaceId: 'ws-opt',
      ownerUserId: 'author-user',
      slug: 'leg-cmd',
      prompt: 'Legacy text',
      revision: 'rev-leg',
    });
    const sLeg = await serverRepo.acquireFlockDoc(legacyIndexStream);
    try {
      sLeg.flock.set(['promptShortcut', 'sc-leg-1'], {
        kind: 'active',
        entry: { ...projectShortcutIndex(legacyShortcut, 'leg-body-1'), visibility: 'workspace' },
      });
      sLeg.flock.commit();
    } finally {
      await sLeg.release();
    }

    const syncStream = async (streamId: string, isFlock: boolean) => {
      if (!isFlock) return;
      const s = await serverRepo.acquireFlockDoc(streamId);
      const c = await clientRepo.acquireFlockDoc(streamId);
      try {
        c.flock.importFile(s.flock.exportFile());
      } finally {
        await c.release();
        await s.release();
      }
    };

    const runtime = new PromptShortcutRuntime(store, {
      acquire: async (resource, _write) => {
        const streamId = getShortcutResourceStreamId(resource);
        const isFlock = resource.kind === 'workspace-index' || resource.kind === 'index';
        return {
          sync: async () => {
            leaseOps.push({ streamId, op: 'sync' });
            await syncStream(streamId, isFlock);
          },
          join: async () => {
            leaseOps.push({ streamId, op: 'join' });
            await syncStream(streamId, isFlock);
          },
          release: async () => {
            leaseOps.push({ streamId, op: 'release' });
          },
        };
      },
      dispose: async () => {},
    });

    try {
      await runtime.start();
      await runtime.setDirectory([
        {
          shortcutId: 'sc-leg-1',
          bodyDocId: 'leg-body-1',
          ownerUserId: 'author-user',
          visibility: 'workspace',
          revision: 'rev-leg',
        },
      ]);

      const wsIndexOps = leaseOps
        .filter((x) => x.streamId === 'ws-opt:shortcut-index')
        .map((x) => x.op);
      expect(wsIndexOps).toEqual(['join']);

      const legacyOps = leaseOps.filter((x) => x.streamId === legacyIndexStream).map((x) => x.op);
      expect(legacyOps).toEqual(['sync', 'release']);
      expect(runtime.getSnapshot().entries.map((e) => e.id)).toEqual(['sc-leg-1']);
    } finally {
      await runtime.dispose();
      await clientRepo.destroy();
      await serverRepo.destroy();
    }
  });

  it('re-syncs legacy index when directory signature updates while an earlier sync is in flight', async () => {
    const clientRepo = await LoroRepo.create({});
    const serverRepo = await LoroRepo.create({});
    const leaseOps: Array<{ streamId: string; op: 'sync' | 'join' | 'release' }> = [];
    const store = await LocalShortcutStore.open({
      repo: clientRepo,
      workspaceId: 'ws-race',
      userId: 'viewer-user',
    });
    const legacyDomain = {
      workspaceId: 'ws-race',
      ownerUserId: 'author-user',
      visibility: 'workspace' as const,
    };
    const legacyIndexStream = getShortcutIndexStreamId(legacyDomain);
    const rev1Shortcut = makeShortcut({
      id: 'sc-race-1',
      workspaceId: 'ws-race',
      ownerUserId: 'author-user',
      slug: 'race-cmd',
      prompt: 'Prompt v1',
      revision: 'rev-1',
    });
    const rev2Shortcut = makeShortcut({
      id: 'sc-race-1',
      workspaceId: 'ws-race',
      ownerUserId: 'author-user',
      slug: 'race-cmd',
      prompt: 'Prompt v2',
      revision: 'rev-2',
    });

    const writeServerEntry = async (shortcut: PromptShortcut, bodyDocId: string) => {
      const sLeg = await serverRepo.acquireFlockDoc(legacyIndexStream);
      try {
        sLeg.flock.set(['promptShortcut', shortcut.id], {
          kind: 'active',
          entry: { ...projectShortcutIndex(shortcut, bodyDocId), visibility: 'workspace' },
        });
        sLeg.flock.commit();
      } finally {
        await sLeg.release();
      }
    };
    await writeServerEntry(rev1Shortcut, 'body-1');

    let firstSyncStartedResolve!: () => void;
    const firstSyncStarted = new Promise<void>((r) => {
      firstSyncStartedResolve = r;
    });
    let releaseFirstSync!: () => void;
    const firstSyncGate = new Promise<void>((r) => {
      releaseFirstSync = r;
    });
    let legacySyncCount = 0;

    const syncStream = async (streamId: string, isFlock: boolean) => {
      if (!isFlock) return;
      if (streamId === legacyIndexStream) {
        legacySyncCount++;
        if (legacySyncCount === 1) {
          firstSyncStartedResolve();
          await firstSyncGate;
        }
      }
      const s = await serverRepo.acquireFlockDoc(streamId);
      const c = await clientRepo.acquireFlockDoc(streamId);
      try {
        c.flock.importFile(s.flock.exportFile());
      } finally {
        await c.release();
        await s.release();
      }
    };

    const runtime = new PromptShortcutRuntime(store, {
      acquire: async (resource, _write) => {
        const streamId = getShortcutResourceStreamId(resource);
        const isFlock = resource.kind === 'workspace-index' || resource.kind === 'index';
        return {
          sync: async () => {
            leaseOps.push({ streamId, op: 'sync' });
            await syncStream(streamId, isFlock);
          },
          join: async () => {
            leaseOps.push({ streamId, op: 'join' });
            await syncStream(streamId, isFlock);
          },
          release: async () => {
            leaseOps.push({ streamId, op: 'release' });
          },
        };
      },
      dispose: async () => {},
    });

    try {
      await runtime.start();
      const p1 = runtime.setDirectory([
        {
          shortcutId: 'sc-race-1',
          bodyDocId: 'body-1',
          ownerUserId: 'author-user',
          visibility: 'workspace',
          revision: 'rev-1',
        },
      ]);
      await firstSyncStarted;

      await writeServerEntry(rev2Shortcut, 'body-2');
      const p2 = runtime.setDirectory([
        {
          shortcutId: 'sc-race-1',
          bodyDocId: 'body-2',
          ownerUserId: 'author-user',
          visibility: 'workspace',
          revision: 'rev-2',
        },
      ]);

      releaseFirstSync();
      await Promise.all([p1, p2]);

      const legacyOps = leaseOps.filter((x) => x.streamId === legacyIndexStream).map((x) => x.op);
      expect(legacyOps).toEqual(['sync', 'release', 'sync', 'release']);
      expect(runtime.getSnapshot().entries.map((e) => e.revision)).toEqual(['rev-2']);
    } finally {
      await runtime.dispose();
      await clientRepo.destroy();
      await serverRepo.destroy();
    }
  });

  it('uses shared workspace webSocketAuth that survives PromptShortcutSync disposal and isolates pool when omitted', async () => {
    const repo = await LoroRepo.create({});
    capturedStreamsCrdtOptions.length = 0;
    const sharedWsAuth = vi.fn(async () => 'ws-shared-token');
    const sharedSync = new PromptShortcutSync({
      content: { mode: 'plaintext' },
      repo,
      workspaceId: 'ws-pool',
      webSocketEnabled: true,
      webSocketAuth: sharedWsAuth,
      now: () => 0,
      grant: async (resource) => ({
        token: 'shortcut-token',
        expiresIn: 300,
        gatewayBaseUrl: 'https://gateway.test',
        streamId: getShortcutResourceStreamId(resource),
      }),
    });
    const isolatedSync = new PromptShortcutSync({
      content: { mode: 'plaintext' },
      repo,
      workspaceId: 'ws-pool',
      webSocketEnabled: true,
      now: () => 0,
      grant: async (resource) => ({
        token: 'shortcut-token',
        expiresIn: 300,
        gatewayBaseUrl: 'https://gateway.test',
        streamId: getShortcutResourceStreamId(resource),
      }),
    });

    try {
      const resource = { kind: 'workspace-index', workspaceId: 'ws-pool' } as const;
      const sharedLease = await sharedSync.acquire(resource, false);
      const sharedOpts = capturedStreamsCrdtOptions.at(-1) as {
        webSocket?: { enabled?: boolean; authPoolKey?: string; auth?: unknown };
      };
      expect(sharedOpts.webSocket).toMatchObject({
        enabled: true,
        authPoolKey: 'ws-pool',
        auth: sharedWsAuth,
      });

      const isolatedLease = await isolatedSync.acquire(resource, false);
      const isolatedOpts = capturedStreamsCrdtOptions.at(-1) as {
        webSocket?: { enabled?: boolean; authPoolKey?: string; auth?: unknown };
      };
      expect(isolatedOpts.webSocket?.enabled).toBe(true);
      expect(isolatedOpts.webSocket?.authPoolKey).not.toBe('ws-pool');
      expect(isolatedOpts.webSocket?.authPoolKey).toMatch(/^ws-pool:shortcut:/);

      await sharedLease.release();
      await isolatedLease.release();
      await sharedSync.dispose();
      await isolatedSync.dispose();

      const capturedAuth = sharedOpts.webSocket?.auth as (ctx: {
        reason: 'request' | 'renew' | 'reauth';
        previousToken?: string;
      }) => Promise<string>;
      await expect(capturedAuth({ reason: 'renew', previousToken: 'old' })).resolves.toBe(
        'ws-shared-token'
      );
      expect(sharedWsAuth).toHaveBeenCalledTimes(1);
    } finally {
      await sharedSync.dispose();
      await isolatedSync.dispose();
      await repo.destroy();
    }
  });

  it('completes concurrent read and write workspace-index acquisitions and disposal without deadlocking', async () => {
    const repo = await LoroRepo.create({});
    let resolveReadGrant!: () => void;
    let resolveWriteGrant!: () => void;
    const readGrantGate = new Promise<void>((resolve) => {
      resolveReadGrant = resolve;
    });
    const writeGrantGate = new Promise<void>((resolve) => {
      resolveWriteGrant = resolve;
    });
    const sync = new PromptShortcutSync({
      content: { mode: 'plaintext' },
      repo,
      workspaceId: 'ws-mode',
      now: () => 0,
      grant: async (resource, write) => {
        await (write ? writeGrantGate : readGrantGate);
        return {
          token: 'shortcut-token',
          expiresIn: 300,
          gatewayBaseUrl: 'https://gateway.test',
          streamId: getShortcutResourceStreamId(resource),
        };
      },
    });
    const resource = { kind: 'workspace-index', workspaceId: 'ws-mode' } as const;
    try {
      const readPending = sync.acquire(resource, false);
      const writePending = sync.acquire(resource, true);
      resolveReadGrant();
      resolveWriteGrant();
      const [readLease, writeLease] = await Promise.all([readPending, writePending]);
      await readLease.release();
      await writeLease.release();
    } finally {
      await sync.dispose();
      await repo.destroy();
    }
  });

  it('keeps workspace-index live updates active after a read-only runtime upgrades to writable and publishes', async () => {
    const clientRepo = await LoroRepo.create({});
    const serverRepo = await LoroRepo.create({});
    const store = await LocalShortcutStore.open({
      repo: clientRepo,
      workspaceId: 'ws-upgrade',
      userId: 'user-1',
    });
    let canWrite = false;
    const indexStreamId = getWorkspaceShortcutIndexStreamId('ws-upgrade');

    type RoomState = {
      write: boolean;
      refs: number;
      joined: boolean;
      closed: boolean;
    };
    const rooms = new Map<string, RoomState>();
    const activeJoinedSubscribers = new Set<RoomState>();

    const syncStream = async (streamId: string, write: boolean, isFlock: boolean) => {
      if (isFlock) {
        const s = await serverRepo.acquireFlockDoc(streamId);
        const c = await clientRepo.acquireFlockDoc(streamId);
        try {
          if (write) s.flock.importFile(c.flock.exportFile());
          c.flock.importFile(s.flock.exportFile());
        } finally {
          await c.release();
          await s.release();
        }
      } else {
        const s = await serverRepo.acquireDoc(streamId);
        const c = await clientRepo.acquireDoc(streamId);
        try {
          if (write) s.doc.import(c.doc.export({ mode: 'snapshot' }));
          c.doc.import(s.doc.export({ mode: 'snapshot' }));
        } finally {
          await c.release();
          await s.release();
        }
      }
    };

    const runtime = new PromptShortcutRuntime(store, {
      canWrite: () => canWrite,
      acquire: async (resource, write) => {
        const streamId = getShortcutResourceStreamId(resource);
        const isFlock = resource.kind === 'workspace-index' || resource.kind === 'index';
        const key = `${write ? 'w' : 'r'}:${streamId}`;
        let room = rooms.get(key);
        if (!room) {
          room = { write, refs: 0, joined: false, closed: false };
          rooms.set(key, room);
        }
        const captured = room;
        captured.refs++;
        let released = false;
        return {
          sync: async () => {
            if (released || captured.closed) throw new Error('Shortcut room closed');
            await syncStream(streamId, write, isFlock);
          },
          join: async () => {
            if (released || captured.closed) throw new Error('Shortcut room closed');
            await syncStream(streamId, write, isFlock);
            captured.joined = true;
            if (resource.kind === 'workspace-index') activeJoinedSubscribers.add(captured);
          },
          release: async () => {
            if (released) return;
            released = true;
            captured.refs--;
            if (captured.refs === 0 && rooms.get(key) === captured) {
              rooms.delete(key);
              captured.closed = true;
              captured.joined = false;
              activeJoinedSubscribers.delete(captured);
            }
          },
        };
      },
      dispose: async () => {
        rooms.clear();
        activeJoinedSubscribers.clear();
      },
    });

    try {
      // Guest starts with a read-only live workspace-index subscription.
      await runtime.start();
      expect([...activeJoinedSubscribers].map((r) => r.write)).toEqual([false]);

      // Role upgrades to writable on the same runtime; user publishes a shortcut.
      canWrite = true;
      await runtime.save({
        value: makeShortcut({
          id: 'sc-promoted',
          workspaceId: 'ws-upgrade',
          slug: 'promoted',
          revision: 'rev-1',
        }),
        base: null,
      });
      await runtime.flush();
      expect(runtime.getSnapshot().errors).toEqual({});

      // After publication releases its temporary write lease, a live write subscription must remain active.
      expect([...activeJoinedSubscribers].map((r) => r.write)).toEqual([true]);

      // Simulate another device pushing a new shortcut to the server index; only delivered if live subscription is active.
      const remoteEntry = projectShortcutIndex(
        makeShortcut({
          id: 'sc-peer',
          workspaceId: 'ws-upgrade',
          ownerUserId: 'peer-user',
          name: 'Peer Shortcut',
          slug: 'peer-shortcut',
          revision: 'rev-peer',
        }),
        'sc-peer'
      );
      const sIndex = await serverRepo.acquireFlockDoc(indexStreamId);
      try {
        new PromptShortcutCatalog(sIndex.flock).put(remoteEntry);
      } finally {
        await sIndex.release();
      }
      if (activeJoinedSubscribers.size > 0) {
        await syncStream(indexStreamId, false, true);
      }

      expect(
        runtime
          .getSnapshot()
          .entries.map((e) => e.id)
          .sort()
      ).toEqual(['sc-peer', 'sc-promoted']);
    } finally {
      await runtime.dispose();
      await clientRepo.destroy();
      await serverRepo.destroy();
    }
  });

  it('keeps the original read-only subscription untouched if write grant or gateway join fails after role upgrade', async () => {
    const clientRepo = await LoroRepo.create({});
    const serverRepo = await LoroRepo.create({});
    const store = await LocalShortcutStore.open({
      repo: clientRepo,
      workspaceId: 'ws-upgrade-fail',
      userId: 'user-1',
    });
    let canWrite = false;
    let failWriteAcquire = false;
    let gatewayDown = false;
    const indexStreamId = getWorkspaceShortcutIndexStreamId('ws-upgrade-fail');

    type RoomState = { write: boolean; refs: number; closed: boolean };
    const rooms = new Map<string, RoomState>();
    const activeJoined = new Set<RoomState>();

    const syncStream = async (streamId: string, write: boolean, isFlock: boolean) => {
      if (isFlock) {
        const s = await serverRepo.acquireFlockDoc(streamId);
        const c = await clientRepo.acquireFlockDoc(streamId);
        try {
          if (write) s.flock.importFile(c.flock.exportFile());
          c.flock.importFile(s.flock.exportFile());
        } finally {
          await c.release();
          await s.release();
        }
      } else {
        const s = await serverRepo.acquireDoc(streamId);
        const c = await clientRepo.acquireDoc(streamId);
        try {
          if (write) s.doc.import(c.doc.export({ mode: 'snapshot' }));
          c.doc.import(s.doc.export({ mode: 'snapshot' }));
        } finally {
          await c.release();
          await s.release();
        }
      }
    };

    const runtime = new PromptShortcutRuntime(store, {
      canWrite: () => canWrite,
      acquire: async (resource, write) => {
        const streamId = getShortcutResourceStreamId(resource);
        const isFlock = resource.kind === 'workspace-index' || resource.kind === 'index';
        if (resource.kind === 'workspace-index' && write && failWriteAcquire) {
          throw new Error('write grant unavailable');
        }
        const key = `${write ? 'w' : 'r'}:${streamId}`;
        let room = rooms.get(key);
        if (!room) {
          room = { write, refs: 0, closed: false };
          rooms.set(key, room);
        }
        const captured = room;
        captured.refs++;
        let released = false;
        return {
          sync: async () => {
            if (released || captured.closed) throw new Error('Shortcut room closed');
            await syncStream(streamId, write, isFlock);
          },
          join: async () => {
            if (released || captured.closed) throw new Error('Shortcut room closed');
            if (resource.kind === 'workspace-index' && gatewayDown) {
              throw new Error('gateway unavailable');
            }
            await syncStream(streamId, write, isFlock);
            if (resource.kind === 'workspace-index') activeJoined.add(captured);
          },
          release: async () => {
            if (released) return;
            released = true;
            captured.refs--;
            if (captured.refs === 0 && rooms.get(key) === captured) {
              rooms.delete(key);
              captured.closed = true;
              activeJoined.delete(captured);
            }
          },
        };
      },
      dispose: async () => {
        rooms.clear();
        activeJoined.clear();
      },
    });

    try {
      await runtime.start();
      const initialReadRoom = [...activeJoined][0];
      expect(initialReadRoom?.write).toBe(false);

      // 1) Write grant fails: original read subscription stays untouched.
      canWrite = true;
      failWriteAcquire = true;
      await runtime.save({
        value: makeShortcut({
          id: 'sc-pending',
          workspaceId: 'ws-upgrade-fail',
          slug: 'pending',
          revision: 'rev-1',
        }),
        base: null,
      });
      await runtime.flush();
      expect(runtime.getSnapshot().errors['sc-pending']).toBeInstanceOf(Error);
      expect([...activeJoined]).toEqual([initialReadRoom]);

      // 2) Full gateway outage covers write join() (even read join() would fail):
      // original read subscription is NEVER closed, so when gateway recovers it still delivers updates.
      failWriteAcquire = false;
      gatewayDown = true;
      await runtime.flush();
      expect(runtime.getSnapshot().errors['sc-pending']).toBeInstanceOf(Error);
      expect(initialReadRoom.closed).toBe(false);
      expect([...activeJoined]).toEqual([initialReadRoom]);

      gatewayDown = false;
      const peer = projectShortcutIndex(
        makeShortcut({
          id: 'sc-peer-after-outage',
          workspaceId: 'ws-upgrade-fail',
          ownerUserId: 'peer-user',
          name: 'Peer After Outage',
          slug: 'peer-after-outage',
          revision: 'rev-peer',
        }),
        'sc-peer-after-outage'
      );
      const sIndex = await serverRepo.acquireFlockDoc(indexStreamId);
      try {
        new PromptShortcutCatalog(sIndex.flock).put(peer);
      } finally {
        await sIndex.release();
      }
      if (activeJoined.size > 0) await syncStream(indexStreamId, false, true);
      expect(runtime.getSnapshot().entries.some((e) => e.id === 'sc-peer-after-outage')).toBe(true);
    } finally {
      await runtime.dispose();
      await clientRepo.destroy();
      await serverRepo.destroy();
    }
  });
});

describe('encrypted Prompt Shortcuts', () => {
  const resource = { kind: 'workspace-body', workspaceId: 'ws-1', bodyDocId: 'sc-1' } as const;
  const grant = {
    token: 'synthetic',
    expiresIn: 300,
    gatewayBaseUrl: 'https://gateway.test',
    bucketId: 'encrypted-content',
    streamId: getShortcutResourceStreamId(resource),
  };
  const protectedContent: WorkspaceStreamsContent = {
    mode: 'protected',
    namespace: 'synthetic-namespace',
    snapshotUpload: { canUpload: () => false },
    resolve: () => {
      throw new Error('Unexpected protection acquisition');
    },
  };

  it('refuses legacy resources, missing/plaintext buckets, unprotected rooms and guest write acquisitions before opening storage', async () => {
    const repo = await LoroRepo.create({});
    try {
      for (const bucketId of [undefined, 'lody', 'encrypted-content']) {
        const sync = new PromptShortcutSync({
          content: { ...protectedContent, resolve: () => ({ mode: 'plaintext' }) },
          repo,
          now: () => 0,
          canWrite: () => true,
          grant: async () => ({ ...grant, bucketId }),
        });
        await expect(sync.acquire(resource, false)).rejects.toThrow();
        await expect(sync.acquire({ kind: 'body', bodyDocId: 'legacy' }, false)).rejects.toThrow(
          'workspace resources'
        );
        await expect(
          sync.acquire(
            {
              kind: 'index',
              domain: { workspaceId: 'ws-1', ownerUserId: 'user-1', visibility: 'workspace' },
            },
            false
          )
        ).rejects.toThrow('workspace resources');
        await sync.dispose();
      }
      const guest = new PromptShortcutSync({
        content: protectedContent,
        repo,
        now: () => 0,
        grant: async () => {
          throw new Error('Guest must not request write tokens');
        },
      });
      await expect(guest.acquire(resource, true)).rejects.toThrow('read-only');
      await guest.dispose();
    } finally {
      await repo.destroy();
    }
  });

  it('keeps guest reads live and rejects creation, editing and deletion before local mutations', async () => {
    const repo = await LoroRepo.create({});
    const store = await LocalShortcutStore.open({ repo, workspaceId: 'ws-1', userId: 'user-1' });
    const original = await store.save({ value: makeShortcut(), base: null });
    await store.acknowledge((await store.preparePublication(original.entry.id))!);
    const accesses: boolean[] = [];
    const runtime = new PromptShortcutRuntime(store, {
      canWrite: () => false,
      acquire: async (_, write) => {
        accesses.push(write);
        if (write) throw new Error('Guest requested write access');
        return { sync: async () => {}, join: async () => {}, release: async () => {} };
      },
      dispose: async () => {},
    });
    try {
      await runtime.start();
      expect(accesses.length).toBeGreaterThan(0);
      expect(accesses.every((write) => !write)).toBe(true);
      await expect(
        runtime.save({ value: makeShortcut({ id: 'new' }), base: null })
      ).rejects.toThrow('read-only');
      await expect(
        runtime.save({ value: makeShortcut({ revision: 'edit' }), base: original.entry })
      ).rejects.toThrow('read-only');
      expect(() => runtime.remove(original.entry)).toThrow('read-only');
      await runtime.flush();
      expect(store.list()).toHaveLength(1);
      expect(store.get(original.entry.id)?.entry.revision).toBe('rev-1');
      expect(store.get(original.entry.id)?.operation).toBeNull();
    } finally {
      await runtime.dispose();
      await repo.destroy();
    }
  });

  it.each(['flock', 'doc'] as const)(
    'round trips the real %s replica through encrypted Streams with room-bound AAD',
    async (kind) => {
      const writerRepo = await LoroRepo.create({});
      const readerRepo = await LoroRepo.create({});
      const selected =
        kind === 'flock' ? ({ kind: 'workspace-index', workspaceId: 'ws-1' } as const) : resource;
      const streamId = getShortcutResourceStreamId(selected);
      const room: StreamsRoomIdentity =
        kind === 'flock' ? { kind, flockDocId: streamId } : { kind, docId: streamId };
      const namespace = 'synthetic-namespace';
      const prefix = encodeStreamsRoomAdditionalData(namespace, room, new Uint8Array());
      const key = Buffer.alloc(32, 7);
      let sequence = 0,
        seals = 0,
        opens = 0;
      const content: WorkspaceStreamsContent = {
        mode: 'protected',
        namespace,
        snapshotUpload: { canUpload: () => false },
        resolve: encryptedWorkspaceResolver('ws-1', () => ({
          maxSealOverheadBytes: 128,
          seal(input) {
            const header = Buffer.alloc(12);
            header.writeUInt32BE(++sequence);
            const aad = input.additionalData(header);
            expect(aad).toEqual(
              encodeStreamsRoomAdditionalData(namespace, room, aad.slice(prefix.length))
            );
            const cipher = createCipheriv('aes-256-gcm', key, header);
            cipher.setAAD(aad);
            seals++;
            return {
              header,
              sealed: Buffer.concat([
                cipher.update(input.plaintext),
                cipher.final(),
                cipher.getAuthTag(),
              ]),
            };
          },
          open(input) {
            expect(input.additionalData).toEqual(
              encodeStreamsRoomAdditionalData(
                namespace,
                room,
                input.additionalData.slice(prefix.length)
              )
            );
            const cipher = createDecipheriv('aes-256-gcm', key, input.header);
            cipher.setAAD(input.additionalData);
            cipher.setAuthTag(input.sealed.slice(-16));
            opens++;
            return Buffer.concat([cipher.update(input.sealed.slice(0, -16)), cipher.final()]);
          },
        })),
      };
      const batches: Uint8Array[] = [];
      const paths: string[] = [];
      const tail = () =>
        String(batches.reduce((sum, batch) => sum + batch.length, 0)).padStart(20, '0');
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        paths.push(url.pathname);
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
          batches.push(new Uint8Array(await new Response(init?.body).arrayBuffer()));
          return new Response(null, {
            headers: {
              'Stream-Next-Offset': tail(),
              'Stream-Up-To-Date': 'true',
              'Producer-Epoch': new Headers(init?.headers).get('Producer-Epoch') ?? '0',
              'Producer-Seq': new Headers(init?.headers).get('Producer-Seq') ?? '0',
            },
          });
        }
        if (method === 'PUT')
          return new Response(null, { status: 201, headers: { 'Stream-Next-Offset': tail() } });
        if (url.pathname.endsWith('/bootstrap'))
          return new Response(
            '--bytes\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--bytes--\r\n',
            {
              headers: {
                'Content-Type': 'multipart/mixed; boundary=bytes',
                'Stream-Snapshot-Offset': '-1',
                'Stream-Next-Offset': '-1',
                'Stream-Up-To-Date': String(!batches.length),
              },
            }
          );
        return new Response(
          Buffer.concat(url.searchParams.get('offset') === tail() ? [] : batches),
          {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Stream-Next-Offset': tail(),
              'Stream-Up-To-Date': 'true',
            },
          }
        );
      });
      let bucketId = 'encrypted-content';
      let now = 0;
      const writer = new PromptShortcutSync({
        content,
        repo: writerRepo,
        now: () => now,
        canWrite: () => true,
        grant: async () => ({ ...grant, streamId, bucketId }),
      });
      const reader = new PromptShortcutSync({
        content,
        repo: readerRepo,
        now: () => 0,
        grant: async () => ({ ...grant, streamId }),
      });
      try {
        const replica =
          kind === 'flock'
            ? await writerRepo.acquireFlockDoc(streamId)
            : await writerRepo.acquireDoc(streamId);
        if ('flock' in replica) replica.flock.put(['prompt'], 'private-prompt-sentinel');
        else {
          replica.doc.getText('prompt').insert(0, 'private-prompt-sentinel');
          replica.doc.commit();
        }
        const writing = await writer.acquire(selected, true);
        await writing.sync();
        const reading = await reader.acquire(selected, false);
        await reading.sync();
        const received =
          kind === 'flock'
            ? await readerRepo.acquireFlockDoc(streamId)
            : await readerRepo.acquireDoc(streamId);
        expect(
          'flock' in received
            ? received.flock.get(['prompt'])
            : received.doc.getText('prompt').toString()
        ).toBe('private-prompt-sentinel');
        expect(seals).toBeGreaterThan(0);
        expect(opens).toBeGreaterThan(0);
        expect(paths.every((path) => path.includes('/encrypted-content/'))).toBe(true);
        expect(Buffer.concat(batches).includes(Buffer.from('private-prompt-sentinel'))).toBe(false);
        if (kind === 'doc') {
          const replayRepo = await LoroRepo.create({});
          const replayResource = { ...resource, bodyDocId: 'sc-2' };
          const replay = new PromptShortcutSync({
            content,
            repo: replayRepo,
            now: () => 0,
            grant: async () => ({
              ...grant,
              streamId: getShortcutResourceStreamId(replayResource),
            }),
          });
          try {
            const replayLease = await replay.acquire(replayResource, false);
            await expect(replayLease.sync()).rejects.toThrow();
            const replayDoc = await replayRepo.acquireDoc(
              getShortcutResourceStreamId(replayResource)
            );
            expect(replayDoc.doc.getText('prompt').toString()).toBe('');
            await replayDoc.release();
            await replayLease.release();
          } finally {
            await replay.dispose();
            await replayRepo.destroy();
          }

          batches.length = 0;
          const ordinaryRepo = await LoroRepo.create({});
          const protectedRepo = await LoroRepo.create({});
          const ordinary = new PromptShortcutSync({
            content: { mode: 'plaintext' },
            repo: ordinaryRepo,
            now: () => 0,
            grant: async () => ({ ...grant, bucketId: undefined }),
          });
          const protectedReader = new PromptShortcutSync({
            content,
            repo: protectedRepo,
            now: () => 0,
            grant: async () => grant,
          });
          try {
            const source = await ordinaryRepo.acquireDoc(streamId);
            source.doc.getText('prompt').insert(0, 'unprotected-shortcut');
            source.doc.commit();
            const plainLease = await ordinary.acquire(resource, true);
            await plainLease.sync();
            const protectedLease = await protectedReader.acquire(resource, false);
            await expect(protectedLease.sync()).rejects.toThrow();
            const target = await protectedRepo.acquireDoc(streamId);
            expect(target.doc.getText('prompt').toString()).toBe('');
            await target.release();
            await source.release();
            await plainLease.release();
            await protectedLease.release();
          } finally {
            await ordinary.dispose();
            await protectedReader.dispose();
            await ordinaryRepo.destroy();
            await protectedRepo.destroy();
          }
        }
        bucketId = 'lody';
        now = 300_000;
        await expect(writing.sync()).rejects.toThrow();
        await received.release();
        await replica.release();
        await reading.release();
        await writing.release();
      } finally {
        await writer.dispose();
        await reader.dispose();
        await writerRepo.destroy();
        await readerRepo.destroy();
        vi.unstubAllGlobals();
      }
    }
  );
});
