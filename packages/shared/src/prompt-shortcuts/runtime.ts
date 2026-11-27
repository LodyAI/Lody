import {
  getWorkspaceShortcutBodyStreamId,
  getWorkspaceShortcutIndexStreamId,
  type WorkspaceShortcutResource,
} from './access';
import { InFlightDedupe } from '../in-flight-dedupe';
import { PromptShortcutCatalog, type PromptShortcutIndexEntry } from './catalog';
import { PromptShortcutDocument } from './document';
import { LocalShortcutStore, type ShortcutLocalRecord } from './local-store';
import { PromptShortcutError, type PromptShortcut } from './model';
import { type ShortcutSyncLease } from './sync';
import { ShortcutLifetime } from './lifetime';

export type ShortcutPublicationPort = {
  canWrite?: () => boolean;
  acquire(resource: WorkspaceShortcutResource, write: boolean): Promise<ShortcutSyncLease>;
  dispose(): Promise<void>;
};
export type ShortcutRuntimeSnapshot = {
  entries: readonly PromptShortcutIndexEntry[];
  pendingIds: readonly string[];
  errors: Readonly<Record<string, unknown>>;
  loading: boolean;
};

/** One account/workspace service. Components never own sync or outbox recovery. */
export class PromptShortcutRuntime {
  private readonly lifetime = new ShortcutLifetime();
  private disposed = false;
  private listeners = new Set<() => void>();
  private workspaceEntries = new Map<string, PromptShortcutIndexEntry>();
  private workspaceDeletedIds = new Set<string>();
  private tasks = new Set<Promise<unknown>>();
  private flushing: Promise<void> | null = null;
  private errors: Record<string, unknown> = {};
  private snapshot: ShortcutRuntimeSnapshot;
  private workspaceIndex: {
    catalog: PromptShortcutCatalog;
    write: boolean;
    close(): Promise<void>;
  } | null = null;
  private openingWorkspaceIndex: Promise<void> | null = null;
  private readonly bodyReads = new InFlightDedupe<string, PromptShortcut>();
  private readonly warmBodies = new Set<string>();
  private prefetchTail: Promise<void> = Promise.resolve();

  constructor(
    readonly store: LocalShortcutStore,
    private readonly remote?: ShortcutPublicationPort
  ) {
    const cached = store.discovery();
    for (const entry of cached.workspaceEntries ?? []) {
      if (entry.workspaceId === this.workspaceId) this.workspaceEntries.set(entry.id, entry);
    }
    for (const id of cached.workspaceDeletedIds ?? []) this.workspaceDeletedIds.add(id);
    this.snapshot = { entries: [], pendingIds: [], errors: {}, loading: false };
    this.publish();
    if (this.remote && typeof this.store.repo?.acquireFlockDoc === 'function') {
      void this.start();
    }
  }

  get workspaceId() {
    return this.store.workspaceId;
  }
  get userId() {
    return this.store.userId;
  }
  getSnapshot = (): ShortcutRuntimeSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get canWrite(): boolean {
    return this.remote?.canWrite?.() ?? true;
  }

  private assertWritable() {
    this.assertActive();
    if (!this.canWrite)
      throw new PromptShortcutError('forbidden', 'Workspace prompts are read-only');
  }

  private assertActive() {
    if (this.disposed) throw new Error('Shortcut runtime disposed');
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    return task;
  }

  private authorized(entry: PromptShortcutIndexEntry) {
    if (entry.workspaceId !== this.workspaceId || this.workspaceDeletedIds.has(entry.id))
      return false;
    const workspaceEntry = this.workspaceEntries.get(entry.id);
    if (!workspaceEntry) return false;
    return (
      workspaceEntry.bodyDocId === entry.bodyDocId &&
      workspaceEntry.ownerUserId === entry.ownerUserId &&
      workspaceEntry.revision === entry.revision
    );
  }

  private isRemotelyDeleted(shortcutId: string) {
    return this.workspaceDeletedIds.has(shortcutId);
  }

