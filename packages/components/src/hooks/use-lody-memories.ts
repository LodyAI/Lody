import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MEMORY_ENTRY_PATH, readMemoryProfile, type MemoryDocument } from '@lody/memory';
import type { PersonalMemoryHandle } from '@lody/memory/repo';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';

export type LodyMemorySummary = {
  memoryId: string;
  /** Front matter of MEMORY.md; absent only while the entry has not replicated yet. */
  name?: string;
  description?: string;
  createdAt: number;
};
export type LodyMemoriesState =
  | { status: 'unavailable' | 'loading' | 'error'; memories: readonly LodyMemorySummary[] }
  | { status: 'ready'; memories: readonly LodyMemorySummary[] };

/** Read a whole document by following its code-point pages. */
export function readWholeMemoryDocument(memory: MemoryDocument, path: string): string | undefined {
  let page = memory.read({ path });
  if (!page.ok) return undefined;
  let body = page.value.body;
  while (page.ok && page.value.nextOffset !== undefined) {
    page = memory.read({ path, offset: page.value.nextOffset });
    if (page.ok) body += page.value.body;
  }
  return body;
}

/**
 * The signed-in user's Lody memories. It holds every listed memory open while mounted, so
 * their rooms stay joined to the local daemon and a renamed memory updates in place.
 */
export function useLodyMemories(): LodyMemoriesState {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const store = runtime?.personalMemory;
  const [state, setState] = useState<LodyMemoriesState>({
    status: store ? 'loading' : 'unavailable',
    memories: [],
  });
  useEffect(() => {
    if (!store) {
      setState({ status: 'unavailable', memories: [] });
      return () => {};
    }
    let retired = false;
    setState({ status: 'loading', memories: [] });
    const handles = new Map<string, { handle?: PersonalMemoryHandle; stop?: () => void }>();
    let releaseCatalog: (() => Promise<void>) | undefined;
    let stopCatalog: (() => void) | undefined;
    const publish = (entries: readonly { memoryId: string; createdAt: number }[]) => {
      if (retired) return;
      setState({
        status: 'ready',
        memories: entries.map(({ memoryId, createdAt }) => {
          const handle = handles.get(memoryId)?.handle;
          const entry = handle && readWholeMemoryDocument(handle.memory, MEMORY_ENTRY_PATH);
          const profile = readMemoryProfile(entry ?? '');
          return { memoryId, createdAt, name: profile.name, description: profile.description };
        }),
      });
    };
    void (async () => {
      const catalog = await store.openCatalog();
      if (retired) {
        await catalog.release();
        return;
      }
      releaseCatalog = catalog.release;
      const sync = () => {
        const entries = catalog.list();
        const listed = new Set(entries.map((entry) => entry.memoryId));
        for (const [memoryId, slot] of handles) {
          if (listed.has(memoryId)) continue;
          handles.delete(memoryId);
          slot.stop?.();
          void slot.handle?.release();
        }
        for (const { memoryId } of entries) {
          if (handles.has(memoryId)) continue;
          const slot: { handle?: PersonalMemoryHandle; stop?: () => void } = {};
          handles.set(memoryId, slot);
          void store.open(memoryId).then(
            (handle) => {
              if (retired || handles.get(memoryId) !== slot) {
                void handle.release();
                return;
              }
              slot.handle = handle;
              slot.stop = handle.doc.subscribe(() => publish(catalog.list()));
              publish(catalog.list());
            },
            // A memory that cannot open keeps its row without a name.
            () => undefined
          );
        }
        publish(entries);
      };
      stopCatalog = catalog.doc.subscribe(sync);
      sync();
    })().catch(() => {
      if (!retired) setState({ status: 'error', memories: [] });
    });
    return () => {
      retired = true;
      stopCatalog?.();
      for (const slot of handles.values()) {
        slot.stop?.();
        void slot.handle?.release();
      }
      handles.clear();
      void releaseCatalog?.();
    };
  }, [store]);
  return state;
}
