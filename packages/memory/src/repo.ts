import { LoroRepo, type StorageAdapter, type TransportAdapter } from 'loro-repo';
import { initializeMemoryDoc, openMemoryDocument } from './loro.ts';
import { MemoryIdSchema, type MemoryMutationContext } from './schema.ts';
import type { MemoryChange, MemoryResult, MemorySaveReceipt } from './contracts.ts';
import { personalMemoryRoomId } from './binding.ts';

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
  return {
    async open(roleId: string, context: MemoryMutationContext) {
      MemoryIdSchema.parse(roleId);
      const identity = { ownership: 'personal' as const, ownerId, roleId, memoryId: roleId };
      const roomId = personalMemoryRoomId(ownerId, roleId);
      const lease = await repo.acquireDoc(roomId);
      try {
        if (lease.doc.opCount() === 0) {
          const initialized = initializeMemoryDoc(lease.doc, identity, context);
          if (!initialized.ok) throw new Error(initialized.error.code);
          await repo.flush();
        }
        const opened = openMemoryDocument(lease.doc, identity);
        if (!opened.ok) throw new Error(opened.error.code);
        const room = options.localTransport ? await repo.joinDocRoom(roomId) : undefined;
        return {
          memory: opened.value,
          doc: lease.doc,
          async save(result: MemoryResult<MemoryChange>): Promise<MemoryResult<MemorySaveReceipt>> {
            if (!result.ok) return result;
            await repo.flush();
            return {
              ok: true,
              value: {
                change: result.value,
                local: 'saved',
                sync: { state: 'unavailable', reason: 'encrypted_sync_not_ready' },
              },
            };
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
    },
    close: () => repo.destroy(),
  };
}
export type PersonalMemoryRepository = Awaited<ReturnType<typeof createPersonalMemoryRepository>>;
export type PersonalMemoryHandle = Awaited<ReturnType<PersonalMemoryRepository['open']>>;
