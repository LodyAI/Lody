import { z } from 'zod';

export const FLOCK_GROUP_MAX_ROOMS = 128;
export const FLOCK_GROUP_MAX_SOURCES = 128;
/** Whole all-window capture budget, including metadata; never silently truncate. */
export const FLOCK_GROUP_MAX_BYTES = 16 * 1024 * 1024;
/** Main constructs the exact complete set. Meta has its own scope and witness;
 * a named-room freeze never grants authority over the workspace directory. */
export const rendererFlockGroupSchema = z
  .object({
    accountId: z.string().min(1).max(512),
    workspaceId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^:\s]+$/),
    domain: z.enum(['machine', 'schedule', 'meta']),
    contentMode: z.literal('plaintext'),
    roomIds: z.array(z.string().min(1).max(1024)).min(1).max(FLOCK_GROUP_MAX_ROOMS),
  })
  .strict()
  .superRefine((group, context) => {
    const sorted = [...new Set(group.roomIds)].sort();
    if (
      JSON.stringify(sorted) !== JSON.stringify(group.roomIds) ||
      (group.domain === 'meta'
        ? group.roomIds.length !== 1 || group.roomIds[0] !== 'meta'
        : group.domain === 'schedule'
          ? group.roomIds.length !== 1 || group.roomIds[0] !== `${group.workspaceId}:sr`
          : group.roomIds.some(
              (id) =>
                !id.startsWith(`${group.workspaceId}:mf:`) ||
                !id.slice(`${group.workspaceId}:mf:`.length) ||
                id.split(':').length !== 3
            ))
    )
      context.addIssue({
        code: 'custom',
        message: 'Expected an exact canonical MF, SR or Meta room set',
      });
  });
export type RendererFlockGroup = z.infer<typeof rendererFlockGroupSchema>;
export const rendererFlockGroupKey = (group: RendererFlockGroup) =>
  JSON.stringify(rendererFlockGroupSchema.parse(group));
/** Exact selected set: independent machines may migrate in independent groups. */
export const rendererFlockGroupScope = (group: RendererFlockGroup) => {
  const parsed = rendererFlockGroupSchema.parse(group);
  return JSON.stringify([
    parsed.accountId,
    parsed.workspaceId,
    parsed.domain,
    parsed.contentMode,
    parsed.roomIds,
  ]);
};
export const rendererFlockGroupOwnerSchema = z
  .object({
    group: rendererFlockGroupSchema,
    revision: z.string().min(1).max(128),
    owner: z.enum(['legacy', 'frozen', 'native']),
  })
  .strict();
export type RendererFlockGroupOwner = z.infer<typeof rendererFlockGroupOwnerSchema>;
export const rendererFlockGroupRegistrationSchema = rendererFlockGroupOwnerSchema
  .extend({
    registrationId: z.string().uuid(),
  })
  .strict();
export type RendererFlockGroupRegistration = z.infer<typeof rendererFlockGroupRegistrationSchema>;
export const rendererFlockGroupRequestSchema = z
  .object({
    group: rendererFlockGroupSchema,
    revision: z.string().min(1).max(128),
    registrationId: z.string().uuid(),
    requestId: z.string().uuid(),
    phase: z.enum(['preflight', 'freeze', 'capture']),
  })
  .strict();
export type RendererFlockGroupRequest = z.infer<typeof rendererFlockGroupRequestSchema>;
export const rendererFlockGroupInventorySchema = z
  .array(
    z
      .object({
        roomId: z.string().min(1).max(1024),
        present: z.boolean(),
        sources: z
          .array(
            z
              .object({
                sourceId: z.string().min(1).max(2048),
                dbName: z.string().min(1).max(1024),
                present: z.boolean(),
                snapshot: z.instanceof(Uint8Array),
                metaSnapshot: z.instanceof(Uint8Array).optional(),
              })
              .strict()
          )
          .max(FLOCK_GROUP_MAX_SOURCES),
      })
      .strict()
  )
  .min(1)
  .max(FLOCK_GROUP_MAX_ROOMS);
export type RendererFlockGroupInventory = z.infer<typeof rendererFlockGroupInventorySchema>;
export const rendererFlockGroupInventoryBytes = (inventory: RendererFlockGroupInventory) => {
  const encoder = new TextEncoder();
  return inventory.reduce(
    (total, room) =>
      total +
      encoder.encode(room.roomId).length +
      64 +
      room.sources.reduce(
        (bytes, source) =>
          bytes +
          source.snapshot.byteLength +
          (source.metaSnapshot?.byteLength ?? 0) +
          encoder.encode(source.sourceId + source.dbName).length +
          64,
        0
      ),
    0
  );
};
export function validateRendererFlockGroupInventory(
  group: RendererFlockGroup,
  input: unknown
): RendererFlockGroupInventory {
  const parsed = rendererFlockGroupSchema.parse(group);
  const inventory = rendererFlockGroupInventorySchema.parse(input);
  if (JSON.stringify(inventory.map((room) => room.roomId)) !== JSON.stringify(parsed.roomIds))
    throw new Error('Frozen inventory must include every exact selected room');
  let databaseNames: string | undefined;
  const prefix = `lody-loro-repo-db-${parsed.workspaceId}`;
  for (const room of inventory) {
    const names = room.sources.map((source) => source.dbName);
    const identity = JSON.stringify([...new Set(names)].sort());
    if (
      identity !== JSON.stringify(names) ||
      (databaseNames !== undefined && identity !== databaseNames) ||
      room.present !== room.sources.some((source) => source.present) ||
      room.sources.some(
        (source) =>
          (source.dbName !== prefix && !source.dbName.startsWith(`${prefix}:`)) ||
          source.sourceId !== `renderer-idb:loro-repo@0.25.0:${source.dbName}` ||
          !source.snapshot.byteLength ||
          (parsed.domain === 'machine' && !source.metaSnapshot?.byteLength)
      )
    )
      throw new Error('Incomplete or mismatched frozen replica inventory');
    databaseNames = identity;
  }
  if (rendererFlockGroupInventoryBytes(inventory) > FLOCK_GROUP_MAX_BYTES)
    throw new Error('Frozen whole-group inventory exceeds byte budget');
  return inventory;
}
export const rendererFlockGroupAckSchema = rendererFlockGroupRequestSchema
  .extend({
    failure: z.enum(['drain_failed', 'capture_failed', 'owner_retired']).optional(),
    inventory: rendererFlockGroupInventorySchema.optional(),
    otherMachineOwners: z.array(z.string().min(1).max(512)).max(128).optional(),
  })
  .strict()
  .superRefine((ack, context) => {
    if (ack.phase === 'preflight') {
      if (
        ack.inventory !== undefined ||
        (ack.failure ? ack.otherMachineOwners !== undefined : ack.otherMachineOwners === undefined)
      )
        context.addIssue({ code: 'custom', message: 'Invalid MF preflight acknowledgement' });
      return;
    }
    if (ack.otherMachineOwners !== undefined)
      context.addIssue({ code: 'custom', message: 'Unexpected MF preflight payload' });
    if (
      ack.failure
        ? ack.inventory !== undefined
        : ack.phase === 'freeze'
          ? ack.inventory !== undefined
          : ack.inventory === undefined
    )
      context.addIssue({ code: 'custom', message: 'Invalid group acknowledgement phase payload' });
    if (ack.inventory) {
      try {
        validateRendererFlockGroupInventory(ack.group, ack.inventory);
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'Incomplete or excessive frozen group inventory',
        });
      }
    }
  });
export type RendererFlockGroupAck = z.infer<typeof rendererFlockGroupAckSchema>;
