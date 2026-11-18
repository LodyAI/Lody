import { z } from 'zod';
import { rendererFlockGroupSchema, FLOCK_GROUP_MAX_BYTES } from './renderer-flock-room-group';

const binary = z
  .string()
  .max(Math.ceil(FLOCK_GROUP_MAX_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
/** Main's trusted Node helper input. It never accepts a command, executable,
 * namespace, alternative database path or a renderer-supplied identity. */
export const nativeMachineCatalogMigrationInputSchema = z
  .object({
    version: z.literal(1),
    dataRoot: z.string().min(1).max(4096),
    group: rendererFlockGroupSchema.refine((group) => group.domain === 'machine'),
    revision: z.string().min(1).max(128),
    sources: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(2048),
            metaSnapshotBase64: binary,
            rooms: z
              .array(
                z.object({ roomId: z.string().min(1).max(1024), snapshotBase64: binary }).strict()
              )
              .min(1)
              .max(128),
          })
          .strict()
      )
      .max(128),
  })
  .strict()
  .superRefine((input, context) => {
    let bytes = 0;
    const ids = new Set<string>();
    for (const source of input.sources) {
      bytes += (source.metaSnapshotBase64.length * 3) / 4;
      if (
        ids.has(source.sourceId) ||
        !source.metaSnapshotBase64.length ||
        JSON.stringify(source.rooms.map((room) => room.roomId)) !==
          JSON.stringify(input.group.roomIds)
      )
        context.addIssue({ code: 'custom', message: 'Incomplete or repeated MF source inventory' });
      ids.add(source.sourceId);
      for (const room of source.rooms) {
        bytes += (room.snapshotBase64.length * 3) / 4;
        if (!room.snapshotBase64.length)
          context.addIssue({ code: 'custom', message: 'Empty MF binary source' });
      }
    }
    if (bytes > FLOCK_GROUP_MAX_BYTES)
      context.addIssue({ code: 'custom', message: 'MF source inventory exceeds budget' });
  });
export type NativeMachineCatalogMigrationInput = z.infer<
  typeof nativeMachineCatalogMigrationInputSchema
>;
export const nativeMachineCatalogMigrationReceiptSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1).max(128),
    sourceCount: z.number().int().nonnegative().safe(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rooms: z
      .array(
        z
          .object({
            roomId: z.string().min(1),
            roomTxId: z.number().int().nonnegative().safe(),
            targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
      )
      .min(1)
      .max(128),
  })
  .strict();
export type NativeMachineCatalogMigrationReceipt = z.infer<
  typeof nativeMachineCatalogMigrationReceiptSchema
>;
