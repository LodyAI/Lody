import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRepoLegacy as LoroRepo } from '../src/workspace-data/repo-legacy';
import { PromptShortcutSync } from '../src/prompt-shortcuts/sync';
import { LoroDoc } from 'loro-crdt';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemStorageAdaptor } from 'loro-repo/storage/filesystem';
import {
  getShortcutBodyStreamId,
  getShortcutIndexStreamId,
  type ShortcutResource,
} from '../src/prompt-shortcuts/access';
import {
  projectShortcutIndex,
  PromptShortcutCatalog,
  type PromptShortcutIndexEntry,
} from '../src/prompt-shortcuts/catalog';
import { PromptShortcutDocument } from '../src/prompt-shortcuts/document';
import { LocalShortcutStore } from '../src/prompt-shortcuts/local-store';
import type { PromptShortcut } from '../src/prompt-shortcuts/model';
import {
  PromptShortcutRuntime,
  type ShortcutPublicationPort,
} from '../src/prompt-shortcuts/runtime';

const workspaceId = 'workspace-a';
const userId = 'user-a';
const directories: string[] = [];
async function createRepo(baseDir?: string) {
  const directory = baseDir ?? (await mkdtemp(join(tmpdir(), 'lody-shortcut-native-')));
  if (!baseDir) directories.push(directory);
  return LoroRepo.create({ storageAdapter: new FileSystemStorageAdaptor({ baseDir: directory }) });
}

