import {
  getShortcutIndexStreamId,
  type ShortcutAccessDomain,
  type ShortcutResource,
} from './access';
import { PromptShortcutCatalog, type PromptShortcutIndexEntry } from './catalog';
import { LocalShortcutStore, type ShortcutLocalRecord } from './local-store';
import { PromptShortcutError, type PromptShortcut } from './model';
import type { ShortcutSyncLease } from './sync';

export type ShortcutDirectoryEntry = {
  shortcutId: string;
  bodyDocId: string;
  ownerUserId: string;
  visibility: 'private' | 'workspace';
  revision: string | null;
};
export type ShortcutPublicationPort = {
  acquire(resource: ShortcutResource, write: boolean): Promise<ShortcutSyncLease>;
  stage(record: ShortcutLocalRecord): Promise<void>;
  activate(record: ShortcutLocalRecord): Promise<void>;
  revoke(entry: PromptShortcutIndexEntry): Promise<void>;
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
  private disposed = false;
  private listeners = new Set<() => void>();
  private remoteEntries: PromptShortcutIndexEntry[] = [];
  private directory: readonly ShortcutDirectoryEntry[] = [];
  private directoryVersion = 0;
  private tasks = new Set<Promise<unknown>>();
  private flushing: Promise<void> | null = null;
  private errors: Record<string, unknown> = {};
  private loading: boolean;
  private snapshot: ShortcutRuntimeSnapshot;
  private indexes = new Map<
    string,
    { domain: ShortcutAccessDomain; catalog: PromptShortcutCatalog; close(): Promise<void> }
  >();
  private openingIndexes = new Map<string, Promise<void>>();

  constructor(
    readonly store: LocalShortcutStore,
    private readonly remote?: ShortcutPublicationPort
  ) {
    this.loading = !!remote;
    this.snapshot = { entries: [], pendingIds: [], errors: {}, loading: this.loading };
    this.publish();
  }
  get workspaceId() {
    return this.store.workspaceId;
  }
  get userId() {
    return this.store.userId;
  }
  get canShare() {
    return !!this.remote;
  }
  getSnapshot = (): ShortcutRuntimeSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private assertActive() {
    if (this.disposed) throw new Error('Shortcut runtime disposed');
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    return task;
  }
  private authorized(entry: PromptShortcutIndexEntry) {
    return (
      entry.workspaceId === this.workspaceId &&
      this.directory.some(
        (row) =>
          row.shortcutId === entry.id &&
          row.bodyDocId === entry.bodyDocId &&
          row.ownerUserId === entry.ownerUserId &&
          row.visibility === entry.visibility &&
          row.revision === entry.revision
      )
    );
  }
  private publish() {
    if (this.disposed) return;
    const entries = new Map(
      this.remoteEntries.filter((entry) => this.authorized(entry)).map((entry) => [entry.id, entry])
    );
    const records = this.store.list();
    for (const row of records) {
      if (row.deleted) entries.delete(row.entry.id);
      else if (!this.remote || row.operation) entries.set(row.entry.id, row.entry);
    }
    this.snapshot = {
      entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)),
      pendingIds: records.filter((row) => row.operation).map((row) => row.entry.id),
      errors: { ...this.errors },
      loading: this.loading,
    };
    for (const listener of this.listeners) listener();
  }

  private wantsIndex(domain: ShortcutAccessDomain) {
    return (
      !this.disposed &&
      this.directory.some(
        (row) => row.ownerUserId === domain.ownerUserId && row.visibility === domain.visibility
      )
    );
  }

  private refreshIndexes() {
    if (this.disposed) return;
    try {
      this.remoteEntries = [...this.indexes.values()].flatMap(({ domain, catalog }) =>
        catalog
          .list()
          .filter(
            (entry) =>
              entry.workspaceId === domain.workspaceId &&
              entry.ownerUserId === domain.ownerUserId &&
              entry.visibility === domain.visibility
          )
      );
      this.publish();
    } catch (error) {
      this.errors.directory = error;
      this.publish();
    }
  }

  private openIndex(domain: ShortcutAccessDomain): Promise<void> {
    const id = getShortcutIndexStreamId(domain);
    if (this.indexes.has(id)) return Promise.resolve();
    const opening = this.openingIndexes.get(id);
    if (opening) return opening;
    const next = (async () => {
      const sync = await this.remote!.acquire(
        { kind: 'index', domain },
        domain.ownerUserId === this.userId
      );
      let releaseReplica: (() => Promise<void>) | undefined;
      let unsubscribe: (() => void) | undefined;
      let retained = false;
      try {
        const lease = await this.store.repo.acquireFlockDoc(id);
        releaseReplica = () => lease.release();
        const catalog = new PromptShortcutCatalog(lease.flock);
        unsubscribe = lease.flock.subscribe(() => this.refreshIndexes());
        await sync.sync();
        await sync.join();
        if (!this.wantsIndex(domain)) return;
        this.indexes.set(id, {
          domain,
          catalog,
          close: async () => {
            unsubscribe?.();
            await sync.release();
            await lease.release();
          },
        });
        retained = true;
        this.refreshIndexes();
      } finally {
        if (!retained) {
          unsubscribe?.();
          await sync.release();
          await releaseReplica?.();
        }
      }
    })().finally(() => {
      this.openingIndexes.delete(id);
    });
    this.openingIndexes.set(id, next);
    return next;
  }

  /** Directory controls authorization; live index rooms close the activation →
   * index-upload race. Releasing a one-shot read here can miss publication forever. */
  setDirectory(rows: readonly ShortcutDirectoryEntry[]): Promise<void> {
    this.assertActive();
    this.directory = rows;
    const version = ++this.directoryVersion;
    this.publish(); // Revocation hides stale cache synchronously, before any I/O.
    if (!this.remote) return Promise.resolve();
    return this.track(
      (async () => {
        const domains = new Map(
          rows.map((row) => {
            const domain: ShortcutAccessDomain = {
              workspaceId: this.workspaceId,
              ownerUserId: row.ownerUserId,
              visibility: row.visibility,
            };
            return [getShortcutIndexStreamId(domain), domain];
          })
        );
        for (const [id, index] of this.indexes) {
          if (!domains.has(id)) {
            this.indexes.delete(id);
            await index.close();
          }
        }
        for (const domain of domains.values()) {
          this.assertActive();
          if (version !== this.directoryVersion) return;
          await this.openIndex(domain);
        }
        if (!this.disposed && version === this.directoryVersion) {
          this.loading = false;
          delete this.errors.directory;
          this.refreshIndexes();
        }
      })().catch((error) => {
        if (!this.disposed && version === this.directoryVersion) {
          this.loading = false;
          this.errors.directory = error;
          this.publish();
        }
      })
    );
  }

  read(entry: PromptShortcutIndexEntry): Promise<PromptShortcut> {
    this.assertActive();
    return this.track(
      (async () => {
        if (!this.remote && entry.ownerUserId !== this.userId)
          throw new PromptShortcutError('forbidden', 'Wrong local identity');
        const own = this.store.get(entry.id);
        const isWorkingCopy =
          entry.ownerUserId === this.userId &&
          own &&
          !own.deleted &&
          (!this.remote || own.operation === 'save') &&
          JSON.stringify(own.entry) === JSON.stringify(entry);
        if (!isWorkingCopy && this.remote) {
          if (!this.authorized(entry))
            throw new PromptShortcutError('forbidden', 'Shortcut is no longer accessible');
          // Even cached content must obtain an actual body grant. Only durable own
          // working copies may be opened offline without cloud authorization.
          const sync = await this.remote.acquire(
            { kind: 'body', bodyDocId: entry.bodyDocId },
            entry.ownerUserId === this.userId
          );
          try {
            await sync.sync();
          } finally {
            await sync.release();
          }
          this.assertActive();
          if (!this.authorized(entry))
            throw new PromptShortcutError('forbidden', 'Shortcut access changed');
        }
        this.assertActive();
        return this.store.read(entry);
      })()
    );
  }

  async save(input: {
    value: PromptShortcut;
    base: PromptShortcutIndexEntry | null;
    bodyDocId: string;
  }): Promise<PromptShortcutIndexEntry> {
    this.assertActive();
    if (!this.remote && input.value.visibility !== 'private')
      throw new PromptShortcutError('forbidden', 'Sharing is not supported');
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
    this.assertActive();
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
        while (!this.disposed) {
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
            if (this.remote) await this.publishRecord(record);
            this.assertActive();
            await this.store.acknowledge(record);
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
    await this.flush();
    if (this.remote) await this.setDirectory(this.directory);
  }

  private async mutateIndex(
    entry: PromptShortcutIndexEntry,
    mutate: (catalog: PromptShortcutCatalog) => void
  ) {
    this.assertActive();
    const domain: ShortcutAccessDomain = {
      workspaceId: this.workspaceId,
      ownerUserId: this.userId,
      visibility: entry.visibility,
    };
    const sync = await this.remote!.acquire({ kind: 'index', domain }, true);
    try {
      await sync.sync();
      this.assertActive();
      const id = getShortcutIndexStreamId(domain);
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
      await remote.revoke(entry);
      this.assertActive();
      // Tombstone both domains, including old visibility generations.
      for (const visibility of ['private', 'workspace'] as const)
        await this.mutateIndex({ ...entry, visibility }, (catalog) =>
          catalog.remove(entry.id, entry.revision)
        );
      return;
    }
    await remote.stage(record);
    this.assertActive();
    const body = await remote.acquire({ kind: 'body', bodyDocId: entry.bodyDocId }, true);
    try {
      await body.sync();
      this.assertActive();
      // A remote branch may have arrived during upload. Do not advertise a
      // field-wise winner or silently activate an unresolved conflict.
      await this.store.read(entry);
      // Ensure the index stream exists (with NO staged projection) before a
      // reader learns its domain. Read-only clients cannot create missing rooms.
      await this.mutateIndex(entry, () => {});
      await remote.activate(record);
    } finally {
      await body.release();
    }
    this.assertActive();
    await this.mutateIndex(entry, (catalog) => catalog.put(entry));
    if (published && published.visibility !== entry.visibility)
      await this.mutateIndex(published, (catalog) =>
        catalog.withdraw(entry.id, published.bodyDocId)
      );
    // Keep the acknowledged local result visible until the reactive query catches up.
    this.remoteEntries = [...this.remoteEntries.filter((row) => row.id !== entry.id), entry];
    this.directory = [
      ...this.directory.filter((row) => row.shortcutId !== entry.id),
      {
        shortcutId: entry.id,
        bodyDocId: entry.bodyDocId,
        ownerUserId: entry.ownerUserId,
        visibility: entry.visibility,
        revision: entry.revision,
      },
    ];
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    await this.remote?.dispose();
    await Promise.allSettled([...this.tasks]);
    await Promise.all([...this.indexes.values()].map((index) => index.close()));
    this.indexes.clear();
    await this.store.dispose();
  }
}
