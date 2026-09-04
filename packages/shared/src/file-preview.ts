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
 * in the editor also previews. `maxBinaryBytes` is smaller on purpose: binary
 * travels base64 (+33%) and does not gzip usefully, so the wire cost IS the raw
 * size, and a truncated blob is useless — we refuse rather than ship a corrupt
 * image.
 *
 * Why binary is pinned to `SESSION_IMAGE_MAX_SIZE_BYTES` (5 MiB) specifically:
 * that is the one budget for this exact payload shape — base64 image bytes in a
 * single Machine RPC response — that is already proven in production. The local
 * project file browser reads images at that cap through `local-project/control`,
 * which takes the same cloud Streams transport whenever the machine is not local
 * (`HARD_LOCAL_PROJECT_READ_MAX_BYTES` in `local-project-control-service.ts`,
 * raised from 1 MB deliberately so screenshots fit). Matching it keeps preview
 * inside demonstrated behavior instead of guessing a new number.
 *
 * NOTE: the gateway's real per-append ceiling is a property of the external Loro
 * Streams service and is not asserted anywhere in this repo. Do not raise these
 * budgets on the assumption that it is large — measure against the real gateway
 * first. `machine-rpc-server.ts` treats a non-404 4xx append failure as
 * non-retryable, so an over-budget response fails the request outright.
 */
export const FILE_PREVIEW_V3_LIMITS = {
  maxTextBytes: 10 * 1024 * 1024,
  maxBinaryBytes: 5 * 1024 * 1024,
  /** At or below this, UTF-8 text ships uncompressed (gzip is not worth it). */
  plainTextBytes: 64 * 1024,
  /** Ceiling on the gzip payload, matching the Code Collab text budget. */
  maxCompressedBytes: 1024 * 1024,
} as const;
export type FilePreviewV3Limits = typeof FILE_PREVIEW_V3_LIMITS;

/**
 * The local IPC response body the same-machine reply has to fit inside.
 *
 * Mirrors `LOCAL_IPC_MAX_RESPONSE_BODY_BYTES` (`node/local-ipc.ts`), which is a
 * node-only module this browser-safe one cannot import. That client DESTROYS
 * the response past the cap, so exceeding it is not a bigger preview — it is an
 * `IpcProtocolError` the facade reports as a retryable I/O failure, i.e. the
 * viewer would say "try again" about a file that will never load. Anything the
 * preview answers with must be bounded by this, not merely by what the disk
 * can produce. The service enforces it on the ENCODED payload; see
 * `apps/cli/src/lib/file-preview/file-preview-service.ts`.
 */
export const FILE_PREVIEW_LOCAL_IPC_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;

/** Room for the JSON envelope around the content (path, digest, mime, format). */
export const FILE_PREVIEW_LOCAL_ENVELOPE_BYTES = 64 * 1024;

/** What one same-machine preview payload may encode to. */
export const FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES =
  FILE_PREVIEW_LOCAL_IPC_RESPONSE_LIMIT_BYTES - FILE_PREVIEW_LOCAL_ENVELOPE_BYTES;

/**
 * Limits for a SAME-MACHINE preview (the Electron `file/preview-local` path).
 *
 * The default limits are shaped by the REMOTE wire: a preview is gzipped and
 * base64'd through Loro Streams, so a 1 MiB compressed ceiling is what keeps
 * one file read off everyone else's connection. Locally there is no such wire,
 * so a 10 MiB "too large to preview" verdict was an artifact of a transport
 * that is not in play — but there IS still a transport, and these numbers are
 * derived from ITS cap rather than from what the disk can hand over:
 *
 * - binary is base64, a fixed 4/3 expansion, so the raw cap is the budget × 3/4.
 * - text is a JSON string, whose escaping is DATA-dependent (a file of newlines
 *   doubles; one of control bytes sextuples), so its raw cap cannot be derived
 *   at all — the service measures the encoded payload and refuses past the
 *   budget, and this number is only a pre-read bound so a huge file is not read
 *   into memory just to be rejected.
 *
 * Past either, opening the file with the OS is the honest answer, which is what
 * the viewer's error card offers.
 */
export const FILE_PREVIEW_V3_LOCAL_LIMITS = {
  maxTextBytes: FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES,
  maxBinaryBytes: Math.floor((FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES * 3) / 4),
  /** No remote wire to compress for, so text always ships as plain UTF-8. */
  plainTextBytes: FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES,
  maxCompressedBytes: FILE_PREVIEW_LOCAL_PAYLOAD_BUDGET_BYTES,
} as const satisfies FilePreviewV3Limits;

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