function shortcut(id: string): PromptShortcut {
  return {
    v: 1,
    id,
    workspaceId,
    ownerUserId: userId,
    visibility: 'workspace',
    name: `Shortcut ${id}`,
    slug: id,
    prompt: `Prompt ${id}`,
    mentions: [],
    scope: {},
    revision: `revision-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

function noopPublicationPort(acquire: ShortcutPublicationPort['acquire']): ShortcutPublicationPort {
  return {
    acquire,
    stage: vi.fn(async () => 'active'),
    activate: vi.fn(async () => {}),
    settle: vi.fn(async () => 'active'),
    revoke: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

async function createRuntime(
  values: readonly PromptShortcut[],
  acquire: ShortcutPublicationPort['acquire']
) {
  const repo = await createRepo();
  const store = await LocalShortcutStore.open({ repo, workspaceId, userId });
  const entries = values.map((value) => projectShortcutIndex(value, `body-${value.id}`));
  await store.cacheDiscovery({
    entries,
    directory: entries.map((entry) => ({
      shortcutId: entry.id,
      bodyDocId: entry.bodyDocId,
      ownerUserId: entry.ownerUserId,
      visibility: entry.visibility,
      revision: entry.revision,
    })),
  });
  const runtime = new PromptShortcutRuntime(store, noopPublicationPort(acquire));
  return {
    entries,
    repo,
    runtime,
    async close() {
      await runtime.dispose();
      await repo.destroy();
    },
  };
}

async function saveBody(repo: LoroRepo, entry: PromptShortcutIndexEntry, value: PromptShortcut) {
  const docId = getShortcutBodyStreamId(entry.bodyDocId);
  const lease = await repo.acquireDoc(docId);
  try {
    new PromptShortcutDocument(lease.doc).save(value, []);
    await repo.persistDocNow(docId, lease.doc);
  } finally {
    await lease.release();
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  vi.unstubAllGlobals();
});

describe('PromptShortcutSync native SDK ownership', () => {
  it.each(['sync', 'join'] as const)(
    'reopens the same database after accepted SDK %s I/O finishes retirement',
    async (operation) => {
      const baseDir = await mkdtemp(join(tmpdir(), 'lody-shortcut-retirement-'));
      directories.push(baseDir);
      const repo = await createRepo(baseDir);
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
        entered.resolve();
        await finish.promise;
        return new Response(null, {
          headers: { 'Stream-Next-Offset': '0', 'Stream-Up-To-Date': 'true' },
        });
      });
      const streamId = getShortcutBodyStreamId('review-retirement');
      const sync = new PromptShortcutSync({
        repo,
        now: () => 0,
        grant: async () => ({
          token: 'synthetic',
          expiresIn: 3600,
          gatewayBaseUrl: 'https://shortcut.invalid',
          streamId,
        }),
      });
      const lease = await sync.acquire({ kind: 'body', bodyDocId: 'review-retirement' }, false);
      const working = lease[operation]().catch(() => undefined);
      await entered.promise;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const closing = lease.release();
        const firstFailure = expect(closing).rejects.toThrow();
        await aborted.promise;
        await vi.advanceTimersByTimeAsync(10_001);
        await firstFailure;
        const disposing = repo.destroy();
        const ownerFailure = expect(disposing).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(5_001);
        await ownerFailure;
        finish.resolve();
        await working;
        await sync.dispose();
        await repo.destroy();
        const replacement = await createRepo(baseDir);
        const next = new PromptShortcutSync({
          repo: replacement,
          now: () => 0,
          grant: async () => ({
            token: 'synthetic',
            expiresIn: 3600,
            gatewayBaseUrl: 'https://shortcut.invalid',
            streamId,
          }),
        });
        try {
          const reopened = await next.acquire(
            { kind: 'body', bodyDocId: 'review-retirement' },
            false
          );
          await reopened.release();
        } finally {
          await next.dispose();
          await replacement.destroy();
        }
      } finally {
        finish.resolve();
        await working;
        await sync.dispose().catch(() => undefined);
        await repo.destroy().catch(() => undefined);
        vi.useRealTimers();
      }
    }
  );

  it('closes local shortcut storage after remote close fails and retries retirement', async () => {
    const repo = await createRepo();
    const store = await LocalShortcutStore.open({ repo, workspaceId, userId });
    const disposeStore = store.dispose.bind(store);
    let storeClosed = false;
    store.dispose = async () => {
      await disposeStore();
      storeClosed = true;
    };
    let blocked = true;
    let remoteClosed = false;
    const remote = noopPublicationPort(async () => {
      throw new Error('Unexpected acquire');
    });
    remote.dispose = async () => {
      if (blocked) throw new Error('synthetic remote close failure');
      remoteClosed = true;
    };
    const runtime = new PromptShortcutRuntime(store, remote);
    cleanups.push(async () => {
      blocked = false;
      await runtime.dispose();
      await repo.destroy();
    });
    await expect(runtime.dispose()).rejects.toThrow('Shortcut cleanup failed');
    expect(storeClosed).toBe(true);
    expect(remoteClosed).toBe(false);
    expect(() => runtime.setDirectory([])).toThrow('disposed');
    blocked = false;
    await runtime.dispose();
    expect(remoteClosed).toBe(true);
  });

  it('automatically retries a failed release before reopening the same shortcut', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'lody-shortcut-retry-'));
    directories.push(baseDir);
    const adapter = new FileSystemStorageAdaptor({ baseDir });
    const save = adapter.save.bind(adapter);
    let blocked = false;
    adapter.save = async (payload) => {
      if (blocked && (payload.type === 'doc-update' || payload.type === 'doc-snapshot'))
        throw new Error('synthetic shortcut persistence failure');
      await save(payload);
    };
    const repo = await LoroRepo.create({ storageAdapter: adapter });
    const streamId = getShortcutBodyStreamId('retry');
    const sync = new PromptShortcutSync({
      repo,
      now: () => 0,
      grant: async () => ({
        token: 'synthetic',
        expiresIn: 3600,
        gatewayBaseUrl: 'https://shortcut.invalid',
        streamId,
      }),
    });
    cleanups.push(async () => {
      blocked = false;
      await sync.dispose();
      await repo.destroy();
    });
    const resource = { kind: 'body', bodyDocId: 'retry' } as const;
    const first = await sync.acquire(resource, true);
    const author = await repo.acquireDoc(streamId);
    author.doc.getText('body').insert(0, 'survives failed close');
    author.doc.commit();
    await author.release();
    blocked = true;
    await expect(first.release()).rejects.toThrow();
    await expect(sync.acquire(resource, true)).rejects.toThrow();
    blocked = false;
    const recovered = await sync.acquire(resource, true);
    const reader = await repo.acquireDoc(streamId);
    expect(reader.doc.getText('body').toString()).toBe('survives failed close');
    await reader.release();
    await recovered.release();
  });

  it('imports a read-only body without echo uploads and retains it for another borrower', async () => {
    const repo = await createRepo();
    const author = new LoroDoc();
    author.getText('body').insert(0, 'shared shortcut');
    author.commit();
    const snapshot = author.export({ mode: 'snapshot' });
    const writes: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method !== 'GET' && method !== 'HEAD') writes.push(method);
      const headers = { 'Stream-Next-Offset': '100', 'Stream-Up-To-Date': 'true' };
      if (url.pathname.endsWith('/bootstrap'))
        return new Response(
          Buffer.concat([
            Buffer.from('--shortcut\r\nContent-Type: application/octet-stream\r\n\r\n'),
            snapshot,
            Buffer.from('\r\n--shortcut--\r\n'),
          ]),
          {
            headers: {
              ...headers,
              'Content-Type': 'multipart/mixed; boundary=shortcut',
              'Stream-Snapshot-Offset': '100',
            },
          }
        );
      return new Response(null, { headers });
    });
    const streamId = getShortcutBodyStreamId('native-read');
    const sync = new PromptShortcutSync({
      repo,
      now: () => 0,
      grant: async () => ({
        token: 'synthetic-grant',
        expiresIn: 3600,
        gatewayBaseUrl: 'https://shortcut.invalid',
        streamId,
      }),
    });
    cleanups.push(async () => {
      await sync.dispose();
      await repo.destroy();
      author.free();
    });
    const resource = { kind: 'body', bodyDocId: 'native-read' } as const;
    const first = await sync.acquire(resource, false);
    const second = await sync.acquire(resource, false);
    await first.sync();
    const borrower = await repo.acquireDoc(streamId);
    expect(borrower.doc.getText('body').toString()).toBe('shared shortcut');
    await first.release();
    await second.sync();
    expect(borrower.doc.getText('body').toString()).toBe('shared shortcut');
    expect(writes).toEqual([]);
    await second.release();
    await borrower.release();
  });

  it('rejects a grant for a different body before opening a replica or making HTTP requests', async () => {
    const repo = await createRepo();
    const sync = new PromptShortcutSync({
      repo,
      now: () => 0,
      grant: async () => ({
        token: 'synthetic-grant',
        expiresIn: 60,
        gatewayBaseUrl: 'https://shortcut.invalid',
        streamId: 'wrong-body',
      }),
    });
    cleanups.push(async () => {
      await sync.dispose();
      await repo.destroy();
    });
    await expect(sync.acquire({ kind: 'body', bodyDocId: 'wanted' }, false)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await repo.listDoc()).toEqual([]);
  });
});

describe('PromptShortcutRuntime body warming', () => {
  it('reopens a remote index during persistent save failure and evicts it after recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-shortcut-flock-reuse-'));
    directories.push(directory);
    const adapter = new FileSystemStorageAdaptor({ baseDir: directory });
    const save = adapter.save.bind(adapter);
    const value = shortcut('retained-index');
    const entry = projectShortcutIndex(value, 'body-retained-index');
    const domain = { workspaceId, ownerUserId: userId, visibility: 'workspace' as const };
    const id = getShortcutIndexStreamId(domain);
    let blocked = false;
    adapter.save = async (payload) => {
      if (blocked && 'flockDocId' in payload && payload.flockDocId === id)
        throw new Error('synthetic index save failure');
      await save(payload);
    };
    const repo = await LoroRepo.create({ storageAdapter: adapter });
    const store = await LocalShortcutStore.open({ repo, workspaceId, userId });
    const source = await repo.acquireFlockDoc('remote-shortcut-index');
    const replicas: Array<typeof source.flock> = [];
    const remote = source.flock;
    new PromptShortcutCatalog(remote).put(entry);
    const runtime = new PromptShortcutRuntime(
      store,
      noopPublicationPort(async (resource) => {
        if (resource.kind !== 'index') throw new Error('Expected an index');
        const lease = await repo.acquireFlockDoc(id);
        replicas.push(lease.flock);
        return {
          sync: async () => {
            lease.flock.importJson(remote.exportJson({}));
            lease.flock.commit();
          },
          join: async () => {},
          release: () => lease.release(),
        };
      })
    );
    const rows = [
      { shortcutId: entry.id, bodyDocId: entry.bodyDocId, ...domain, revision: entry.revision },
    ];
    try {
      await runtime.setDirectory(rows);
      const original = replicas[0];
      if (!original) throw new Error('Missing remote index');
      blocked = true;
      const received = {
        ...entry,
        name: 'Received while storage fails',
        revision: 'received-revision',
      };
      new PromptShortcutCatalog(remote).put(received);
      original.importJson(remote.exportJson({}));
      original.commit();
      const receivedRows = rows.map((row) => ({ ...row, revision: received.revision }));
      for (let attempt = 0; attempt < 2; attempt++) {
        await runtime.setDirectory([]);
        expect(runtime.getSnapshot().errors.directory).toBeUndefined();
        await expect(repo.unloadFlockDoc(id)).rejects.toThrow();
        await runtime.setDirectory(receivedRows);
        expect(runtime.getSnapshot().errors.directory).toBeUndefined();
        expect(replicas.at(-1)).toBe(original);
        expect(runtime.getSnapshot().entries).toContainEqual(received);
      }
      blocked = false;
      await runtime.setDirectory([]);
      await repo.unloadFlockDoc(id);
      const next = await repo.acquireFlockDocHandleLegacy(id);
      expect(next.flock).not.toBe(original);
      expect(new PromptShortcutCatalog(next.flock).list()).toEqual([received]);
      await next.release();
    } finally {
      blocked = false;
      await runtime.dispose();
      await source.release();
      await repo.destroy();
    }
  });

  it('coalesces a foreground read with the same in-flight body fetch', async () => {
    const value = shortcut('review');
    const gate = Promise.withResolvers<void>();
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    const acquire = vi.fn(async () => ({
      sync: async () => {
        await gate.promise;
        await saveBody(fixture.repo, fixture.entries[0]!, value);
      },
      join: async () => {},
      release: async () => {},
    }));
    fixture = await createRuntime([value], acquire);
    cleanups.push(fixture.close);

    const warm = fixture.runtime.prefetch(fixture.entries);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    const foreground = fixture.runtime.read(fixture.entries[0]!);
    gate.resolve();

    await expect(Promise.all([warm, foreground])).resolves.toEqual([undefined, value]);
    expect(acquire).toHaveBeenCalledTimes(1);
    await expect(fixture.runtime.read(fixture.entries[0]!)).resolves.toEqual(value);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('warms current bodies serially and continues after a failed body', async () => {
    const values = [shortcut('first'), shortcut('second'), shortcut('third')];
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    let active = 0;
    let maxActive = 0;
    let firstFailures = 1;
    const acquired: string[] = [];
    const acquire = vi.fn(async (resource: ShortcutResource) => {
      if (resource.kind !== 'body') throw new Error('Unexpected index acquisition');
      acquired.push(resource.bodyDocId);
      return {
        sync: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await Promise.resolve();
            if (resource.bodyDocId === 'body-first' && firstFailures > 0) {
              firstFailures -= 1;
              throw new Error('offline');
            }
            const index = fixture.entries.find((entry) => entry.bodyDocId === resource.bodyDocId)!;
            const value = values.find((item) => item.id === index.id)!;
            await saveBody(fixture.repo, index, value);
          } finally {
            active -= 1;
          }
        },
        join: async () => {},
        release: async () => {},
      };
    });
    fixture = await createRuntime(values, acquire);
    cleanups.push(fixture.close);

    await expect(fixture.runtime.prefetch(fixture.entries)).resolves.toBeUndefined();
    expect(acquired).toEqual(['body-first', 'body-second', 'body-third']);
    expect(maxActive).toBe(1);

    await fixture.runtime.prefetch(fixture.entries);
    expect(acquired).toEqual(['body-first', 'body-second', 'body-third', 'body-first']);
    await fixture.runtime.prefetch(fixture.entries);
    expect(acquired).toHaveLength(4);
  });

  it('serializes overlapping prefetch batches', async () => {
    const values = [shortcut('old'), shortcut('new')];
    const firstGate = Promise.withResolvers<void>();
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    let active = 0;
    let maxActive = 0;
    const acquired: string[] = [];
    const acquire = vi.fn(async (resource: ShortcutResource) => {
      if (resource.kind !== 'body') throw new Error('Unexpected index acquisition');
      acquired.push(resource.bodyDocId);
      return {
        sync: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            if (resource.bodyDocId === 'body-old') await firstGate.promise;
            const index = fixture.entries.find((entry) => entry.bodyDocId === resource.bodyDocId)!;
            const value = values.find((item) => item.id === index.id)!;
            await saveBody(fixture.repo, index, value);
          } finally {
            active -= 1;
          }
        },
        join: async () => {},
        release: async () => {},
      };
    });
    fixture = await createRuntime(values, acquire);
    cleanups.push(fixture.close);

    const first = fixture.runtime.prefetch([fixture.entries[0]!]);
    await vi.waitFor(() => expect(acquired).toEqual(['body-old']));
    const second = fixture.runtime.prefetch([fixture.entries[1]!]);
    try {
      await Promise.resolve();
      expect(acquired).toEqual(['body-old']);
    } finally {
      firstGate.resolve();
    }

    await Promise.all([first, second]);
    expect(acquired).toEqual(['body-old', 'body-new']);
    expect(maxActive).toBe(1);
  });

  it('stops queued bodies when the prefetch scope is cancelled', async () => {
    const values = [shortcut('active'), shortcut('queued')];
    const activeGate = Promise.withResolvers<void>();
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    const acquired: string[] = [];
    const acquire = vi.fn(async (resource: ShortcutResource) => {
      if (resource.kind !== 'body') throw new Error('Unexpected index acquisition');
      acquired.push(resource.bodyDocId);
      return {
        sync: async () => {
          if (resource.bodyDocId === 'body-active') await activeGate.promise;
          const index = fixture.entries.find((entry) => entry.bodyDocId === resource.bodyDocId)!;
          const value = values.find((item) => item.id === index.id)!;
          await saveBody(fixture.repo, index, value);
        },
        join: async () => {},
        release: async () => {},
      };
    });
    fixture = await createRuntime(values, acquire);
    cleanups.push(fixture.close);
    const controller = new AbortController();

    const warming = fixture.runtime.prefetch(fixture.entries, { signal: controller.signal });
    await vi.waitFor(() => expect(acquired).toEqual(['body-active']));
    controller.abort();
    activeGate.resolve();
    await warming;

    expect(acquired).toEqual(['body-active']);
  });
});
