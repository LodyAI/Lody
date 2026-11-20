import type { LoroRepo, RepoFlockDocLease } from 'loro-repo';
import { z } from 'zod';
import {
  getLocalShortcutWorkingDocId,
  getShortcutBodyStreamId,
  getWorkspaceShortcutBodyStreamId,
} from './access';
import { parsePromptShortcut } from './compiler';
import { PromptShortcutDocument } from './document';
import {
  projectShortcutIndex,
  PromptShortcutIndexSchema,
  type PromptShortcutIndexEntry,
} from './catalog';
import { PromptShortcutError, shortcutByteLength, type PromptShortcut } from './model';

const recordSchema = z
  .object({
    entry: PromptShortcutIndexSchema,
    published: PromptShortcutIndexSchema.nullable(),
    operation: z.enum(['save', 'delete']).nullable(),
    deleted: z.boolean(),
  })
  .strict();
export type ShortcutLocalRecord = z.infer<typeof recordSchema>;

const directoryEntrySchema = z.object({
  shortcutId: z.string(),
  bodyDocId: z.string(),
  ownerUserId: z.string(),
  visibility: z.enum(['private', 'workspace']).optional(),
  revision: z.string().nullable(),
  deleted: z.boolean().optional(),
});
export type ShortcutDirectoryEntry = z.infer<typeof directoryEntrySchema>;
const discoverySchema = z.object({
  directory: z.array(directoryEntrySchema),
  entries: z.array(PromptShortcutIndexSchema),
  workspaceEntries: z.array(PromptShortcutIndexSchema).optional(),
  workspaceDeletedIds: z.array(z.string()).optional(),
});
export type ShortcutDiscoverySnapshot = z.infer<typeof discoverySchema>;
const intentSchema = z.object({ record: recordSchema, baseRevision: z.string().nullable() });

