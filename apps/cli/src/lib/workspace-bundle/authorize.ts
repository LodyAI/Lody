import type { Flock } from '@loro-dev/flock-wasm';

/** An existing row changes only where the importer could edit it; one violation rejects the room. */
export type AuthorizationContext = {
  actorUserId: string;
  /** Owner of the machine a machine catalog describes, read from target metadata. */
  machineOwnerUserId?: string;
};

function field(value: unknown, name: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/** Returns a reason when a change is not allowed, otherwise `null`. */
export function authorizeFlockChanges(
  codec: string,
  before: Flock,
  after: Flock,
  context: AuthorizationContext
): string | null {
  for (const row of before.scan()) {
    if (JSON.stringify(after.get(row.key)) === JSON.stringify(row.value)) continue;
    const family = row.key[0];
    if (codec === 'workspace-catalog/v1' && family === 'agentRole') {
      if (field(row.value, 'ownerUserId') !== context.actorUserId)
        return `Changes another member's Agent Role ${String(row.key[1])}`;
    } else if (codec === 'schedule-registry/v1' && family === 'schedule') {
      if (field(row.value, 'ownerId') !== context.actorUserId)
        return `Changes another member's schedule ${String(row.key[1])}`;
    } else if (codec === 'machine-catalog/v1') {
      if (!context.machineOwnerUserId || context.machineOwnerUserId !== context.actorUserId)
        return 'Changes a machine the importer does not own';
    }
  }
  return null;
}
