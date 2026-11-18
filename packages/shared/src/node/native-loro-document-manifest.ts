import { z } from 'zod';
export const nativeLoroDocumentManifestSchema = z
  .object({
    migrationId: z.string().min(1),
    binding: z.string().min(1),
    namespace: z.string().min(1),
    roomId: z.string().min(1),
    family: z.enum(['preview_comments', 'schedule_definition', 'session']),
    targetGeneration: z.string().min(1),
    sourceIds: z.array(z.string().min(1)),
    origin: z.literal('created').optional(),
    creationIntentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const prefix =
      value.family === 'preview_comments'
        ? 'preview-comment-'
        : value.family === 'session'
          ? 'session-'
          : 'schedule-';
    if (
      !value.roomId.startsWith(prefix) ||
      value.roomId.length === prefix.length ||
      new Set(value.sourceIds).size !== value.sourceIds.length ||
      (value.origin === 'created'
        ? value.sourceIds.length !== 0 || !value.creationIntentSha256
        : value.sourceIds.length === 0 || value.creationIntentSha256 !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid single-document family or source inventory',
      });
  });
export type NativeLoroDocumentManifest = z.infer<typeof nativeLoroDocumentManifestSchema>;
