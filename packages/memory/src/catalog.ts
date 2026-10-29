import { LoroDoc, LoroMap, isContainer } from 'loro-crdt';
import { MemoryIdSchema } from './schema';

/**
 * The owner's list of Lody memories: `memories: LoroMap<memoryId, createdAt>`.
 * Names and descriptions belong to each memory's MEMORY.md, not here.
 * Removing a key revokes Agent access; an absent key is never re-added implicitly.
 */
export const MEMORY_CATALOG_LIMIT = 64;
export interface MemoryCatalogEntry {
  readonly memoryId: string;
  readonly createdAt: number;
}

function withMemories<T>(doc: LoroDoc, apply: (memories: LoroMap) => T): T {
  const memories = doc.getMap('memories');
  try {
    return apply(memories);
  } finally {
    memories.free();
  }
}

export function listMemoryCatalog(doc: LoroDoc): MemoryCatalogEntry[] {
  return withMemories(doc, (memories) =>
    memories
      .keys()
      .flatMap((memoryId) => {
        const createdAt = memories.get(memoryId);
        if (isContainer(createdAt)) {
          createdAt.free();
          return [];
        }
        return MemoryIdSchema.safeParse(memoryId).success && typeof createdAt === 'number'
          ? [{ memoryId, createdAt }]
          : [];
      })
      .sort((a, b) => a.createdAt - b.createdAt || (a.memoryId < b.memoryId ? -1 : 1))
  );
}

export function hasMemoryCatalogEntry(doc: LoroDoc, memoryId: string): boolean {
  return listMemoryCatalog(doc).some((entry) => entry.memoryId === memoryId);
}

/** Returns false when the catalog is full; the caller reports it before creating content. */
export function addMemoryCatalogEntry(doc: LoroDoc, entry: MemoryCatalogEntry): boolean {
  const memoryId = MemoryIdSchema.parse(entry.memoryId);
  if (listMemoryCatalog(doc).length >= MEMORY_CATALOG_LIMIT) return false;
  withMemories(doc, (memories) => memories.set(memoryId, entry.createdAt));
  doc.commit();
  return true;
}

export function removeMemoryCatalogEntry(doc: LoroDoc, memoryId: string): void {
  withMemories(doc, (memories) => memories.delete(memoryId));
  doc.commit();
}
