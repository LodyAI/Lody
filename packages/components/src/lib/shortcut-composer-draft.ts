import { parseShortcutInvocation } from '@lody/shared/prompt-shortcuts';
import type { Mention } from '@/ui/mention/index';
import { isShortcutMention } from '@/components/mentions/shortcut-composer-state';
import {
  sanitizeMentionRanges,
  toPersistedMentionRanges,
  type PersistedMentionRange,
} from '@/components/mentions/mention-persistence';
import { promptShortcutDatabaseName } from './prompt-shortcut-storage';

export type ShortcutDraftIdentity = { userId: string; workspaceId: string; composerId: string };
export type ShortcutDraftRecord = {
  v: 1;
  text: string;
  mentions: PersistedMentionRange[];
  invocations: Array<{
    start: number;
    end: number;
    value: string;
    data: ReturnType<typeof parseShortcutInvocation>;
  }>;
};
export function shortcutDraftKey(identity: ShortcutDraftIdentity): string {
  return JSON.stringify([identity.userId, identity.workspaceId, identity.composerId]);
}
export function captureShortcutDraft(
  text: string,
  mentions: readonly Mention[]
): ShortcutDraftRecord | null {
  const invocations = mentions
    .filter(isShortcutMention)
    .map(({ start, end, value, data }) => ({ start, end, value, data }));
  if (
    !invocations.length ||
    invocations.some(
      (range) => text.slice(range.start, range.end) !== `/${range.data.snapshot.slug}`
    )
  )
    return null;
  return { v: 1, text, mentions: toPersistedMentionRanges(mentions), invocations };
}
export function parseShortcutDraft(
  value: unknown,
  identity: ShortcutDraftIdentity
): ShortcutDraftRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as ShortcutDraftRecord;
  if (record.v !== 1 || typeof record.text !== 'string' || !Array.isArray(record.invocations))
    return null;
  try {
    const invocations = record.invocations.map((range) => ({
      ...range,
      data: parseShortcutInvocation(range.data),
    }));
    const ids = new Set<string>();
    let end = 0;
    for (const range of [...invocations].sort((a, b) => a.start - b.start)) {
      if (
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < end ||
        range.end <= range.start ||
        range.data.snapshot.workspaceId !== identity.workspaceId ||
        range.value !== range.data.id ||
        ids.has(range.value) ||
        record.text.slice(range.start, range.end) !== `/${range.data.snapshot.slug}`
      )
        return null;
      ids.add(range.value);
      end = range.end;
    }
    const mentions = sanitizeMentionRanges(record.text, record.mentions).filter(
      (range) => range.kind !== 'prompt_shortcut'
    );
    if (
      mentions.some((mention) =>
        invocations.some((range) => mention.start < range.end && mention.end > range.start)
      )
    )
      return null;
    const ordered = [...mentions, ...invocations].sort((a, b) => a.start - b.start);
    if (ordered.some((range, index) => index > 0 && range.start < ordered[index - 1]!.end))
      return null;
    return { v: 1, text: record.text, mentions, invocations };
  } catch {
    return null;
  }
}
export function shortcutDraftMentions(record: ShortcutDraftRecord): Mention[] {
  return [
    ...record.mentions,
    ...record.invocations.map((range) => ({ ...range, kind: 'prompt_shortcut' })),
  ].sort((a, b) => a.start - b.start);
}

export interface ShortcutDraftStorage {
  read(identity: ShortcutDraftIdentity): Promise<unknown>;
  write(identity: ShortcutDraftIdentity, record: ShortcutDraftRecord | null): Promise<void>;
}
/** Separate unsynced database; it shares the domain store's account/workspace naming. */
export const indexedShortcutDraftStorage: ShortcutDraftStorage = {
  read: (identity) => transact(identity, 'readonly'),
  write: (identity, record) => transact(identity, 'readwrite', record).then(() => undefined),
};
function transact(
  identity: ShortcutDraftIdentity,
  mode: IDBTransactionMode,
  record?: ShortcutDraftRecord | null
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(
      `${promptShortcutDatabaseName(identity.workspaceId, identity.userId)}:composer`,
      1
    );
    opening.onupgradeneeded = () => opening.result.createObjectStore('drafts');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction('drafts', mode);
      const store = transaction.objectStore('drafts');
      const request =
        mode === 'readonly'
          ? store.get(identity.composerId)
          : record
            ? store.put(record, identity.composerId)
            : store.delete(identity.composerId);
      transaction.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}

/** Synchronous latest value for remount/promotion; durable writes stay ordered per identity. */
export class ShortcutDraftRepository {
  private memory = new Map<string, ShortcutDraftRecord | null>();
  private writes = new Map<string, Promise<void>>();
  constructor(private storage: ShortcutDraftStorage) {}
  async read(identity: ShortcutDraftIdentity): Promise<ShortcutDraftRecord | null> {
    const key = shortcutDraftKey(identity);
    if (this.memory.has(key)) return this.memory.get(key)!;
    const result = parseShortcutDraft(await this.storage.read(identity), identity);
    // An edit or accepted send while IndexedDB opened always wins.
    if (this.memory.has(key)) return this.memory.get(key)!;
    this.memory.set(key, result);
    return result;
  }
  write(identity: ShortcutDraftIdentity, record: ShortcutDraftRecord | null): Promise<void> {
    const key = shortcutDraftKey(identity);
    this.memory.set(key, record);
    const previous = this.writes.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.storage.write(identity, record));
    this.writes.set(key, pending);
    return pending;
  }
}
export const shortcutDraftRepository = new ShortcutDraftRepository(indexedShortcutDraftStorage);
