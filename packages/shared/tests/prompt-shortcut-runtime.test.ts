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
  scope: {},
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function disk(userId = 'alice') {
  const path = await mkdtemp(join(tmpdir(), 'lody-shortcut-runtime-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return async () => {
    const repo = await LoroRepo.create({
      storageAdapter: new FileSystemStorageAdaptor({ baseDir: path }),
    });
    const store = await LocalShortcutStore.open({ repo, workspaceId: 'ws', userId });
    return { repo, store };
  };
}
async function cloud() {
  const server = await LoroRepo.create({});
  cleanups.push(() => server.destroy());
  const registered = new Map<string, ShortcutLocalRecord>();
  const active = new Map<string, ShortcutDirectoryEntry>();
  const cancelled = new Set<string>();
  const events: string[] = [];
  let online = true;
  let loseActivationReply = false;
  const port = (repo: LoroRepo, userId = 'alice'): ShortcutPublicationPort => ({
    stage: async (record) => {
      if (!online) throw new Error('offline');
      if (cancelled.has(record.entry.bodyDocId)) throw new Error('Cancelled');
      events.push('stage');
      registered.set(record.entry.bodyDocId, record);
      return active.get(record.entry.id)?.bodyDocId === record.entry.bodyDocId
        ? 'active'
        : 'staged';
    },
    activate: async ({ entry, published }) => {
      if (!online) throw new Error('offline');
      if (cancelled.has(entry.bodyDocId)) throw new Error('Cancelled');
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
      if (!online) throw new Error('offline');
      active.delete(entry.id);
    },
    settle: async ({ entry }) => {
      if (!online) throw new Error('offline');
      if (active.get(entry.id)?.bodyDocId === entry.bodyDocId) return 'active';
      cancelled.add(entry.bodyDocId);
      return 'cancelled';
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
  const runtime = new PromptShortcutRuntime(store, remote?.port(repo, store.userId));
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
  it('closes and reopens local storage without waiting for an offline cloud mutation to settle', async () => {
    const open = await disk();
    const remote = await cloud();
    const { store, repo } = await open();
    let entered!: () => void, complete!: (status: 'staged') => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<'staged'>((resolve) => {
      complete = resolve;
    });
    const runtime = new PromptShortcutRuntime(store, {
      ...remote.port(repo),
      stage: () => {
        entered();
        return waiting;
      },
    });
    const entry = await runtime.save({ value, base: null, bodyDocId: 'working' });
    await started;
    await runtime.dispose();
    await repo.destroy();
    const next = await openRuntime(open, remote);
    expect(next.runtime.getSnapshot().entries).toEqual([entry]);
    complete('staged'); // A late reply cannot resume the disposed publisher.
    await waiting;
    expect(remote.events).toEqual([]);
    await next.runtime.flush();
    expect(next.runtime.getSnapshot().pendingIds).toEqual([]);
  });
  it('reopens acknowledged local data offline and allows repeated edits and deletion', async () => {
    const open = await disk();
    const remote = await cloud();
    let instance = await openRuntime(open, remote);
    let entry = await instance.runtime.save({ value, base: null, bodyDocId: 'working' });
    await instance.runtime.flush();
    await instance.close();
    remote.setOnline(false);
    remote.events.length = 0;
    instance = await openRuntime(open, remote);
    expect(instance.runtime.getSnapshot()).toMatchObject({ entries: [entry], loading: false });
    expect(await instance.runtime.read(entry)).toEqual(value);
    expect(remote.events).toEqual([]);
    for (const revision of ['r2', 'r3']) {
      entry = await instance.runtime.save({
        value: { ...value, revision, prompt: `Offline ${revision} !{topic}` },
        base: entry,
        bodyDocId: entry.bodyDocId,
      });
      await instance.runtime.flush();
    }
    await instance.close();
    instance = await openRuntime(open, remote);
    expect((await instance.runtime.read(entry)).revision).toBe('r3');
    await instance.runtime.remove(entry);
    expect(instance.runtime.getSnapshot().entries).toEqual([]);
    await instance.runtime.flush();
    await instance.close();
    instance = await openRuntime(open, remote);
    expect(instance.runtime.getSnapshot().entries).toEqual([]);
    remote.setOnline(true);
    await instance.runtime.flush();
    expect(instance.runtime.getSnapshot().pendingIds).toEqual([]);
    expect(remote.active.size).toBe(0);
  });

  it('uses downloaded shared content after an offline restart and durably applies learned revocation', async () => {
    const remote = await cloud();
    const owner = await openRuntime(await disk(), remote);
    await owner.runtime.save({
      value: { ...value, visibility: 'workspace' },
      base: null,
      bodyDocId: 'working',
    });
    await owner.runtime.flush();
    const open = await disk('bob');
    let reader = await openRuntime(open, remote);
    await reader.runtime.setDirectory([...remote.active.values()]);
    const entry = reader.runtime.getSnapshot().entries[0]!;
    remote.setOnline(false);
    await expect(reader.runtime.read(entry)).rejects.toThrow('offline');
    expect(reader.runtime.getSnapshot().entries).toEqual([entry]);
    remote.setOnline(true);
    expect((await reader.runtime.read(entry)).prompt).toBe(value.prompt);
    await reader.close();
    remote.setOnline(false);
    remote.events.length = 0;
    reader = await openRuntime(open, remote);
    expect(reader.runtime.getSnapshot()).toMatchObject({ entries: [entry], loading: false });
    expect((await reader.runtime.read(entry)).prompt).toBe(value.prompt);
    expect(remote.events).toEqual([]);
    await reader.runtime.setDirectory([]);
    await expect(reader.runtime.read(entry)).rejects.toMatchObject({ code: 'forbidden' });
    await reader.close();
    reader = await openRuntime(open, remote);
    expect(reader.runtime.getSnapshot().entries).toEqual([]);
    await expect(reader.runtime.read(entry)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does not put later private edits into a shared upload or let its late acknowledgement clear them', async () => {
    const remote = await cloud();
    const { store, repo } = await (await disk())();
    const port = remote.port(repo);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sharedJob!: ShortcutLocalRecord;
    const runtime = new PromptShortcutRuntime(store, {
      ...port,
      stage: async (record) => {
        if (record.entry.revision === 'r1') {
          sharedJob = record;
          entered();
          await blocked;
        } else throw new Error('offline');
        return port.stage(record);
      },
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await repo.destroy();
    });
    const first = await runtime.save({
      value: { ...value, visibility: 'workspace' },
      base: null,
      bodyDocId: 'working-shared',
    });
    await started;
    const latest = await runtime.save({
      value: { ...value, revision: 'r2', prompt: 'NEW PRIVATE SECRET' },
      base: first,
      bodyDocId: 'working-private',
    });
    expect((await runtime.read(latest)).prompt).toBe('NEW PRIVATE SECRET');
    release();
    await runtime.flush();
    expect(runtime.getSnapshot()).toMatchObject({ entries: [latest], pendingIds: [value.id] });
    const uploaded = await remote.server.acquireDoc(
      getShortcutBodyStreamId(sharedJob.entry.bodyDocId)
    );
    expect(JSON.stringify(uploaded.doc.toJSON())).not.toContain('NEW PRIVATE SECRET');
    expect(JSON.stringify(uploaded.doc.toJSON())).toContain(value.prompt);
    await uploaded.release();
    expect(store.get(value.id)?.published?.revision).toBe('r1');
    expect(store.publication(value.id)?.entry.revision).toBe('r2');
  });

  it('settles a superseded job with a lost activation reply and publishes the newer local revision after restart', async () => {
    const remote = await cloud();
    const open = await disk();
    let instance = await openRuntime(open, remote);
    remote.loseReply(true);
    const first = await instance.runtime.save({ value, base: null, bodyDocId: 'working' });
    await instance.runtime.flush();
    remote.setOnline(false);
    const latest = await instance.runtime.save({
      value: { ...value, revision: 'r2' },
      base: first,
      bodyDocId: first.bodyDocId,
    });
    await instance.runtime.flush();
    await instance.close();
    remote.loseReply(false);
    remote.setOnline(true);
    instance = await openRuntime(open, remote);
    await instance.runtime.flush();
    expect(instance.runtime.getSnapshot()).toMatchObject({ entries: [latest], pendingIds: [] });
    expect(remote.active.get(value.id)?.revision).toBe('r2');
  });

  it('cancels a rejected publication so a local rename can publish without retrying the invalid slug', async () => {
    const remote = await cloud();
    const { store, repo } = await (await disk())();
    const port = remote.port(repo);
    const rejected: string[] = [];
    const runtime = new PromptShortcutRuntime(store, {
      ...port,
      activate: async (record) => {
        if (record.entry.slug === 'review') {
          rejected.push(record.entry.bodyDocId);
          throw new Error('slug collision');
        }
        await port.activate(record);
      },
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await repo.destroy();
    });
    const first = await runtime.save({ value, base: null, bodyDocId: 'working' });
    await runtime.flush();
    const latest = await runtime.save({
      value: { ...value, revision: 'r2', slug: 'my-review' },
      base: first,
      bodyDocId: first.bodyDocId,
    });
    await runtime.flush();
    expect(runtime.getSnapshot()).toMatchObject({ entries: [latest], pendingIds: [] });
    expect(rejected).toHaveLength(1);
    expect(remote.active.get(value.id)?.revision).toBe('r2');
  });

  it('adopts a newer owned remote revision into a separate working body without uploading local edits', async () => {
    const remote = await cloud();
    const firstDevice = await openRuntime(await disk(), remote);
    await firstDevice.runtime.save({ value, base: null, bodyDocId: 'working-a' });
    await firstDevice.runtime.flush();
    const secondDevice = await openRuntime(await disk(), remote);
    await secondDevice.runtime.setDirectory([...remote.active.values()]);
    let base = secondDevice.runtime.getSnapshot().entries[0]!;
    await secondDevice.runtime.read(base);
    await secondDevice.runtime.save({
      value: { ...value, revision: 'r2' },
      base,
      bodyDocId: base.bodyDocId,
    });
    await secondDevice.runtime.flush();
    await firstDevice.runtime.setDirectory([...remote.active.values()]);
    base = firstDevice.runtime.getSnapshot().entries[0]!;
    expect(base.revision).toBe('r2');
    await firstDevice.runtime.read(base);
    remote.setOnline(false);
    const edit = await firstDevice.runtime.save({
      value: { ...value, revision: 'r3' },
      base,
      bodyDocId: base.bodyDocId,
    });
    await firstDevice.runtime.flush();
    expect(edit.bodyDocId).not.toBe(base.bodyDocId);
    expect((await firstDevice.runtime.read(edit)).revision).toBe('r3');
    expect((await firstDevice.runtime.store.read(base)).revision).toBe('r2');
    remote.setOnline(true);
    await firstDevice.runtime.flush();
    expect(remote.active.get(value.id)?.revision).toBe('r3');
  });

  it('persists explicit remote deletion for a clean owned replica without treating stale absence as deletion', async () => {
    const remote = await cloud();
    const open = await disk();
    let instance = await openRuntime(open, remote);
    const entry = await instance.runtime.save({ value, base: null, bodyDocId: 'working' });
    await instance.runtime.flush();
    await instance.runtime.setDirectory([]);
    expect(instance.runtime.getSnapshot().entries).toEqual([entry]);
    await instance.runtime.setDirectory([{ ...remote.active.get(value.id)!, deleted: true }]);
    expect(instance.runtime.getSnapshot().entries).toEqual([]);
    await instance.close();
    remote.setOnline(false);
    instance = await openRuntime(open, remote);
    expect(instance.runtime.getSnapshot().entries).toEqual([]);
    await expect(instance.runtime.read(entry)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('upgrades a v1 interrupted job without losing its activation identity or uploading later work', async () => {
    const remote = await cloud();
    const open = await disk();
    let instance = await openRuntime(open, remote);
    remote.loseReply(true);
    await instance.runtime.save({ value, base: null, bodyDocId: 'working' });
    await instance.runtime.flush();
    const legacy = instance.runtime.store.publication(value.id)!;
    // Exact v1 durable shape: its working body was also the in-flight upload,
    // and a crash could leave the old pointer-only write intent alongside it.
    const ledger = await instance.repo.acquireFlockDoc('shortcut-local:ws:alice');
    ledger.flock.delete(['publicationProtocol']);
    ledger.flock.delete(['publication', value.id]);
    ledger.flock.set(['shortcut', value.id], JSON.parse(JSON.stringify(legacy)));
    ledger.flock.set(['writeIntent', value.id], JSON.parse(JSON.stringify(legacy)));
    ledger.flock.commit();
    await instance.repo.persistFlockDocNow('shortcut-local:ws:alice', ledger.flock);
    await ledger.release();
    await instance.close();
    remote.setOnline(false);
    instance = await openRuntime(open, remote);
    const base = instance.runtime.getSnapshot().entries[0]!;
    expect(base.bodyDocId).not.toBe(legacy.entry.bodyDocId);
    expect(instance.runtime.store.publication(value.id)).toEqual(legacy);
    const edited = await instance.runtime.save({
      value: { ...value, revision: 'r2', prompt: 'LATER PRIVATE WORK' },
      base,
      bodyDocId: base.bodyDocId,
    });
    await instance.runtime.flush();
    expect((await instance.runtime.store.read(legacy.entry)).prompt).toBe(value.prompt);
    remote.loseReply(false);
    remote.setOnline(true);
    await instance.runtime.flush();
    expect(instance.runtime.getSnapshot()).toMatchObject({ entries: [edited], pendingIds: [] });
    expect(remote.active.get(value.id)?.revision).toBe('r2');
  });

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
    expect(reader.getSnapshot().entries).toEqual([
      { ...entry, bodyDocId: remote.active.get(entry.id)!.bodyDocId },
    ]);
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
        return port.stage(record);
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
      record: {
        entry: projectShortcutIndex(value, 'body'),
        published: null,
        operation: 'save',
        deleted: false,
      },
      baseRevision: null,
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
      remote.events.indexOf(`sync:shortcut-body:${remote.active.get(entry.id)!.bodyDocId}`)
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
      value: { ...value, prompt: 'old secret' },
      base: null,
      bodyDocId: 'private-1',
    });
    await runtime.flush();
    entry = await runtime.save({
      value: { ...value, revision: 'r2', prompt: 'publishable' },
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
        value: { ...value, visibility, revision, prompt: 'publishable' },
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
    await owner.runtime.save({
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
    const entry = reader.getSnapshot().entries[0]!;
    expect(entry.revision).toBe(value.revision);
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
