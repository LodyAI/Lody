import { getTodayDocIdPrefix, parseTodayDocId, type TodayDate } from '@lody/shared';
import type { LoroDoc } from 'loro-crdt';
import { createTodayPageStore, type TodayPageStore } from '@/lib/today/today-page-store';
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
    joinRoom(): Promise<{ unsubscribe(): void } | null | undefined>;
  }>;
  isRegistered(docId: string): Promise<boolean>;
  upsertDocMeta(docId: string, meta: { userId: string; date: TodayDate }): Promise<void>;
  unloadDoc(docId: string): Promise<void>;
  /** Snapshot of doc ids under `prefix` plus a tail of existence/metadata events. */
  observeDocs(
    onEvent: (event: { kind: string; docId: string }) => void,
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
  onBackgroundError?: (docId: string, stage: string, error: unknown) => void;
}): TodayPageStoreCache {
  const { repo } = options;
  const stores = createManagedStoreCache<string, TodayPageStore>({
    releaseDelayMs: options.releaseDelayMs,
    unload: (docId) => repo.unloadDoc(docId),
    create: async (docId) => {
      const [handle, registered] = await Promise.all([
        repo.openDoc(docId),
        repo.isRegistered(docId),
      ]);
      return createTodayPageStore({
        docId,
        doc: handle.doc,
        registered,
        join: () => handle.joinRoom(),
        register: (meta) => repo.upsertDocMeta(docId, meta),
        setTimer: options.setTimer,
        onBackgroundError: (stage, error) => options.onBackgroundError?.(docId, stage, error),
      });
    },
  });

  // Idle pages in release order (oldest first) for bounded eviction.
  const idle: string[] = [];
  const forgetIdle = (docId: string) => {
    const index = idle.indexOf(docId);
    if (index >= 0) idle.splice(index, 1);
  };

  return {
    acquire: async (docId) => {
      forgetIdle(docId);
      return stores.acquire(docId);
    },
    releaseRef: (docId) => {
      stores.releaseRef(docId);
      forgetIdle(docId);
      idle.push(docId);
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
      const observation = repo.observeDocs(
        (event) => {
          if (add(event.docId)) emit();
        },
        { prefix: getTodayDocIdPrefix(userId) }
      );
      for (const docId of observation.docIds) add(docId);
      emit();
      return () => observation.unsubscribe();
    },
    releaseIdle: () => stores.releaseIdle(),
    disposeAll: () => stores.disposeAll(),
  };
}
