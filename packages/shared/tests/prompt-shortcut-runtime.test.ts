import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LoroRepo } from 'loro-repo';
import { FileSystemStorageAdaptor } from 'loro-repo/storage/filesystem';
import { createFlockAdapter } from '@loro-dev/streams-crdt/flock';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import {
  getShortcutBodyStreamId,
  getShortcutIndexStreamId,
  LocalShortcutStore,
  PromptShortcutCatalog,
  PromptShortcutRuntime,
  type PromptShortcut,
  type ShortcutDirectoryEntry,
  type ShortcutLocalRecord,
  type ShortcutPublicationPort,
} from '../src/prompt-shortcuts';

const value: PromptShortcut = {
  v: 1,
  id: 'review',
  workspaceId: 'ws',
  ownerUserId: 'alice',
  visibility: 'private',
  name: 'Review',
  slug: 'review',
  prompt: 'Inspect !{topic}',
  mentions: [],
  variables: [{ name: 'topic' }],
  scope: {},
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function disk() {
  const path = await mkdtemp(join(tmpdir(), 'lody-shortcut-runtime-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return async () => {
    const repo = await LoroRepo.create({
      storageAdapter: new FileSystemStorageAdaptor({ baseDir: path }),
    });
    const store = await LocalShortcutStore.open({ repo, workspaceId: 'ws', userId: 'alice' });
    return { repo, store };
  };
}
async function cloud() {
  const server = await LoroRepo.create({});
  cleanups.push(() => server.destroy());
  const registered = new Map<string, ShortcutLocalRecord>();
  const active = new Map<string, ShortcutDirectoryEntry>();
  const events: string[] = [];
  let online = true;
  let loseActivationReply = false;
  const port = (repo: LoroRepo, userId = 'alice'): ShortcutPublicationPort => ({
    stage: async (record) => {
      if (!online) throw new Error('offline');
      events.push('stage');
      registered.set(record.entry.bodyDocId, record);
    },
    activate: async ({ entry, published }) => {
      const current = active.get(entry.id);
      if (current?.revision !== entry.revision) {
        if ((current?.bodyDocId ?? null) !== (published?.bodyDocId ?? null))
          throw new Error('CAS conflict');
        active.set(entry.id, {
          shortcutId: entry.id,
          bodyDocId: entry.bodyDocId,
          ownerUserId: entry.ownerUserId,
          visibility: entry.visibility,
          revision: entry.revision,
        });
      }
      events.push('activate');
      if (loseActivationReply) throw new Error('lost response');
    },
    revoke: async (entry) => {
      active.delete(entry.id);
    },
    acquire: async (resource, write) => {
      if (!online) throw new Error('offline');
      const id =
        resource.kind === 'body'
          ? getShortcutBodyStreamId(resource.bodyDocId)
          : getShortcutIndexStreamId(resource.domain);
      if (resource.kind === 'body') {
        const owner = registered.get(resource.bodyDocId)?.entry.ownerUserId;
        if (
          owner !== userId &&
          (write ||
            ![...active.values()].some(
              (row) => row.bodyDocId === resource.bodyDocId && row.visibility === 'workspace'
            ))
        )
          throw new Error('Forbidden');
      }
      const local =
        resource.kind === 'body' ? await repo.acquireDoc(id) : await repo.acquireFlockDoc(id);
      const remote =
        resource.kind === 'body' ? await server.acquireDoc(id) : await server.acquireFlockDoc(id);
      const a = 'doc' in local ? createLoroDocAdapter(local.doc) : createFlockAdapter(local.flock);
      const b =
        'doc' in remote ? createLoroDocAdapter(remote.doc) : createFlockAdapter(remote.flock);
      let unsubscribe: (() => void) | undefined;
      return {
        join: async () => {
          if ('flock' in remote)
            unsubscribe = remote.flock.subscribe(() => {
              void a.applySnapshot(b.exportSnapshot());
            });
        },
        sync: async () => {
          events.push(`sync:${id}`);
          await a.applySnapshot(b.exportSnapshot());
          if (write) await b.applySnapshot(a.exportSnapshot());
          if ('doc' in local) await repo.persistDocNow(id, local.doc);
          else await repo.persistFlockDocNow(id, local.flock);
        },
        release: async () => {
          unsubscribe?.();
          await local.release();
          await remote.release();
        },
      };
    },
    dispose: async () => {},
  });
  return {
    server,
    events,
    active,
    port,
    setOnline: (next: boolean) => {
      online = next;
    },
    loseReply: (next: boolean) => {
      loseActivationReply = next;
    },
  };
}
async function openRuntime(
  open: Awaited<ReturnType<typeof disk>>,
  remote?: Awaited<ReturnType<typeof cloud>>
) {
  const { store, repo } = await open();
  const runtime = new PromptShortcutRuntime(store, remote?.port(repo));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runtime.dispose();
    await repo.destroy();
  };
  cleanups.push(close);
  return { runtime, close, repo };
}

describe('workspace Prompt Shortcut runtime', () => {
  it('observes an index uploaded after activation without another directory query or body download', async () => {
    const remote = await cloud();
    const owner = await (await disk())();
    const readerRepo = await LoroRepo.create({});
    const reader = new PromptShortcutRuntime(
      await LocalShortcutStore.open({ repo: readerRepo, workspaceId: 'ws', userId: 'bob' }),
      remote.port(readerRepo, 'bob')
    );
    const port = remote.port(owner.repo);
    const writer = new PromptShortcutRuntime(owner.store, {
      ...port,
      activate: async (record) => {
        await port.activate(record);
        await reader.setDirectory([...remote.active.values()]);
        expect(reader.getSnapshot().entries).toEqual([]); // Index is deliberately still empty.
      },
    });
    cleanups.push(async () => {
      await reader.dispose();
      await writer.dispose();
      await readerRepo.destroy();
      await owner.repo.destroy();
    });
    let delivered!: () => void;
    const received = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const unsubscribe = reader.subscribe(() => {
      if (reader.getSnapshot().entries.length === 1) delivered();
    });
    const entry = await writer.save({
      value: { ...value, visibility: 'workspace' },
      base: null,
      bodyDocId: 'shared',
    });
    await writer.flush();
    await received;
    unsubscribe();
    expect(reader.getSnapshot().entries).toEqual([entry]);
    // Both writes/syncs to this body belong to the author; the reader only held its index room.
    const readerBody = await readerRepo.acquireDoc('shortcut-body:shared');
    expect(readerBody.doc.getMap('revisions').size).toBe(0);
    await readerBody.release();
  });

  it('deletes an owned shortcut from a cold index without downloading its body', async () => {
    const remote = await cloud();
    const author = await openRuntime(await disk(), remote);
    const entry = await author.runtime.save({ value, base: null, bodyDocId: 'private' });
    await author.runtime.flush();
    const fresh = await openRuntime(await disk(), remote);
    await fresh.runtime.setDirectory([...remote.active.values()]);
    remote.events.length = 0;
    await fresh.runtime.remove(entry);
    await fresh.runtime.flush();
    expect(fresh.runtime.getSnapshot().entries).toEqual([]);
    expect(remote.active.size).toBe(0);
    expect(remote.events.some((event) => event.includes('shortcut-body'))).toBe(false);
  });
  it('fences a late publication after runtime disposal and retains it for the next runtime', async () => {
    const open = await disk();
    const remote = await cloud();
    const { store, repo } = await open();
    const port = remote.port(repo);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new PromptShortcutRuntime(store, {
      ...port,
      stage: async (record) => {
        entered();
        await wait;
        await port.stage(record);
      },
    });
    await runtime.save({ value, base: null, bodyDocId: 'body' });
    await started;
    const closing = runtime.dispose();
    release();
    await closing;
    await repo.destroy();
    expect(remote.active.size).toBe(0);
    expect(remote.events).toEqual(['stage']);
    const next = await openRuntime(open, remote);
    await next.runtime.flush();
    expect(next.runtime.getSnapshot().pendingIds).toEqual([]);
  });
  it('repairs an existing body saved before a failed working-catalog write after reopening storage', async () => {
    const open = await disk();
    let instance = await openRuntime(open);
    const entry = await instance.runtime.save({ value, base: null, bodyDocId: 'body' });
    await instance.runtime.flush();
    const persist = instance.repo.persistFlockDocNow.bind(instance.repo);
    let ledgerWrites = 0;
    const failure = vi
      .spyOn(instance.repo, 'persistFlockDocNow')
      .mockImplementation(async (...args) => {
        if (args[0].startsWith('shortcut-local:') && ++ledgerWrites === 2)
          throw new Error('working projection interrupted');
        await persist(...args);
      });
    const edited = { ...value, revision: 'r2', prompt: 'Revised !{topic}' };
    await expect(
      instance.runtime.save({ value: edited, base: entry, bodyDocId: 'body' })
    ).rejects.toThrow('interrupted');
    failure.mockRestore();
    await instance.close();
    instance = await openRuntime(open);
    const repaired = instance.runtime.getSnapshot().entries[0]!;
    expect(repaired.revision).toBe('r2');
    expect(await instance.runtime.read(repaired)).toEqual(edited);
    await instance.runtime.flush();
    expect(instance.runtime.getSnapshot().pendingIds).toEqual([]);
  });

  it('discards a pre-body intent on reopen and does not block a later save', async () => {
    const open = await disk();
    let instance = await openRuntime(open);
    // Seed the exact durable boundary reached before body mutation, then reopen.
    const { projectShortcutIndex } = await import('../src/prompt-shortcuts/catalog');
    const ledger = await instance.repo.acquireFlockDoc('shortcut-local:ws:alice');
    ledger.flock.set(['writeIntent', value.id], {
      entry: projectShortcutIndex(value, 'body'),
      published: null,
      operation: 'save',
      deleted: false,
    });
    ledger.flock.commit();
    await instance.repo.persistFlockDocNow('shortcut-local:ws:alice', ledger.flock);
    await ledger.release();
    await instance.close();
    instance = await openRuntime(open);
    expect(instance.runtime.getSnapshot().entries).toEqual([]);
    await instance.runtime.save({ value, base: null, bodyDocId: 'body' });
    await instance.runtime.flush();
    expect(instance.runtime.getSnapshot().pendingIds).toEqual([]);
  });
  it('acknowledges offline durability, reopens the outbox and publishes body before discovery', async () => {
    const open = await disk();
    const remote = await cloud();
    remote.setOnline(false);
    let instance = await openRuntime(open, remote);
    const entry = await instance.runtime.save({ value, base: null, bodyDocId: 'body' });
    await instance.runtime.flush();
    expect(instance.runtime.getSnapshot().pendingIds).toEqual(['review']);
    expect(await instance.runtime.read(entry)).toEqual(value);
    expect(remote.active.size).toBe(0);
    await instance.close();
    instance = await openRuntime(open, remote);
    expect(instance.runtime.getSnapshot().entries).toEqual([entry]);
    expect(await instance.runtime.read(entry)).toEqual(value);
    remote.setOnline(true);
    await instance.runtime.flush();
    expect(instance.runtime.getSnapshot().pendingIds).toEqual([]);
    expect(remote.events.indexOf('activate')).toBeGreaterThan(
      remote.events.indexOf('sync:shortcut-body:body')
    );
    expect(remote.events.lastIndexOf('sync:shortcut-index:ws:alice:private')).toBeGreaterThan(
      remote.events.indexOf('activate')
    );
  });

  it('recovers an accepted activation with a lost reply without advertising before retry', async () => {
    const open = await disk();
    const remote = await cloud();
    remote.loseReply(true);
    let instance = await openRuntime(open, remote);
    await instance.runtime.save({
      value: { ...value, visibility: 'workspace' },
      base: null,
      bodyDocId: 'shared',
    });
    await instance.runtime.flush();
    expect(remote.active.size).toBe(1);
    const index = await remote.server.acquireFlockDoc('shortcut-index:ws:alice:workspace');
    expect(new PromptShortcutCatalog(index.flock).list()).toEqual([]);
    await index.release();
    await instance.close();
    instance = await openRuntime(open, remote);
    remote.loseReply(false);
    await instance.runtime.flush();
    expect(instance.runtime.getSnapshot().pendingIds).toEqual([]);
  });

  it('supports private → shared → private → shared with fresh histories and reversible withdrawal', async () => {
    const remote = await cloud();
    const { runtime, repo } = await openRuntime(await disk(), remote);
    let entry = await runtime.save({
      value: { ...value, prompt: 'old secret', variables: [] },
      base: null,
      bodyDocId: 'private-1',
    });
    await runtime.flush();
    entry = await runtime.save({
      value: { ...value, revision: 'r2', prompt: 'publishable', variables: [] },
      base: entry,
      bodyDocId: 'private-1',
    });
    await runtime.flush();
    for (const [visibility, bodyDocId, revision] of [
      ['workspace', 'shared-1', 'r3'],
      ['private', 'private-2', 'r4'],
      ['workspace', 'shared-2', 'r5'],
    ] as const) {
      entry = await runtime.save({
        value: { ...value, visibility, revision, prompt: 'publishable', variables: [] },
        base: entry,
        bodyDocId,
      });
      await runtime.flush();
      expect(runtime.getSnapshot().pendingIds).toEqual([]);
      const body = await repo.acquireDoc(getShortcutBodyStreamId(bodyDocId));
      expect([...body.doc.getMap('revisions').keys()]).toEqual([revision]);
      expect(JSON.stringify(body.doc.toJSON())).not.toContain('old secret');
      await body.release();
      const previousDomain = {
        workspaceId: 'ws',
        ownerUserId: 'alice',
        visibility: visibility === 'private' ? ('workspace' as const) : ('private' as const),
      };
      const previous = await repo.acquireFlockDoc(getShortcutIndexStreamId(previousDomain));
      expect(new PromptShortcutCatalog(previous.flock).get('review')).toBeNull();
      await previous.release();
    }
    await runtime.remove(entry);
    await runtime.flush();
    expect(runtime.getSnapshot().entries).toEqual([]);
    expect(runtime.getSnapshot().pendingIds).toEqual([]);
    await expect(
      runtime.save({ value, base: null, bodyDocId: 'resurrection' })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('discovers peer indexes without loading bodies and denies a cached body after revocation', async () => {
    const remote = await cloud();
    const owner = await openRuntime(await disk(), remote);
    const entry = await owner.runtime.save({
      value: { ...value, visibility: 'workspace' },
      base: null,
      bodyDocId: 'shared',
    });
    await owner.runtime.flush();
    const repo = await LoroRepo.create({});
    const store = await LocalShortcutStore.open({ repo, workspaceId: 'ws', userId: 'bob' });
    const reader = new PromptShortcutRuntime(store, remote.port(repo, 'bob'));
    cleanups.push(async () => {
      await reader.dispose();
      await repo.destroy();
    });
    remote.events.length = 0;
    await reader.setDirectory([...remote.active.values()]);
    expect(reader.getSnapshot().entries).toEqual([entry]);
    expect(remote.events.some((event) => event.includes('shortcut-body'))).toBe(false);
    expect((await reader.read(entry)).prompt).toBe(value.prompt);
    await reader.setDirectory([]);
    expect(reader.getSnapshot().entries).toEqual([]);
    await expect(reader.read(entry)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps local-only settings fully functional without a cloud port', async () => {
    const { runtime } = await openRuntime(await disk());
    const entry = await runtime.save({ value, base: null, bodyDocId: 'local' });
    await runtime.flush();
    expect(runtime.canShare).toBe(false);
    expect(runtime.getSnapshot().entries).toEqual([entry]);
    await expect(
      runtime.save({
        value: { ...value, visibility: 'workspace', revision: 'shared' },
        base: entry,
        bodyDocId: 'new',
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await runtime.remove(entry);
    await runtime.flush();
    expect(runtime.getSnapshot().entries).toEqual([]);
  });
});
