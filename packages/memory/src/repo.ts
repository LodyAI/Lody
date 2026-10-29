import { LoroRepo, type StorageAdapter, type TransportAdapter } from 'loro-repo';
import { initializeMemoryDoc, openMemoryDocument } from './loro';
import { MEMORY_ENTRY_PATH, MemoryIdSchema, type MemoryMutationContext } from './schema';
import type { MemoryChange, MemoryResult, MemorySaveReceipt } from './contracts';
import { personalMemoryCatalogRoomId, personalMemoryRoomId } from './binding';
import {
  addMemoryCatalogEntry,
  hasMemoryCatalogEntry,
  listMemoryCatalog,
  removeMemoryCatalogEntry,
} from './catalog';
import { formatMemoryProfile, MemoryProfileSchema, type MemoryProfileInput } from './profile';

/** Separate from the workspace Repo. Hosts supply local storage and, optionally, local IPC. */
export async function createPersonalMemoryRepository(options: {
  ownerId: string;
  storage: StorageAdapter;
  localTransport?: TransportAdapter;
}) {
  const ownerId = MemoryIdSchema.parse(options.ownerId);
  const repo = await LoroRepo.create({ storageAdapter: options.storage, metaDebounceCommitMs: 0 });
  try {
    if (options.localTransport) await repo.addTransport('local', options.localTransport);
  } catch (error) {
    await repo.destroy();
    throw error;
  }
  const savedReceipt = (change: MemoryChange): MemorySaveReceipt => ({
    change,
    local: 'saved',
    sync: { state: 'unavailable', reason: 'encrypted_sync_not_ready' },
  });
  const join = async (roomId: string) => {
    const lease = await repo.acquireDoc(roomId);
    try {
      const room = options.localTransport ? await repo.joinDocRoom(roomId) : undefined;
      return {
        doc: lease.doc,
        async release() {
          room?.unsubscribe();
          await lease.release();
        },
      };
    } catch (error) {
      await lease.release();
      throw error;
    }
  };
  const openCatalog = async () => {
    const room = await join(personalMemoryCatalogRoomId(ownerId));
    return {
      doc: room.doc,
      list: () => listMemoryCatalog(room.doc),
      has: (memoryId: string) => hasMemoryCatalogEntry(room.doc, memoryId),
      release: room.release,
    };
  };
  const open = async (memoryId: string, context: MemoryMutationContext) => {
    MemoryIdSchema.parse(memoryId);
    const identity = { ownership: 'personal' as const, ownerId, memoryId };
    const lease = await repo.acquireDoc(personalMemoryRoomId(ownerId, memoryId));
    try {
      if (lease.doc.opCount() === 0) {
        const initialized = initializeMemoryDoc(lease.doc, identity, context);
        if (!initialized.ok) throw new Error(initialized.error.code);
        await repo.flush();
      }
      const opened = openMemoryDocument(lease.doc, identity);
      if (!opened.ok) throw new Error(opened.error.code);
      const room = options.localTransport
        ? await repo.joinDocRoom(personalMemoryRoomId(ownerId, memoryId))
        : undefined;
      return {
        memoryId,
        memory: opened.value,
        doc: lease.doc,
        async save(result: MemoryResult<MemoryChange>): Promise<MemoryResult<MemorySaveReceipt>> {
          if (!result.ok) return result;
          await repo.flush();
          return { ok: true, value: savedReceipt(result.value) };
        },
        async release() {
          room?.unsubscribe();
          await lease.release();
        },
      };
    } catch (error) {
      await lease.release();
      throw error;
    }
  };
  return {
    open,
    openCatalog,
    /** Borrow a room's Doc for the local data plane without initializing it. */
    acquireRoom: async (roomId: string) => {
      const lease = await repo.acquireDoc(roomId);
      return { doc: lease.doc, release: () => lease.release() };
    },
    /**
     * Create a named memory. The host supplies a fresh memory ID. The profile is written into
     * MEMORY.md before the catalog lists the memory, so a listed memory always has its name.
     */
    async create(
      memoryId: string,
      profile: MemoryProfileInput,
      context: MemoryMutationContext
    ): Promise<MemoryResult<{ memoryId: string }>> {
      const parsed = MemoryProfileSchema.safeParse(profile);
      if (!parsed.success || !MemoryIdSchema.safeParse(memoryId).success)
        return { ok: false, error: { code: 'invalid_input' } };
      const catalog = await openCatalog();
      try {
        if (catalog.has(memoryId)) return { ok: false, error: { code: 'path_exists' } };
        const handle = await open(memoryId, context);
        try {
          const written = handle.memory.update(
            { path: MEMORY_ENTRY_PATH, body: formatMemoryProfile(parsed.data) },
            { ...context, changeId: `${context.changeId}:profile` }
          );
          if (!written.ok) return written;
          await repo.flush();
        } finally {
          await handle.release();
        }
        if (!addMemoryCatalogEntry(catalog.doc, { memoryId, createdAt: context.recordedAt }))
          return { ok: false, error: { code: 'limit_exceeded' } };
        await repo.flush();
        return { ok: true, value: { memoryId } };
      } finally {
        await catalog.release();
      }
    },
    /** Unlist the memory, which revokes Agent access, then hide all of its documents. */
    async remove(memoryId: string): Promise<void> {
      MemoryIdSchema.parse(memoryId);
      const catalog = await openCatalog();
      try {
        removeMemoryCatalogEntry(catalog.doc, memoryId);
        await repo.flush();
      } finally {
        await catalog.release();
      }
      const room = await join(personalMemoryRoomId(ownerId, memoryId));
      try {
        const documents = room.doc.getMap('documents');
        for (const path of documents.keys()) documents.delete(path);
        documents.free();
        room.doc.commit();
        await repo.flush();
      } finally {
        await room.release();
      }
    },
    close: () => repo.destroy(),
  };
}
export type PersonalMemoryRepository = Awaited<ReturnType<typeof createPersonalMemoryRepository>>;
export type PersonalMemoryHandle = Awaited<ReturnType<PersonalMemoryRepository['open']>>;
export type PersonalMemoryCatalogHandle = Awaited<
  ReturnType<PersonalMemoryRepository['openCatalog']>
>;
