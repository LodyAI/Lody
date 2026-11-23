import {
  getShortcutIndexStreamId,
  getWorkspaceShortcutBodyStreamId,
  getWorkspaceShortcutIndexStreamId,
  type ShortcutAccessDomain,
  type ShortcutResource,
} from './access';
import { InFlightDedupe } from '../in-flight-dedupe';
import { PromptShortcutCatalog, type PromptShortcutIndexEntry } from './catalog';
import { PromptShortcutDocument } from './document';
import {
  LocalShortcutStore,
  type ShortcutLocalRecord,
  type ShortcutDirectoryEntry,
} from './local-store';
import { PromptShortcutError, type PromptShortcut } from './model';
import { ShortcutSyncTransportError, type ShortcutSyncLease } from './sync';
import { ShortcutLifetime } from './lifetime';

export type { ShortcutDirectoryEntry } from './local-store';
export type ShortcutPublicationPort = {
  acquire(resource: ShortcutResource, write: boolean): Promise<ShortcutSyncLease>;
  /** Optional Phase 1 legacy Convex revocation when deleting an unmigrated legacy shortcut. */
  revokeLegacy?(
    entry: PromptShortcutIndexEntry & { visibility: 'private' | 'workspace' }
  ): Promise<void>;
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
  private legacyEntries: PromptShortcutIndexEntry[] = [];
  private directory: readonly ShortcutDirectoryEntry[] = [];
  private directoryVersion = 0;
  private tasks = new Set<Promise<unknown>>();
  private flushing: Promise<void> | null = null;
  private errors: Record<string, unknown> = {};
  private snapshot: ShortcutRuntimeSnapshot;
  private workspaceIndex: {
    catalog: PromptShortcutCatalog;
    close(): Promise<void>;
  } | null = null;
  private openingWorkspaceIndex: Promise<void> | null = null;
  private legacyIndexes = new Map<
    string,
    { domain: ShortcutAccessDomain; catalog: PromptShortcutCatalog; close(): Promise<void> }
  >();
  private openingLegacyIndexes = new Map<string, Promise<void>>();
  private readonly bodyReads = new InFlightDedupe<string, PromptShortcut>();
  private readonly warmBodies = new Set<string>();
  private prefetchTail: Promise<void> = Promise.resolve();

  constructor(
    readonly store: LocalShortcutStore,
    private readonly remote?: ShortcutPublicationPort
  ) {
    const cached = store.discovery();
    this.directory = cached.directory;
    this.legacyEntries = cached.entries;
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

  private assertActive() {
    if (this.disposed) throw new Error('Shortcut runtime disposed');
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    return task;
  }

  private authorizedLegacy(entry: PromptShortcutIndexEntry) {
    return (
      entry.workspaceId === this.workspaceId &&
      !this.workspaceEntries.has(entry.id) &&
      !this.workspaceDeletedIds.has(entry.id) &&
      this.directory.some(
        (row) =>
          row.shortcutId === entry.id &&
          !row.deleted &&
          row.bodyDocId === entry.bodyDocId &&
          row.ownerUserId === entry.ownerUserId &&
          row.revision === entry.revision &&
          (row.visibility === undefined ||
            row.visibility === 'workspace' ||
            row.ownerUserId === this.userId)
      )
    );
  }

  private authorized(entry: PromptShortcutIndexEntry) {
    if (entry.workspaceId !== this.workspaceId || this.workspaceDeletedIds.has(entry.id))
      return false;
    const workspaceEntry = this.workspaceEntries.get(entry.id);
    if (workspaceEntry) {
      return (
        workspaceEntry.bodyDocId === entry.bodyDocId &&
        workspaceEntry.ownerUserId === entry.ownerUserId &&
        workspaceEntry.revision === entry.revision
      );
    }
    return this.authorizedLegacy(entry);
  }

  private isRemotelyDeleted(shortcutId: string) {
    if (this.workspaceDeletedIds.has(shortcutId)) return true;
    if (this.workspaceEntries.has(shortcutId)) return false;
    return this.directory.some((item) => item.shortcutId === shortcutId && item.deleted);
  }

  private publish() {
    if (this.disposed) return;
    const entries = new Map<string, PromptShortcutIndexEntry>();
    // Legacy entries first so workspace-index entries always take precedence on both id and slug.
    const workspaceSlugs = new Set([...this.workspaceEntries.values()].map((entry) => entry.slug));
    for (const entry of this.legacyEntries) {
      if (this.authorizedLegacy(entry) && !workspaceSlugs.has(entry.slug)) {
        entries.set(entry.id, entry);
      }
    }
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

  private wantsLegacyIndex(domain: ShortcutAccessDomain) {
    return (
      !this.disposed &&
      this.directory.some(
        (row) =>
          !row.deleted &&
          !this.workspaceEntries.has(row.shortcutId) &&
          !this.workspaceDeletedIds.has(row.shortcutId) &&
          row.ownerUserId === domain.ownerUserId &&
          (row.visibility ?? 'workspace') === domain.visibility
      )
    );
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
        void this.store
          .applyRemoteDeletions(this.directory, this.workspaceDeletedIds)
          .catch(() => undefined);
      }
      const liveLegacy = [...this.legacyIndexes.values()].flatMap(({ domain, catalog }) =>
        catalog
          .list()
          .filter(
            (entry) =>
              entry.workspaceId === domain.workspaceId && entry.ownerUserId === domain.ownerUserId
          )
      );
      this.legacyEntries = [
        ...new Map(
          [...this.legacyEntries, ...liveLegacy]
            .filter((entry) => this.authorizedLegacy(entry))
            .map((entry) => [entry.id, entry])
        ).values(),
      ];
      void this.pruneMigratedLegacyIndexes();
      void this.cacheDiscovery().catch(() => undefined);
      this.publish();
    } catch (error) {
      this.errors.directory = error;
      this.publish();
    }
  }

  private async pruneMigratedLegacyIndexes() {
    for (const [id, index] of this.legacyIndexes) {
      if (!this.wantsLegacyIndex(index.domain)) {
        this.legacyIndexes.delete(id);
        await index.close().catch(() => undefined);
      }
    }
  }

  private cacheDiscovery(): Promise<void> {
    return this.track(
      this.store
        .cacheDiscovery({
          directory: [...this.directory],
          entries: this.legacyEntries.filter((entry) => this.authorizedLegacy(entry)),
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

  private openWorkspaceIndex(): Promise<void> {
    if (this.workspaceIndex) return Promise.resolve();
    if (this.openingWorkspaceIndex) return this.openingWorkspaceIndex;
    const id = getWorkspaceShortcutIndexStreamId(this.workspaceId);
    const next = (async () => {
      const sync = await this.remote!.acquire(
        { kind: 'workspace-index', workspaceId: this.workspaceId },
        true
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
        if (this.disposed) return;
        this.workspaceIndex = {
          catalog,
          close: async () => {
            unsubscribe?.();
            await sync.release();
            await lease.release();
          },
        };
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
      this.openingWorkspaceIndex = null;
    });
    this.openingWorkspaceIndex = next;
    return next;
  }

  private openLegacyIndex(domain: ShortcutAccessDomain): Promise<void> {
    const id = getShortcutIndexStreamId(domain);
    if (this.legacyIndexes.has(id)) return Promise.resolve();
    const opening = this.openingLegacyIndexes.get(id);
    if (opening) return opening;
    const next = (async () => {
      const sync = await this.remote!.acquire({ kind: 'index', domain }, false);
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
        if (!this.wantsLegacyIndex(domain)) return;
        this.legacyIndexes.set(id, {
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
      this.openingLegacyIndexes.delete(id);
    });
    this.openingLegacyIndexes.set(id, next);
    return next;
  }

  /**
   * Phase 1 legacy fallback directory: opens read-only legacy `shortcut-index:*` streams
   * ONLY for rows that have not yet landed (or been tombstoned) in `{workspaceId}:shortcut-index`.
   */
  setDirectory(rows: readonly ShortcutDirectoryEntry[]): Promise<void> {
    this.assertActive();
    this.directory = rows;
    const version = ++this.directoryVersion;
    this.publish();
    if (!this.remote) return Promise.resolve();
    return this.track(
      (async () => {
        if (typeof this.store.repo?.acquireFlockDoc === 'function') {
          await this.openWorkspaceIndex();
        }
        await this.store.applyRemoteDeletions(rows, this.workspaceDeletedIds);
        await this.cacheDiscovery();
        const domains = new Map(
          rows
            .filter(
              (row) =>
                !row.deleted &&
                !this.workspaceEntries.has(row.shortcutId) &&
                !this.workspaceDeletedIds.has(row.shortcutId) &&
                (row.visibility === undefined ||
                  row.visibility === 'workspace' ||
                  row.ownerUserId === this.userId)
            )
            .map((row) => {
              const domain: ShortcutAccessDomain = {
                workspaceId: this.workspaceId,
                ownerUserId: row.ownerUserId,
                visibility: row.visibility ?? 'workspace',
              };
              return [getShortcutIndexStreamId(domain), domain];
            })
        );
        for (const [id, index] of this.legacyIndexes) {
          if (!domains.has(id)) {
            this.legacyIndexes.delete(id);
            await index.close();
          }
        }
        for (const domain of domains.values()) {
          this.assertActive();
          if (version !== this.directoryVersion) return;
          await this.openLegacyIndex(domain);
        }
        if (!this.disposed && version === this.directoryVersion) {
          delete this.errors.directory;
          this.refreshIndexes();
        }
      })().catch((error) => {
        if (!this.disposed && version === this.directoryVersion) {
          this.errors.directory = error;
          this.publish();
        }
      })
    );
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
            // Primary read: `{workspaceId}:shortcut:{bodyDocId}` via workspace token.
            let syncedFromWorkspace = false;
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
              syncedFromWorkspace = true;
            } catch (error) {
              if (
                !(
                  error instanceof ShortcutSyncTransportError && error.code === 'stream_not_found'
                ) ||
                !this.authorizedLegacy(entry)
              ) {
                throw error;
              }
            } finally {
              await workspaceSync.release();
            }
            if (!syncedFromWorkspace) {
              const legacySync = await this.remote.acquire(
                { kind: 'body', bodyDocId: entry.bodyDocId },
                false
              );
              try {
                await legacySync.sync();
              } finally {
                await legacySync.release();
              }
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
    this.assertActive();
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
    if (this.remote) await this.setDirectory(this.directory);
  }

  private async mutateWorkspaceIndex(mutate: (catalog: PromptShortcutCatalog) => void) {
    this.assertActive();
    const sync = await this.remote!.acquire(
      { kind: 'workspace-index', workspaceId: this.workspaceId },
      true
    );
    try {
      await sync.sync();
      this.assertActive();
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
      const legacyRow = this.directory.find((row) => row.shortcutId === entry.id && !row.deleted);
      if (legacyRow && remote.revokeLegacy) {
        await this.lifetime.wait(
          remote.revokeLegacy({
            ...entry,
            visibility: legacyRow.visibility ?? 'workspace',
          })
        );
      }
      this.workspaceDeletedIds.add(entry.id);
      this.workspaceEntries.delete(entry.id);
      this.directory = this.directory.filter((row) => row.shortcutId !== entry.id);
      this.legacyEntries = this.legacyEntries.filter((row) => row.id !== entry.id);
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
      this.assertActive();
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
    this.legacyEntries = this.legacyEntries.filter((row) => row.id !== entry.id);
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
    await Promise.all([...this.legacyIndexes.values()].map((index) => index.close()));
    this.legacyIndexes.clear();
    await this.store.dispose();
  }
}
