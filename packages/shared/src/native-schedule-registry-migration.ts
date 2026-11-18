import { z } from 'zod';
import {
  rendererFlockGroupSchema,
  FLOCK_GROUP_MAX_BYTES,
  FLOCK_GROUP_MAX_SOURCES,
} from './renderer-flock-room-group';
const binary = z
  .string()
  .min(1)
  .max(Math.ceil(FLOCK_GROUP_MAX_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
/** Trusted main helper input. Only the exact SR room is admitted; Meta and
 * schedule definition bodies retain their existing owners. Every captured DB
 * source includes a complete strict binary even when that room was absent. */
export const nativeScheduleRegistryMigrationInputSchema = z
  .object({
    version: z.literal(1),
    dataRoot: z.string().min(1).max(4096),
    group: rendererFlockGroupSchema.refine((group) => group.domain === 'schedule'),
    revision: z.string().min(1).max(128),
    sources: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(2048),
            present: z.boolean(),
            snapshotBase64: binary,
          })
          .strict()
      )
      .max(FLOCK_GROUP_MAX_SOURCES),
  })
  .strict()
  .superRefine((input, context) => {
    let bytes = 0;
    const ids = new Set<string>();
    for (const source of input.sources) {
      bytes +=
        (source.snapshotBase64.length * 3) / 4 +
        new TextEncoder().encode(source.sourceId).length +
        64;
      if (ids.has(source.sourceId) || source.sourceId === 'daemon-sqlite')
        context.addIssue({ code: 'custom', message: 'Duplicate or reserved SR source identity' });
      ids.add(source.sourceId);
    }
    if (bytes > FLOCK_GROUP_MAX_BYTES)
      context.addIssue({ code: 'custom', message: 'Complete SR inventory exceeds budget' });
  });
export type NativeScheduleRegistryMigrationInput = z.infer<
  typeof nativeScheduleRegistryMigrationInputSchema
>;
export const nativeScheduleRegistryMigrationReceiptSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1).max(128),
    sourceCount: z.number().int().nonnegative().safe(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    roomId: z.string().min(1).max(1024),
    roomTxId: z.number().int().nonnegative().safe(),
    targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type NativeScheduleRegistryMigrationReceipt = z.infer<
  typeof nativeScheduleRegistryMigrationReceiptSchema
>;
