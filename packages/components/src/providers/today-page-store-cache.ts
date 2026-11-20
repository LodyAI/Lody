import { getTodayDocIdPrefix, parseTodayDocId, type TodayDate } from '@lody/shared';
import type { LoroDoc } from 'loro-crdt';
import {
  createTodayPageStore,
  type TodayPageStore,
  type TodayRoomJoin,
} from '@/lib/today/today-page-store';
import { createManagedStoreCache } from './store-ref-tracker';

/**
 * Runtime-owned cache of open Today pages plus the per-member date index.
 * Viewing keeps a page local until it is registered (spec: viewing creates
 * nothing). Released pages stay warm for `releaseDelayMs`, but at most
 * `idleCap` idle pages are kept: scrolling through many days must not keep
 * every document open. A page someone still holds (viewport, focus,
 * selection, drag source) is never evicted.
 */
export type TodayRepoPort = {
  openDoc(docId: string): Promise<{
    doc: LoroDoc;
    /** Rejects only when no room subscription was produced. */
    joinRoom(signal: AbortSignal): Promise<TodayRoomJoin | null | undefined>;
  }>;
  isRegistered(docId: string): Promise<boolean>;
  upsertDocMeta(docId: string, meta: { userId: string; date: TodayDate }): Promise<void>;
  unloadDoc(docId: string): Promise<void>;
  /**
   * Live (not deleted) doc ids under `prefix`, plus a tail of changes:
   * `exists` turns false when a page is deleted.
   */
  observeDocs(
    onEvent: (event: { docId: string; exists: boolean }) => void,
    query: { prefix: string }
  ): { docIds: readonly string[]; unsubscribe(): void };
};

export type TodayPageStoreCache = {
  acquire(docId: string): Promise<TodayPageStore>;
  releaseRef(docId: string): void;
  peek(docId: string): TodayPageStore | undefined;
  /** Registered dates of one member, newest first. */
  observeDates(userId: string, listener: (dates: readonly TodayDate[]) => void): () => void;
  releaseIdle(): Promise<void>;
  disposeAll(): Promise<void>;
};

export function createTodayPageStoreCache(options: {
  repo: TodayRepoPort;
  releaseDelayMs: number;
  idleCap: number;
  setTimer: (callback: () => void, ms: number) => () => void;
  /** Backoff before retry number `attempt` of a page's failed register or join. */
  retryDelayMs: (attempt: number) => number;
  onBackgroundError?: (docId: string, stage: string, error: unknown) => void;
}): TodayPageStoreCache {
  const { repo } = options;
  const stores = createManagedStoreCache<string, TodayPageStore>({
    releaseDelayMs: options.releaseDelayMs,
    unload: (docId) => repo.unloadDoc(docId),
    create: async (docId) => {
      const [handle, registered] = await Promise.all([
        repo.openDoc(docId),
        // A hint only: an unreadable index must not keep the page from opening.
        // Unregistered pages still register on content, and the date index
        // marks pages a peer registered.
        repo.isRegistered(docId).catch((error: unknown) => {
          options.onBackgroundError?.(docId, 'registered-check', error);
          return false;
        }),
      ]);
      return createTodayPageStore({
        docId,
        doc: handle.doc,
        registered,
        join: (signal) => handle.joinRoom(signal),
        register: (meta) => repo.upsertDocMeta(docId, meta),
        setTimer: options.setTimer,
        retryDelayMs: options.retryDelayMs,
        onBackgroundError: (stage, error) => options.onBackgroundError?.(docId, stage, error),
      });
    },
  });

  // This cache's own references per page, so a page joins the idle queue only
  // when its last holder lets go.
  const held = new Map<string, number>();
  // Idle pages in release order (oldest first) for bounded eviction.
  const idle: string[] = [];
  const forgetIdle = (docId: string) => {
    const index = idle.indexOf(docId);
    if (index >= 0) idle.splice(index, 1);
  };

  return {
    acquire: async (docId) => {
      forgetIdle(docId);
      const store = await stores.acquire(docId);
      held.set(docId, (held.get(docId) ?? 0) + 1);
      return store;
    },
    releaseRef: (docId) => {
      stores.releaseRef(docId);
      const count = (held.get(docId) ?? 0) - 1;
      if (count > 0) {
        held.set(docId, count);
        return;
      }
      held.delete(docId);
      forgetIdle(docId);
      idle.push(docId);
      // Pages the delayed release already closed no longer take a slot.
      for (let index = idle.length - 1; index >= 0; index -= 1) {
        if (!stores.peek(idle[index]!)) idle.splice(index, 1);
      }
      while (idle.length > options.idleCap) {
        const oldest = idle.shift();
        if (oldest) void stores.releaseIfIdle(oldest);
      }
    },
    peek: (docId) => stores.peek(docId),
    observeDates: (userId, listener) => {
      const dates = new Set<TodayDate>();
      const emit = () => listener([...dates].sort().reverse());
      const add = (docId: string) => {
        const page = parseTodayDocId(docId);
        // Prefix scans also match longer ids (`u1` vs `u1-x`): compare exactly.
        if (!page || page.userId !== userId || dates.has(page.date)) return false;
        dates.add(page.date);
        stores.peek(docId)?.markRegistered();
        return true;
      };
      const remove = (docId: string) => {
        const page = parseTodayDocId(docId);
        return Boolean(page && page.userId === userId && dates.delete(page.date));
      };
      const observation = repo.observeDocs(
        (event) => {
          if (event.exists ? add(event.docId) : remove(event.docId)) emit();
        },
        { prefix: getTodayDocIdPrefix(userId) }
      );
      for (const docId of observation.docIds) add(docId);
      emit();
      return () => observation.unsubscribe();
    },
    releaseIdle: async () => {
      idle.length = 0;
      await stores.releaseIdle();
    },
    disposeAll: async () => {
      idle.length = 0;
      held.clear();
      await stores.disposeAll();
    },
  };
}
