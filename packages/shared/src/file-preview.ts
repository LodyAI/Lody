import { z } from 'zod';

/**
 * File Preview v3 — the machine-side "just read this file and give it back"
 * protocol used when a user clicks a file to preview it.
 *
 * Why this exists next to the Code Collab v2 `open-text`/`refresh-text` pair:
 * previewing a file is a plain read. It must not activate Code Collab on the
 * machine (workspace watcher, file-index reconcile, All Changes recompute, Flock
 * publication) — that whole apparatus exists for collaborative editing and diffs,
 * not for showing one file. v3 therefore lives in its own `file/preview` method
 * with its own schemas and is explicitly NOT part of the Code Collab surface.
 *
 * What v3 adds over v2 `open-text`:
 * - one method covers both first read and revalidation (`knownDigest`);
 * - binary content (PNG/JPEG/…) is a first-class result instead of an error;
 * - the encoding is explicit on the wire (`utf8-plain` / `utf8-gzip-base64` /
 *   `base64`) so a client never has to infer it from the file path;
 * - every rejection carries a machine-readable code plus the byte numbers the
 *   UI needs to explain a size rejection.
 *
 * v2 `open-text`/`refresh-text` stay on the machine for older clients. Version
 * skew is real: the CLI auto-updates independently of the loaded web bundle.
 */
export const FILE_PREVIEW_PROTOCOL_VERSION = 3;

/**
 * Byte budgets for one preview response.
 *
 * `maxTextBytes` matches the Code Collab raw-text ceiling so a file that opens
 * in the editor also previews. `maxBinaryBytes` is smaller than the text budget
 * on purpose: binary travels base64 (+33%) and cannot be gzip-compressed
 * usefully, so the wire cost is the raw size, and a truncated blob is useless —
 * we refuse rather than render a corrupt image.
 */
export const FILE_PREVIEW_V3_LIMITS = {
  maxTextBytes: 10 * 1024 * 1024,
  maxBinaryBytes: 8 * 1024 * 1024,
  /** At or below this, UTF-8 text ships uncompressed (gzip is not worth it). */
  plainTextBytes: 64 * 1024,
  /** Ceiling on the gzip payload, bounding one Loro Streams append. */
  maxCompressedBytes: 1024 * 1024,
} as const;
export type FilePreviewV3Limits = typeof FILE_PREVIEW_V3_LIMITS;

export const FilePreviewV3DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export type FilePreviewV3Digest = z.infer<typeof FilePreviewV3DigestSchema>;

export const FilePreviewV3TextFormatSchema = z
  .object({
    bom: z.boolean().optional(),
    eol: z.enum(['lf', 'crlf', 'mixed', 'unknown']).optional(),
  })
  .strict();
export type FilePreviewV3TextFormat = z.infer<typeof FilePreviewV3TextFormatSchema>;

/**
 * The transferred bytes. `encoding` is always explicit — the receiver decodes
 * from this field alone and never guesses from the file extension.
 */