/** User/workspace-local working catalog. Its pointer-only outbox NEVER joins Streams. */
export class LocalShortcutStore {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly repo: LoroRepo,
    readonly workspaceId: string,
    readonly userId: string,
    private readonly ledger: RepoFlockDocLease,
    private readonly ledgerId: string
  ) {}

  static async open(options: { repo: LoroRepo; workspaceId: string; userId: string }) {
    if (options.repo.hasTransport())
      throw new Error('Shortcut storage must not use workspace transports');
    const id = `shortcut-local:${encodeURIComponent(options.workspaceId)}:${encodeURIComponent(options.userId)}`;
    const store = new LocalShortcutStore(
      options.repo,
      options.workspaceId,
      options.userId,
      await options.repo.acquireFlockDoc(id),
      id
    );
    try {
      await store.recover();
      await store.upgradePublicationProtocol();
      return store;
    } catch (error) {
      await store.dispose();
      throw error;
    }
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private assertOwner(entry: Pick<PromptShortcut, 'workspaceId' | 'ownerUserId'>) {
    if (entry.workspaceId !== this.workspaceId || entry.ownerUserId !== this.userId)
      throw new PromptShortcutError('forbidden', 'Shortcut belongs to another identity');
  }

  get(id: string): ShortcutLocalRecord | null {
    const value = this.ledger.flock.get(['shortcut', id]);
    if (value === undefined || value === null) return null;
    const row = recordSchema.parse(value);
    this.assertOwner(row.entry);
    if (row.entry.id !== id)
      throw new PromptShortcutError('invalid_template', 'Outbox key mismatch');
    if (row.published) {
      this.assertOwner(row.published);
      if (row.published.id !== id)
        throw new PromptShortcutError('invalid_template', 'Publication identity mismatch');
    }
    return row;
  }

  list(): ShortcutLocalRecord[] {
    return [...this.ledger.flock.scan({ prefix: ['shortcut'] })].flatMap((row) => {
      if (row.value === undefined || typeof row.key[1] !== 'string') return [];
      const record = this.get(row.key[1]);
      return record ? [record] : [];
    });
  }

  discovery(): ShortcutDiscoverySnapshot {
    return discoverySchema.parse(
      this.ledger.flock.get(['discovery']) ?? {
        directory: [],
        entries: [],
        workspaceEntries: [],
        workspaceDeletedIds: [],
      }
    );
  }

  applyRemoteDeletions(
    rows: readonly ShortcutDirectoryEntry[],
    workspaceDeletedIds: ReadonlySet<string> = new Set()
  ): Promise<void> {
    return this.serialized(async () => {
      await this.recover();
      const deletedIds = new Set<string>(workspaceDeletedIds);
      for (const row of rows) {
        if (row.deleted && row.ownerUserId === this.userId) deletedIds.add(row.shortcutId);
      }
      for (const shortcutId of deletedIds) {
        const current = this.get(shortcutId);
        // Never erase offline edits because a different device deleted the source.
        if (!current || current.operation || current.deleted) continue;
        await this.put({ ...current, deleted: true, published: null });
      }
    });
  }

  cacheDiscovery(discovery: ShortcutDiscoverySnapshot): Promise<void> {
    return this.serialized(async () => {
      const value = discoverySchema.parse(discovery);
      if (
        value.entries.some((entry) => entry.workspaceId !== this.workspaceId) ||
        (value.workspaceEntries ?? []).some((entry) => entry.workspaceId !== this.workspaceId)
      )
        throw new PromptShortcutError('forbidden', 'Wrong workspace');
      this.ledger.flock.set(['discovery'], JSON.parse(JSON.stringify(value)));
      this.ledger.flock.commit();
      await this.repo.persistFlockDocNow(this.ledgerId, this.ledger.flock);
    });
  }

  publication(id: string): ShortcutLocalRecord | null {
    const value = this.ledger.flock.get(['publication', id]);
    if (value == null) return null;
    const record = recordSchema.parse(value);
    this.assertOwner(record.entry);
    if (record.entry.id !== id) throw new Error('Publication key mismatch');
    return record;
  }

  /**
   * Snapshot the current pending outbox record for upload without rotating `bodyDocId`.
   * Owned working edits live in `shortcut-working:{id}`; the synced body stream
   * `{workspaceId}:shortcut:{bodyDocId}` is updated in-place during publication.
   */
  preparePublication(id: string): Promise<ShortcutLocalRecord | null> {
    return this.serialized(async () => {
      await this.recover();
      const existing = this.publication(id);
      const current = this.get(id);
      if (existing && !current?.deleted && existing.entry.revision === current?.entry.revision)
        return existing;
      if (!current?.operation) return null;
      if (current.operation === 'save') {
        await this.read(current.entry);
      }
      this.ledger.flock.set(['publication', id], JSON.parse(JSON.stringify(current)));
      this.ledger.flock.commit();
      await this.repo.persistFlockDocNow(this.ledgerId, this.ledger.flock);
      return current;
    });
  }

  private async put(record: ShortcutLocalRecord) {
    this.ledger.flock.set(
      ['shortcut', record.entry.id],
      JSON.parse(JSON.stringify(recordSchema.parse(record)))
    );
    this.ledger.flock.commit();
    await this.repo.persistFlockDocNow(this.ledgerId, this.ledger.flock);
  }

  private async clearIntent(id: string) {
    this.ledger.flock.delete(['writeIntent', id]);
    this.ledger.flock.commit();
    await this.repo.persistFlockDocNow(this.ledgerId, this.ledger.flock);
  }

  /**
   * Upgrade earlier local ledgers (v1/v2 stored working copies at `shortcut-body:{bodyDocId}`)
   * so owned working copies live under `shortcut-working:{id}` with stable `bodyDocId`.
   */
  private async upgradePublicationProtocol() {
    const version = this.ledger.flock.get(['publicationProtocol']);
    if (version === 3) return;
    if (version != null && version !== 2)
      throw new Error('Unsupported Shortcut publication protocol');
    for (const record of this.list()) {
      if (!record.deleted) {
        const workingDocId = getLocalShortcutWorkingDocId(record.entry.id);
        const workingLease = await this.repo.acquireDoc(workingDocId);
        try {
          const workingDoc = new PromptShortcutDocument(workingLease.doc);
          if (!workingDoc.read()) {
            const migrated = await this.readFromCandidates([
              getWorkspaceShortcutBodyStreamId(this.workspaceId, record.entry.bodyDocId),
              getShortcutBodyStreamId(record.entry.bodyDocId),
            ]);
            if (migrated) {
              workingDoc.save(migrated, []);
              await this.repo.persistDocNow(workingDocId, workingLease.doc);
            }
          }
        } finally {
          await workingLease.release();
        }
      }
      this.ledger.flock.set(['shortcut', record.entry.id], JSON.parse(JSON.stringify(record)));
      const pub = this.publication(record.entry.id);
      if (pub) {
        this.ledger.flock.set(['publication', record.entry.id], JSON.parse(JSON.stringify(pub)));
      }
    }
    this.ledger.flock.set(['publicationProtocol'], 3);
    this.ledger.flock.commit();
    await this.repo.persistFlockDocNow(this.ledgerId, this.ledger.flock);
  }

  private async readFromCandidates(docIds: readonly string[]): Promise<PromptShortcut | null> {
    for (const docId of docIds) {
      const lease = await this.repo.acquireDoc(docId);
      try {
        const saved = new PromptShortcutDocument(lease.doc).read();
        if (saved) return saved;
      } finally {
        await lease.release();
      }
    }
    return null;
  }

  /** Repair only explicitly journaled bodies. A pre-body crash discards the
   * unacknowledged intent; a post-body crash finishes the working projection. */
  private async recover() {
    for (const row of this.ledger.flock.scan({ prefix: ['writeIntent'] })) {
      if (row.value === undefined) continue;
      const parsed = intentSchema.safeParse(row.value);
      const legacy = parsed.success ? null : recordSchema.parse(row.value);
      const { record, baseRevision } = parsed.success
        ? parsed.data
        : {
            record: legacy!,
            baseRevision: legacy!.published?.revision ?? null,
          };
      this.assertOwner(record.entry);
      if (row.key[1] !== record.entry.id)
        throw new PromptShortcutError('invalid_template', 'Intent identity mismatch');
      const workingId = getLocalShortcutWorkingDocId(record.entry.id);
      const workingLease = await this.repo.acquireDoc(workingId);
      try {
        let saved = new PromptShortcutDocument(workingLease.doc).read();
        if (!saved) {
          const legacyLease = await this.repo.acquireDoc(
            getShortcutBodyStreamId(record.entry.bodyDocId)
          );
          try {
            saved = new PromptShortcutDocument(legacyLease.doc).read();
          } finally {
            await legacyLease.release();
          }
        }
        if (saved?.revision === record.entry.revision) {
          if (
            JSON.stringify(projectShortcutIndex(saved, record.entry.bodyDocId)) !==
            JSON.stringify(record.entry)
          )
            throw new PromptShortcutError('conflict', 'Intent does not match the durable body');
          await this.put(record);
        } else if (saved && saved.revision !== baseRevision) {
          throw new PromptShortcutError('conflict', 'Body advanced beyond the interrupted save');
        }
        await this.clearIntent(record.entry.id);
      } finally {
        await workingLease.release();
      }
    }
  }

  /** Authorization is the runtime's responsibility, including for cached bodies. */
  async read(entry: PromptShortcutIndexEntry): Promise<PromptShortcut> {
    if (entry.workspaceId !== this.workspaceId)
      throw new PromptShortcutError('forbidden', 'Wrong workspace');
    const candidates = [
      ...(entry.ownerUserId === this.userId ? [getLocalShortcutWorkingDocId(entry.id)] : []),
      getWorkspaceShortcutBodyStreamId(this.workspaceId, entry.bodyDocId),
      getShortcutBodyStreamId(entry.bodyDocId),
    ];
    let sawRevisionMismatch = false;
    for (const docId of candidates) {
      const lease = await this.repo.acquireDoc(docId);
      try {
        const content = new PromptShortcutDocument(lease.doc).read();
        if (!content) continue;
        if (
          JSON.stringify(projectShortcutIndex(content, entry.bodyDocId)) === JSON.stringify(entry)
        ) {
          return content;
        }
        sawRevisionMismatch = true;
      } finally {
        await lease.release();
      }
    }
    if (sawRevisionMismatch)
      throw new PromptShortcutError('revision_pending', 'Index and body have not converged');
    throw new PromptShortcutError('not_found', 'Shortcut body is not available');
  }

  save(input: {
    value: unknown;
    bodyDocId?: string;
    base: PromptShortcutIndexEntry | null;
  }): Promise<ShortcutLocalRecord> {
    return this.serialized(async () => {
      await this.recover();
      const value = parsePromptShortcut(input.value);
      this.assertOwner(value);
      const current = this.get(value.id);
      if (current?.deleted) throw new PromptShortcutError('conflict', 'Shortcut was deleted');
      if (current && !input.base)
        throw new PromptShortcutError('conflict', 'Shortcut already exists');
      if (input.base) {
        this.assertOwner(input.base);
        if (input.base.id !== value.id || input.base.createdAt !== value.createdAt)
          throw new PromptShortcutError('conflict', 'Shortcut identity changed');
        if (input.bodyDocId !== undefined && input.bodyDocId !== input.base.bodyDocId)
          throw new PromptShortcutError('conflict', 'Shortcut body document id cannot change');
      }
      const adoptsRemote =
        !!current &&
        !current.operation &&
        !!input.base &&
        JSON.stringify(current.entry) !== JSON.stringify(input.base);
      if (current && !adoptsRemote && JSON.stringify(current.entry) !== JSON.stringify(input.base))
        throw new PromptShortcutError('conflict', 'Shortcut changed since editing started');
      if (adoptsRemote) {
        await this.read(input.base!);
      }
      const bodyDocId = input.base ? input.base.bodyDocId : (input.bodyDocId ?? value.id);
      const entry = projectShortcutIndex(value, bodyDocId);
      const siblings = this.list().filter((row) => !row.deleted && row.entry.id !== value.id);
      if (siblings.some((row) => row.entry.slug === value.slug))
        throw new PromptShortcutError('conflict', 'Shortcut slug is already in use');
      if (
        siblings.length >= 100 ||
        shortcutByteLength(JSON.stringify([...siblings.map((row) => row.entry), entry])) >
          512 * 1024
      )
        throw new PromptShortcutError('size_limit', 'Shortcut catalog exceeds its quota');
      const docId = getLocalShortcutWorkingDocId(value.id);
      const lease = await this.repo.acquireDoc(docId);
      const record: ShortcutLocalRecord = {
        entry,
        published: adoptsRemote
          ? input.base
          : (current?.published ?? (current ? null : input.base)),
        operation: 'save',
        deleted: false,
      };
      try {
        const document = new PromptShortcutDocument(lease.doc);
        const parents = document.heads().map((head) => head.revision);
        document.validateSave(value, parents);
        this.ledger.flock.set(
          ['writeIntent', value.id],
          JSON.parse(JSON.stringify({ record, baseRevision: parents[0] ?? null }))
        );
        this.ledger.flock.commit();
        await this.repo.persistFlockDocNow(this.ledgerId, this.ledger.flock);
        try {
          document.save(value, parents);
        } catch (error) {
          await this.clearIntent(value.id);
          throw error;
        }
        await this.repo.persistDocNow(docId, lease.doc);
      } finally {
        await lease.release();
      }
      // Publication cannot start before body + working catalog are both durable.
      await this.put(record);
      await this.clearIntent(value.id);
      return record;
    });
  }

  remove(entry: PromptShortcutIndexEntry): Promise<void> {
    return this.serialized(async () => {
      await this.recover();
      this.assertOwner(entry);
      const current = this.get(entry.id);
      if (current?.deleted) return;
      if (current?.operation && JSON.stringify(current.entry) !== JSON.stringify(entry))
        throw new PromptShortcutError('conflict', 'Shortcut changed since deletion started');
      await this.put({
        entry,
        published: current?.operation ? current.published : entry,
        operation: 'delete',
        deleted: true,
      });
    });
  }

  acknowledge(record: ShortcutLocalRecord, cancelled = false): Promise<void> {
    return this.serialized(async () => {
      await this.recover();
      const current = this.get(record.entry.id);
      if (!current || JSON.stringify(this.publication(record.entry.id)) !== JSON.stringify(record))
        throw new PromptShortcutError('conflict', 'Publication intent changed');
      const next: ShortcutLocalRecord = {
        ...current,
        published: cancelled ? current.published : record.deleted ? null : record.entry,
        operation:
          !cancelled &&
          current.entry.revision === record.entry.revision &&
          current.deleted === record.deleted
            ? null
            : current.operation,
      };
      this.ledger.flock.set(['shortcut', record.entry.id], JSON.parse(JSON.stringify(next)));
      this.ledger.flock.delete(['publication', record.entry.id]);
      this.ledger.flock.commit();
      await this.repo.persistFlockDocNow(this.ledgerId, this.ledger.flock);
    });
  }

  async dispose() {
    await this.tail;
    await this.ledger.release();
  }
}
