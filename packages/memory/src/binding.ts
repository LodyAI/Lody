/** Durable renderer replicas are not rebuildable workspace caches. */
export const PERSONAL_MEMORY_DATABASE_PREFIX = 'lody-personal-memory:';
/** A binding selects the current Role, never another Role's stored identity. */
export const BUILTIN_MEMORY_BINDING = Object.freeze({ providerId: 'lody', memoryId: 'role' });
export function isBuiltinMemoryBinding(
  binding: { providerId: string; memoryId: string } | undefined
): boolean {
  return (
    binding?.providerId === BUILTIN_MEMORY_BINDING.providerId &&
    binding.memoryId === BUILTIN_MEMORY_BINDING.memoryId
  );
}
export const PERSONAL_MEMORY_ROOM_PREFIX = 'personal-memory/';
export function personalMemoryRoomId(ownerId: string, roleId: string): string {
  return `${PERSONAL_MEMORY_ROOM_PREFIX}${encodeURIComponent(ownerId)}/${encodeURIComponent(roleId)}`;
}
export function personalMemoryRoleFromRoom(roomId: string, ownerId: string): string {
  const prefix = `${PERSONAL_MEMORY_ROOM_PREFIX}${encodeURIComponent(ownerId)}/`;
  if (!roomId.startsWith(prefix)) throw new Error('memory_access_denied');
  const roleId = decodeURIComponent(roomId.slice(prefix.length));
  if (personalMemoryRoomId(ownerId, roleId) !== roomId) throw new Error('memory_access_denied');
  return roleId;
}

/** All arguments come from the host's active invocation and live catalog, never tool input. */
export function authorizePersonalMemoryRole(scope: {
  ownerId: string;
  requesterUserId: string;
  roleId?: string | null;
  binding?: { providerId: string; memoryId: string };
  liveBinding?: { providerId: string; memoryId: string };
}): string {
  if (!isBuiltinMemoryBinding(scope.binding) || !scope.roleId) throw new Error('memory_not_bound');
  if (scope.ownerId !== scope.requesterUserId) throw new Error('memory_access_denied');
  if (!isBuiltinMemoryBinding(scope.liveBinding)) throw new Error('memory_access_revoked');
  return scope.roleId;
}
