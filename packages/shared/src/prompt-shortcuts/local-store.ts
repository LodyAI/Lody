import type { LoroRepo, RepoFlockDocLease } from 'loro-repo';
import { z } from 'zod';
import { getShortcutBodyStreamId } from './access';
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

  /** Repair only explicitly journaled bodies. A pre-body crash discards the
   * unacknowledged intent; a post-body crash finishes the working projection. */
  private async recover() {
    for (const row of this.ledger.flock.scan({ prefix: ['writeIntent'] })) {
      if (row.value === undefined) continue;
      const record = recordSchema.parse(row.value);
      this.assertOwner(record.entry);
      if (row.key[1] !== record.entry.id)
        throw new PromptShortcutError('invalid_template', 'Intent identity mismatch');
      const lease = await this.repo.acquireDoc(getShortcutBodyStreamId(record.entry.bodyDocId));
      try {
        const saved = new PromptShortcutDocument(lease.doc).read();
        if (saved?.revision === record.entry.revision) {
          if (
            JSON.stringify(projectShortcutIndex(saved, record.entry.bodyDocId)) !==
            JSON.stringify(record.entry)
          )
            throw new PromptShortcutError('conflict', 'Intent does not match the durable body');
          await this.put(record);
        } else if (saved && saved.revision !== record.published?.revision) {
          throw new PromptShortcutError('conflict', 'Body advanced beyond the interrupted save');
        }
        await this.clearIntent(record.entry.id);
      } finally {
        await lease.release();
      }
    }
  }

  /** Authorization is the runtime's responsibility, including for cached bodies. */
  async read(entry: PromptShortcutIndexEntry): Promise<PromptShortcut> {
    if (entry.workspaceId !== this.workspaceId)
      throw new PromptShortcutError('forbidden', 'Wrong workspace');
    const lease = await this.repo.acquireDoc(getShortcutBodyStreamId(entry.bodyDocId));
    try {
      const content = new PromptShortcutDocument(lease.doc).read();
      if (!content) throw new PromptShortcutError('not_found', 'Shortcut body is not available');
      if (JSON.stringify(projectShortcutIndex(content, entry.bodyDocId)) !== JSON.stringify(entry))
        throw new PromptShortcutError('revision_pending', 'Index and body have not converged');
      return content;
    } finally {
      await lease.release();
    }
  }

  save(input: {
    value: unknown;
    bodyDocId: string;
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
      }
      // A pending request may already have been accepted remotely. Never replace
      // its retry/CAS identity on an ambiguous response.
      if (current?.operation)
        throw new PromptShortcutError('index_pending', 'Finish the pending publication first');
      const rotates = input.base !== null && input.base.visibility !== value.visibility;
      if (input.base && rotates === (input.base.bodyDocId === input.bodyDocId))
        throw new PromptShortcutError('conflict', 'Visibility changes require a fresh body');
      if (rotates) {
        // The selected source must still match before copying it to a fresh history.
        await this.read(input.base!);
      }
      const entry = projectShortcutIndex(value, input.bodyDocId);
      const siblings = this.list().filter(
        (row) =>
          !row.deleted && row.entry.id !== value.id && row.entry.visibility === value.visibility
      );
      if (siblings.some((row) => row.entry.slug === value.slug))
        throw new PromptShortcutError('conflict', 'Shortcut slug is already in use');
      if (
        siblings.length >= 100 ||
        shortcutByteLength(JSON.stringify([...siblings.map((row) => row.entry), entry])) >
          512 * 1024
      )
        throw new PromptShortcutError('size_limit', 'Shortcut catalog exceeds its quota');
      const docId = getShortcutBodyStreamId(input.bodyDocId);
      const lease = await this.repo.acquireDoc(docId);
      const record: ShortcutLocalRecord = {
        entry,
        published: input.base,
        operation: 'save',
        deleted: false,
      };
      try {
        const document = new PromptShortcutDocument(lease.doc);
        const parents = !input.base || rotates ? [] : [input.base.revision];
        document.validateSave(value, parents);
        this.ledger.flock.set(['writeIntent', value.id], JSON.parse(JSON.stringify(record)));
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
      this.assertOwner(entry);
      const current = this.get(entry.id);
      if (current?.deleted) return;
      if (current?.operation)
        throw new PromptShortcutError('index_pending', 'Finish the pending publication first');
      await this.put({ entry, published: entry, operation: 'delete', deleted: true });
    });
  }

  acknowledge(record: ShortcutLocalRecord): Promise<void> {
    return this.serialized(async () => {
      if (JSON.stringify(this.get(record.entry.id)) !== JSON.stringify(record))
        throw new PromptShortcutError('conflict', 'Publication intent changed');
      await this.put({
        ...record,
        published: record.deleted ? null : record.entry,
        operation: null,
      });
    });
  }

  async dispose() {
    await this.tail;
    await this.ledger.release();
  }
}