export const FilePreviewV3ContentSchema = z.discriminatedUnion('encoding', [
  z
    .object({
      encoding: z.literal('utf8-plain'),
      text: z.string(),
      rawBytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      encoding: z.literal('utf8-gzip-base64'),
      data: z.string(),
      rawBytes: z.number().int().nonnegative(),
      compressedBytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      encoding: z.literal('base64'),
      data: z.string(),
      rawBytes: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type FilePreviewV3Content = z.infer<typeof FilePreviewV3ContentSchema>;

export const FilePreviewV3RequestSchema = z
  .object({
    v: z.literal(FILE_PREVIEW_PROTOCOL_VERSION),
    sessionId: z.string().trim().min(1),
    /**
     * Workspace-relative, or absolute. An absolute path is only served when it
     * resolves inside an allowed root (see the machine-side path policy); this
     * is what makes agent-produced temporary files previewable.
     */
    path: z.string().min(1),
    /**
     * Revalidation: when the machine computes this exact digest the response is
     * `unchanged` and carries no bytes.
     */
    knownDigest: FilePreviewV3DigestSchema.optional(),
    /** Client-side ceiling; the machine still clamps it to its own limits. */
    maxBytes: z.number().int().positive().optional(),
  })
  .strict();
export type FilePreviewV3Request = z.infer<typeof FilePreviewV3RequestSchema>;

export const FilePreviewV3OkSchema = z
  .object({
    status: z.literal('ok'),
    v: z.literal(FILE_PREVIEW_PROTOCOL_VERSION),
    /**
     * Workspace-relative when the file lives in the session workspace, otherwise
     * the absolute path the machine actually read.
     */
    path: z.string().min(1),
    /** True when `path` is outside the session workspace root. */
    external: z.boolean().optional(),
    digest: FilePreviewV3DigestSchema,
    kind: z.enum(['text', 'binary']),
    content: FilePreviewV3ContentSchema,
    /** Present for `kind: 'text'`. */
    format: FilePreviewV3TextFormatSchema.optional(),
    /** Best-effort MIME type, present for `kind: 'binary'`. */
    mimeType: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative(),
    readonly: z.boolean().optional(),
  })
  .strict();
export type FilePreviewV3Ok = z.infer<typeof FilePreviewV3OkSchema>;

export const FilePreviewV3UnchangedSchema = z
  .object({
    status: z.literal('unchanged'),
    v: z.literal(FILE_PREVIEW_PROTOCOL_VERSION),
    path: z.string().min(1),
    external: z.boolean().optional(),
    digest: FilePreviewV3DigestSchema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type FilePreviewV3Unchanged = z.infer<typeof FilePreviewV3UnchangedSchema>;

export const FilePreviewV3ErrorCodeSchema = z.enum([
  'invalid_path',
  /** Resolved outside every allowed root — the security boundary, not an IO failure. */
  'path_not_allowed',
  'session_not_found',
  'workspace_root_unavailable',
  'machine_offline',
  'file_not_found',
  'not_a_file',
  'permission_denied',
  'too_large',
  'decode_error',
  'transient_io',
]);
export type FilePreviewV3ErrorCode = z.infer<typeof FilePreviewV3ErrorCodeSchema>;

export const FilePreviewV3ErrorSchema = z
  .object({
    status: z.literal('error'),
    v: z.literal(FILE_PREVIEW_PROTOCOL_VERSION),
    code: FilePreviewV3ErrorCodeSchema,
    message: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    /** Set with `too_large` so the UI can state the real numbers. */
    sizeBytes: z.number().int().nonnegative().optional(),
    limitBytes: z.number().int().nonnegative().optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
export type FilePreviewV3Error = z.infer<typeof FilePreviewV3ErrorSchema>;

export const FilePreviewV3ResponseSchema = z.discriminatedUnion('status', [
  FilePreviewV3OkSchema,
  FilePreviewV3UnchangedSchema,
  FilePreviewV3ErrorSchema,
]);
export type FilePreviewV3Response = z.infer<typeof FilePreviewV3ResponseSchema>;

export function isFilePreviewV3Error(value: unknown): value is FilePreviewV3Error {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value as { readonly status?: unknown }).status === 'error'
  );
}

export function filePreviewV3Error(
  code: FilePreviewV3ErrorCode,
  options: {
    readonly message?: string;
    readonly path?: string;
    readonly sizeBytes?: number;
    readonly limitBytes?: number;
    readonly retryable?: boolean;
  } = {}
): FilePreviewV3Error {
  return {
    status: 'error',
    v: FILE_PREVIEW_PROTOCOL_VERSION,
    code,
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.sizeBytes === undefined ? {} : { sizeBytes: options.sizeBytes }),
    ...(options.limitBytes === undefined ? {} : { limitBytes: options.limitBytes }),
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
  };
}
