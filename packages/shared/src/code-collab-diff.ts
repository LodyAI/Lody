import { z } from 'zod';
import { CodeCollabAllChangesScopeSchema, CodeCollabV2TextFormatSchema } from './code-collab';

export const CODE_COLLAB_DIFF_BLOB_LIMITS = {
  pageBytes: 512 * 1024,
  manifestPaths: 64,
  maxRawBytes: 10 * 1024 * 1024,
  remoteHunkBytes: 256 * 1024,
  maxPatchBytes: 256 * 1024,
} as const;

export const CodeCollabDiffBlobKeySchema = z
  .string()
  .regex(/^(?:git:(?:[0-9a-f]{40}|[0-9a-f]{64})|sha256:[0-9a-f]{64})$/u);
export type CodeCollabDiffBlobKey = z.infer<typeof CodeCollabDiffBlobKeySchema>;

export const CodeCollabDiffBlobSchema = z
  .object({
    key: CodeCollabDiffBlobKeySchema,
    rawBytes: z.number().int().nonnegative().max(CODE_COLLAB_DIFF_BLOB_LIMITS.maxRawBytes),
    format: CodeCollabV2TextFormatSchema,
  })
  .strict();
export type CodeCollabDiffBlob = z.infer<typeof CodeCollabDiffBlobSchema>;

export const CodeCollabDiffManifestEntrySchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    add: z.number().int().nonnegative().optional(),
    del: z.number().int().nonnegative().optional(),
    status: z.enum(['ok', 'binary', 'missing', 'too_large', 'not_changed']),
    base: CodeCollabDiffBlobSchema.nullable(),
    head: CodeCollabDiffBlobSchema.nullable(),
    version: z.string().min(1).optional(),
    hunks: z.string().optional(),
  })
  .strict();
export type CodeCollabDiffManifestEntry = z.infer<typeof CodeCollabDiffManifestEntrySchema>;

export const CodeCollabOpenDiffManifestRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    rootId: z.string().trim().min(1).optional(),
    path: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    scope: CodeCollabAllChangesScopeSchema.optional(),
    focusPath: z.string().min(1).optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type CodeCollabOpenDiffManifestRequest = z.infer<
  typeof CodeCollabOpenDiffManifestRequestSchema
>;

export const CodeCollabOpenDiffManifestResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      base: z.string().optional(),
      entries: z.array(CodeCollabDiffManifestEntrySchema),
      nextCursor: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: z.enum([
        'not_a_git_worktree',
        'no_commits',
        'base_unavailable',
        'turn_unavailable',
        'transient_io',
      ]),
      message: z.string().optional(),
    })
    .strict(),
]);
export type CodeCollabOpenDiffManifestResponse = z.infer<
  typeof CodeCollabOpenDiffManifestResponseSchema
>;

export const CodeCollabReadBlobRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    rootId: z.string().trim().min(1).optional(),
    key: CodeCollabDiffBlobKeySchema,
    offset: z.number().int().nonnegative().safe(),
    length: z.number().int().positive().safe(),
  })
  .strict();
export type CodeCollabReadBlobRequest = z.infer<typeof CodeCollabReadBlobRequestSchema>;
export const CodeCollabReadBlobResponseSchema = z
  .object({
    offset: z.number().int().nonnegative().safe(),
    length: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe(),
    encoding: z.literal('gzip-base64'),
    data: z.string(),
  })
  .strict();
export type CodeCollabReadBlobResponse = z.infer<typeof CodeCollabReadBlobResponseSchema>;

/** Host-supplied transport context; never accepted from request JSON. */
export type CodeCollabDiffReadContext =
  | { readonly plane: 'local'; readonly measureResponse?: never }
  | { readonly plane: 'remote'; readonly measureResponse: (value: unknown) => Promise<number> };
