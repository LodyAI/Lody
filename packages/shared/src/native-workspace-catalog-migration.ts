import { z } from 'zod';
import { RENDERER_WF_MAX_BYTES, RENDERER_WF_MAX_SOURCES } from './renderer-room-migration';

export const NATIVE_WF_MIGRATION_STDIN_LIMIT =
  Math.ceil((RENDERER_WF_MAX_BYTES * 4) / 3) + 512 * 1024;
/** Trusted main-to-Node protocol; renderer cannot choose paths, rooms or operations. */
export const nativeWorkspaceCatalogMigrationInputSchema = z
  .object({
    version: z.literal(1),
    accountId: z.string().startsWith('local:').max(512),
    workspaceId: z
      .string()
      .regex(/^lw_[a-zA-Z0-9_-]+$/)
      .max(256),
    dataRoot: z.string().min(1).max(4096),
    revision: z.string().min(1).max(128),
    sources: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(2048),
            snapshotBase64: z
              .string()
              .min(1)
              .max(NATIVE_WF_MIGRATION_STDIN_LIMIT)
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
          })
          .strict()
      )
      .max(RENDERER_WF_MAX_SOURCES),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.sources.map((source) => source.sourceId)).size !== value.sources.length ||
      value.sources.some((source) => source.sourceId === 'daemon-sqlite') ||
      value.sources.reduce((bytes, source) => bytes + (source.snapshotBase64.length * 3) / 4, 0) >
        RENDERER_WF_MAX_BYTES
    )
      context.addIssue({ code: 'custom', message: 'Invalid bounded renderer inventory' });
  });
export type NativeWorkspaceCatalogMigrationInput = z.infer<
  typeof nativeWorkspaceCatalogMigrationInputSchema
>;
export const nativeWorkspaceCatalogMigrationReceiptSchema = z
  .object({
    version: z.literal(1),
    sourceCount: z.number().int().positive(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    engineRunId: z.string().min(1),
    roomTxId: z.number().int().nonnegative(),
    targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
