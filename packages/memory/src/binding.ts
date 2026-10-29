import { MemoryIdSchema } from './schema';

/** Durable renderer replicas are not rebuildable workspace caches. */
export const PERSONAL_MEMORY_DATABASE_PREFIX = 'lody-personal-memory:';
/** Lody Memory's provider ID in a Role binding. The memory ID names one of the user's memories. */
export const LODY_MEMORY_PROVIDER_ID = 'lody';
export function isBuiltinMemoryBinding(
  binding: { providerId: string; memoryId: string } | undefined
): boolean {
  return (
    binding?.providerId === LODY_MEMORY_PROVIDER_ID &&
    MemoryIdSchema.safeParse(binding.memoryId).success
  );
}
export function lodyMemoryBinding(memoryId: string) {
  return { providerId: LODY_MEMORY_PROVIDER_ID, memoryId: MemoryIdSchema.parse(memoryId) };
}

export const PERSONAL_MEMORY_ROOM_PREFIX = 'personal-memory/';
/** The owner's catalog lives at the owner root; each memory is a child room. */
export function personalMemoryCatalogRoomId(ownerId: string): string {
  return `${PERSONAL_MEMORY_ROOM_PREFIX}${encodeURIComponent(ownerId)}`;
}
export function personalMemoryRoomId(ownerId: string, memoryId: string): string {
  return `${personalMemoryCatalogRoomId(ownerId)}/${encodeURIComponent(memoryId)}`;
}
export type PersonalMemoryRoom = { kind: 'catalog' } | { kind: 'memory'; memoryId: string };
export function parsePersonalMemoryRoom(roomId: string, ownerId: string): PersonalMemoryRoom {
  const catalog = personalMemoryCatalogRoomId(ownerId);
  if (roomId === catalog) return { kind: 'catalog' };
  if (!roomId.startsWith(`${catalog}/`)) throw new Error('memory_access_denied');
  const memoryId = decodeURIComponent(roomId.slice(catalog.length + 1));
  if (
    !MemoryIdSchema.safeParse(memoryId).success ||
    personalMemoryRoomId(ownerId, memoryId) !== roomId
  )
    throw new Error('memory_access_denied');
  return { kind: 'memory', memoryId };
}

/** All arguments come from the host's active invocation and live catalog, never tool input. */
export function authorizePersonalMemory(scope: {
  ownerId: string;
  requesterUserId: string;
  roleId?: string | null;
  binding?: { providerId: string; memoryId: string };
  liveBinding?: { providerId: string; memoryId: string };
  /** Whether the memory is still listed in the owner's Lody Memory catalog. */
  listed: (memoryId: string) => boolean;
}): string {
  if (!isBuiltinMemoryBinding(scope.binding) || !scope.roleId) throw new Error('memory_not_bound');
  if (scope.ownerId !== scope.requesterUserId) throw new Error('memory_access_denied');
  const memoryId = scope.binding!.memoryId;
  if (!isBuiltinMemoryBinding(scope.liveBinding) || scope.liveBinding!.memoryId !== memoryId)
    throw new Error('memory_access_revoked');
  if (!scope.listed(memoryId)) throw new Error('memory_not_found');
  return memoryId;
}