  private publish() {
    if (this.disposed) return;
    const entries = new Map<string, PromptShortcutIndexEntry>();
    for (const [id, entry] of this.workspaceEntries) {
      if (!this.workspaceDeletedIds.has(id)) entries.set(id, entry);
    }
    const records = this.store.list();
    for (const row of records) {
      if (row.deleted || (!row.operation && this.isRemotelyDeleted(row.entry.id)))
        entries.delete(row.entry.id);
      else if (
        !entries.has(row.entry.id) ||
        row.operation ||
        entries.get(row.entry.id)?.revision === row.entry.revision
      )
        entries.set(row.entry.id, row.entry);
    }
    this.snapshot = {
      entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)),
      pendingIds: records.filter((row) => row.operation).map((row) => row.entry.id),
      errors: { ...this.errors },
      loading: false,
    };
    const currentBodies = new Set(this.snapshot.entries.map((entry) => this.bodyKey(entry)));
    for (const key of this.warmBodies) {
      if (!currentBodies.has(key)) this.warmBodies.delete(key);
    }
    for (const listener of this.listeners) listener();
  }

  private refreshIndexes() {
    if (this.disposed) return;
    try {
      if (this.workspaceIndex) {
        const deleted = this.workspaceIndex.catalog.deletedIds();
        const active = this.workspaceIndex.catalog
          .list()
          .filter((entry) => entry.workspaceId === this.workspaceId);
        this.workspaceDeletedIds = deleted;
        this.workspaceEntries = new Map(active.map((entry) => [entry.id, entry]));
        void this.store.applyRemoteDeletions(this.workspaceDeletedIds).catch(() => undefined);
      }
      void this.cacheDiscovery().catch(() => undefined);
      this.publish();
    } catch (error) {
      this.errors.directory = error;
      this.publish();
    }
  }

  private cacheDiscovery(): Promise<void> {
    return this.track(
      this.store
        .cacheDiscovery({
          workspaceEntries: [...this.workspaceEntries.values()],
          workspaceDeletedIds: [...this.workspaceDeletedIds],
        })
        .then(() => {
          if (this.errors.storage) {
            delete this.errors.storage;
            this.publish();
          }
        })
        .catch((error) => {
          this.errors.storage = error;
          this.publish();
          throw error;
        })
    );
  }

  start(): Promise<void> {
    if (!this.remote || typeof this.store.repo?.acquireFlockDoc !== 'function')
      return Promise.resolve();
    return this.track(
      this.openWorkspaceIndex()
        .then(() => {
          if (!this.disposed && this.errors.directory) {
            delete this.errors.directory;
            this.publish();
          }
        })
        .catch((error) => {
          if (!this.disposed) {
            this.errors.directory = error;
            this.publish();
          }
        })
    );
  }

  private async openWorkspaceIndex(): Promise<void> {
    while (!this.disposed) {
      const desiredWrite = this.canWrite;
      if (this.workspaceIndex && this.workspaceIndex.write === desiredWrite) return;
      if (this.openingWorkspaceIndex) {
        await this.openingWorkspaceIndex.catch(() => undefined);
        continue;
      }
      const next = (async () => {
        const previous = this.workspaceIndex;
        const id = getWorkspaceShortcutIndexStreamId(this.workspaceId);
        const sync = await this.remote!.acquire(
          { kind: 'workspace-index', workspaceId: this.workspaceId },
          desiredWrite
        );
        let releaseReplica: (() => Promise<void>) | undefined;
        let unsubscribe: (() => void) | undefined;
        let retained = false;
        try {
          const lease = await this.store.repo.acquireFlockDoc(id);
          releaseReplica = () => lease.release();
          const catalog = new PromptShortcutCatalog(lease.flock);
          unsubscribe = lease.flock.subscribe(() => this.refreshIndexes());
          await sync.join();
          if (this.disposed) return;
          this.workspaceIndex = {
            catalog,
            write: desiredWrite,
            close: async () => {
              unsubscribe?.();
              await sync.release();
              await lease.release();
            },
          };
          retained = true;
          if (previous) {
            await previous.close();
          }
          this.refreshIndexes();
        } finally {
          if (!retained) {
            unsubscribe?.();
            await sync.release();
            await releaseReplica?.();
          }
        }
      })().finally(() => {
        if (this.openingWorkspaceIndex === next) {
          this.openingWorkspaceIndex = null;
        }
      });
      this.openingWorkspaceIndex = next;
      await next;
    }
  }

  private bodyKey(entry: PromptShortcutIndexEntry): string {
    return JSON.stringify(entry);
  }

  read(entry: PromptShortcutIndexEntry): Promise<PromptShortcut> {
    this.assertActive();
    const key = this.bodyKey(entry);
    return this.bodyReads.run(key, () =>
      this.track(
        (async () => {
          if (!this.remote && entry.ownerUserId !== this.userId)
            throw new PromptShortcutError('forbidden', 'Wrong local identity');
          const own = this.store.get(entry.id);
          if (own?.deleted || (!own?.operation && this.isRemotelyDeleted(entry.id)))
            throw new PromptShortcutError('not_found', 'Shortcut was deleted');
          const isWorkingCopy =
            entry.ownerUserId === this.userId &&
            own &&
            !own.deleted &&
            JSON.stringify(own.entry) === JSON.stringify(entry);
          if (!isWorkingCopy && this.remote) {
            if (!this.authorized(entry))
              throw new PromptShortcutError('forbidden', 'Shortcut is no longer accessible');
            try {
              const cached = await this.store.read(entry);
              this.assertActive();
              if (!this.authorized(entry))
                throw new PromptShortcutError('forbidden', 'Shortcut access changed');
              return cached;
            } catch (error) {
              if (
                !(error instanceof PromptShortcutError) ||
                !['not_found', 'revision_pending'].includes(error.code)
              )
                throw error;
            }
            // Read `{workspaceId}:shortcut:{bodyDocId}` via workspace token.
            const workspaceSync = await this.remote.acquire(
              {
                kind: 'workspace-body',
                workspaceId: this.workspaceId,
                bodyDocId: entry.bodyDocId,
              },
              false
            );
            try {
              await workspaceSync.sync();
            } finally {
              await workspaceSync.release();
            }
            this.assertActive();
            if (!this.authorized(entry))
              throw new PromptShortcutError('forbidden', 'Shortcut access changed');
          }
          const content = await this.store.read(entry);
          this.assertActive();
          if (
            this.store.get(entry.id)?.deleted ||
            (!isWorkingCopy && this.remote && !this.authorized(entry))
          )
            throw new PromptShortcutError('forbidden', 'Shortcut access changed');
          return content;
        })().then((content) => {
          if (this.snapshot.entries.some((candidate) => this.bodyKey(candidate) === key)) {
            this.warmBodies.add(key);
          }
          return content;
        })
      )
    );
  }

  /** Best-effort, serial warming for current catalog entries. Foreground reads
   * join the same in-flight body request instead of opening another room. */
  prefetch(
    entries: readonly PromptShortcutIndexEntry[],
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    this.assertActive();
    const cancelled = () => this.disposed || (options.signal ? options.signal.aborted : false);
    const run = this.prefetchTail.then(async () => {
      for (const requested of entries) {
        if (cancelled()) return;
        const key = this.bodyKey(requested);
        if (this.warmBodies.has(key)) continue;
        const current = this.snapshot.entries.find((entry) => this.bodyKey(entry) === key);
        if (!current) continue;
        try {
          await this.read(current);
        } catch {
          if (cancelled()) return;
        }
      }
    });
    this.prefetchTail = run.catch(() => undefined);
    return run;
  }

  async save(input: {
    value: PromptShortcut;
    base: PromptShortcutIndexEntry | null;
    bodyDocId?: string;
  }): Promise<PromptShortcutIndexEntry> {
    this.assertWritable();
    if (
      input.base &&
      JSON.stringify(this.snapshot.entries.find((row) => row.id === input.base!.id)) !==
        JSON.stringify(input.base)
    )
      throw new PromptShortcutError('conflict', 'Shortcut changed since editing started');
    if (
      this.snapshot.entries.some(
        (row) => row.id !== input.value.id && row.slug === input.value.slug
      )
    )
      throw new PromptShortcutError('conflict', 'Shortcut slug is already in use');
    return this.track(
      (async () => {
        const record = await this.store.save(input);
        this.publish();
        // Resolve on local durability, not on connectivity. Runtime owns recovery.
        void this.flush();
        return record.entry;
      })()
    );
  }

  remove(entry: PromptShortcutIndexEntry): Promise<void> {
    this.assertWritable();
    return this.track(
      (async () => {
        await this.store.remove(entry);
        this.publish();
        void this.flush();
      })()
    );
  }

  flush(): Promise<void> {
    this.assertActive();
    if (this.flushing) return this.flushing;
    this.flushing = this.track(
      (async () => {
        const attempted = new Set<string>();
        while (!this.disposed && this.canWrite) {
          const record = this.store
            .list()
            .find(
              (row) =>
                row.operation &&
                !attempted.has(`${row.entry.id}:${row.entry.revision}:${row.operation}`)
            );
          if (!record) break;
          attempted.add(`${record.entry.id}:${record.entry.revision}:${record.operation}`);
          try {
            this.assertActive();
            const job = await this.store.preparePublication(record.entry.id);
            if (!job) continue;
            if (this.remote) await this.publishRecord(job);
            this.assertActive();
            await this.store.acknowledge(job);
            if (this.store.get(record.entry.id)?.operation)
              attempted.delete(`${record.entry.id}:${record.entry.revision}:${record.operation}`);
            delete this.errors[record.entry.id];
          } catch (error) {
            this.errors[record.entry.id] = error;
          }
          this.publish();
        }
      })().finally(() => {
        this.flushing = null;
      })
    );
    return this.flushing;
  }

  async retry(): Promise<void> {
    await this.start();
    await this.flush();
  }

  private async mutateWorkspaceIndex(mutate: (catalog: PromptShortcutCatalog) => void) {
    this.assertWritable();
    await this.openWorkspaceIndex();
    this.assertWritable();
    const sync = await this.remote!.acquire(
      { kind: 'workspace-index', workspaceId: this.workspaceId },
      true
    );
    try {
      await sync.sync();
      this.assertWritable();
      const id = getWorkspaceShortcutIndexStreamId(this.workspaceId);
      const lease = await this.store.repo.acquireFlockDoc(id);
      try {
        mutate(new PromptShortcutCatalog(lease.flock));
        await this.store.repo.persistFlockDocNow(id, lease.flock);
        await sync.sync();
      } finally {
        await lease.release();
      }
    } finally {
      await sync.release();
    }
  }

  private async publishRecord(record: ShortcutLocalRecord) {
    const remote = this.remote!;
    const { entry, published } = record;
    if (record.operation === 'delete') {
      await this.mutateWorkspaceIndex((catalog) => catalog.remove(entry.id, entry.revision));
      this.workspaceDeletedIds.add(entry.id);
      this.workspaceEntries.delete(entry.id);
      await this.cacheDiscovery();
      return;
    }

    const value = await this.store.read(entry);
    const bodyStreamId = getWorkspaceShortcutBodyStreamId(this.workspaceId, entry.bodyDocId);
    const body = await remote.acquire(
      { kind: 'workspace-body', workspaceId: this.workspaceId, bodyDocId: entry.bodyDocId },
      true
    );
    try {
      await body.sync();
      this.assertWritable();
      const lease = await this.store.repo.acquireDoc(bodyStreamId);
      try {
        const remoteDoc = new PromptShortcutDocument(lease.doc);
        const heads = remoteDoc.heads();
        const alreadySaved = heads.length === 1 && heads[0]?.revision === value.revision;
        if (!alreadySaved) {
          const expectedParents = heads.length === 0 ? [] : published ? [published.revision] : [];
          remoteDoc.save(value, expectedParents);
          await this.store.repo.persistDocNow(bodyStreamId, lease.doc);
          await body.sync();
        }
      } finally {
        await lease.release();
      }
    } finally {
      await body.release();
    }

    this.assertActive();
    if (this.workspaceDeletedIds.has(entry.id))
      throw new PromptShortcutError('conflict', 'Shortcut was deleted remotely');
    await this.mutateWorkspaceIndex((catalog) => catalog.put(entry));
    this.workspaceEntries.set(entry.id, entry);
    await this.cacheDiscovery();
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.dispose();
    this.listeners.clear();
    await this.remote?.dispose();
    await Promise.allSettled([...this.tasks]);
    await this.workspaceIndex?.close();
    this.workspaceIndex = null;
    await this.store.dispose();
  }
}
