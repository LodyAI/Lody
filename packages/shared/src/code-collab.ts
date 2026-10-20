import { z } from 'zod';

export const CODE_COLLAB_FEATURE_FLAGS = {
  enabled: 'codeCollab.enabled',
  useForNewSessions: 'codeCollab.useForNewSessions',
} as const;

export const CODE_COLLAB_LIMITS = {
  maxSupportedFiles: 100_000,
  maxRealtimeTextBytes: 10 * 1024 * 1024,
  maxRealtimeLineUtf8Bytes: 1024 * 1024,
  maxRealtimeLineUtf16CodeUnits: 200_000,
  binarySniffPrefixBytes: 8 * 1024,
} as const;
export type CodeCollabLimits = {
  maxSupportedFiles: number;
  maxRealtimeTextBytes: number;
  maxRealtimeLineUtf8Bytes: number;
  maxRealtimeLineUtf16CodeUnits: number;
  binarySniffPrefixBytes: number;
};

export const CodeCollabRoleSchema = z.enum(['host', 'write', 'read']);
export type CodeCollabRole = z.infer<typeof CodeCollabRoleSchema>;

export const hasCodeCollabRoleAtLeast = (
  actual: CodeCollabRole,
  required: CodeCollabRole
): boolean => {
  const rank: Record<CodeCollabRole, number> = {
    read: 1,
    write: 2,
    host: 3,
  };
  return rank[actual] >= rank[required];
};

export const CodeCollabLiveHostStateSchema = z.enum([
  'not-started',
  'starting',
  'online',
  'offline',
  'stopping',
  'unsupported',
]);
export type CodeCollabLiveHostState = z.infer<typeof CodeCollabLiveHostStateSchema>;

export const CodeCollabFileSourceStateSchema = z.enum([
  'live-collaborative',
  'live-readonly',
  'historical-turn',
  'host-offline',
  'degraded',
]);
export type CodeCollabFileSourceState = z.infer<typeof CodeCollabFileSourceStateSchema>;

export const CodeCollabProviderKindSchema = z.enum(['code-collab', 'none']);
export type CodeCollabProviderKind = z.infer<typeof CodeCollabProviderKindSchema>;

export const CodeCollabParticipantFreshnessSchema = z.enum([
  'focused',
  'background',
  'idle',
  'disconnected',
]);
export type CodeCollabParticipantFreshness = z.infer<typeof CodeCollabParticipantFreshnessSchema>;

export const CodeCollabFileKindSchema = z.enum([
  'text',
  'binary',
  'large',
  'symlink',
  'special',
  'deleted',
]);
export type CodeCollabFileKind = z.infer<typeof CodeCollabFileKindSchema>;

export const CodeCollabSpecialKindSchema = z.enum([
  'fifo',
  'socket',
  'block-device',
  'char-device',
  'unknown',
]);
export type CodeCollabSpecialKind = z.infer<typeof CodeCollabSpecialKindSchema>;

export const CodeCollabTextEolSchema = z.enum(['lf', 'crlf', 'mixed', 'unknown']);
export type CodeCollabTextEol = z.infer<typeof CodeCollabTextEolSchema>;

export const CodeCollabUnavailableReasonSchema = z.enum([
  'permission-denied',
  'locked',
  'transient-io',
  'text-too-large',
  'line-too-long',
  'unsupported-encoding',
  'unsupported-special',
  'blob-too-large',
  'path-collision',
  'unknown',
]);
export type CodeCollabUnavailableReason = z.infer<typeof CodeCollabUnavailableReasonSchema>;

export const CodeCollabContentUnavailableReasonSchema = z.enum([
  'deleted',
  'metadata-only',
  'missing-text-frontiers',
  'missing-blob-digest',
  'blob-expired',
  ...CodeCollabUnavailableReasonSchema.options,
]);
export type CodeCollabContentUnavailableReason = z.infer<
  typeof CodeCollabContentUnavailableReasonSchema
>;

export const CodeCollabDomainErrorCodeSchema = z.enum([
  'permission-denied',
  'space-not-found',
  'secret-unavailable',
  'streams-unavailable',
  'blob-unavailable',
  'workspace-path-rejected',
  'file-ignored',
  'file-too-large',
  'binary-unsupported',
  'hydration-failed',
  'save-conflict',
  'host-offline',
  'lsp-unavailable',
  'external-file-unavailable',
  'unexpected',
]);
export type CodeCollabDomainErrorCode = z.infer<typeof CodeCollabDomainErrorCodeSchema>;

export type CodeCollabDomainError = {
  code: CodeCollabDomainErrorCode;
  message: string;
  redacted?: boolean;
};

export const CodeCollabDomainErrorSchema = z
  .object({
    code: CodeCollabDomainErrorCodeSchema,
    message: z.string().min(1),
    redacted: z.boolean().optional(),
  })
  .strict();

export const isCodeCollabDomainError = (value: unknown): value is CodeCollabDomainError =>
  CodeCollabDomainErrorSchema.safeParse(value).success;

export const CODE_COLLAB_V2_TEXT_LIMITS = {
  plainTextBytes: 64 * 1024,
  maxCompressedBytes: 1024 * 1024,
  maxRawTextBytes: 10 * 1024 * 1024,
} as const;

// Budgets for the batched All Changes diff RPC (`code-collab/open-all-changes-diff`).
// A file whose compressed snapshot would exceed the per-file cap, or that would push the
// response past the total budget, is returned as a `deferred` entry and lazily fetched by
// the client via the single-file `open-current-diff`. These keep the one-shot batch
// response under the Loro Streams append ceiling while inlining the common case.
export const CODE_COLLAB_V2_ALL_CHANGES_DIFF_LIMITS = {
  perFileMaxCompressedBytes: 256 * 1024,
  responseBudgetCompressedBytes: 2 * 1024 * 1024,
  perFileMaxRawBytes: 1 * 1024 * 1024,
} as const;

export const CodeCollabV2FileDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export type CodeCollabV2FileDigest = z.infer<typeof CodeCollabV2FileDigestSchema>;

export const CodeCollabV2TextFormatSchema = z
  .object({
    encoding: z.literal('utf8'),
    bom: z.boolean().optional(),
    eol: z.enum(['lf', 'crlf', 'mixed', 'unknown']).optional(),
  })
  .strict();
export type CodeCollabV2TextFormat = z.infer<typeof CodeCollabV2TextFormatSchema>;

export const CodeCollabV2EncodedTextPayloadSchema = z.discriminatedUnion('encoding', [
  z
    .object({
      encoding: z.literal('plain'),
      text: z.string(),
      rawBytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      encoding: z.literal('gzip-base64'),
      data: z.string().min(1),
      rawBytes: z.number().int().nonnegative(),
      compressedBytes: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type CodeCollabV2EncodedTextPayload = z.infer<typeof CodeCollabV2EncodedTextPayloadSchema>;

export const CodeCollabV2ErrorCodeSchema = z.enum([
  'invalid_path',
  'session_not_found',
  'workspace_root_unavailable',
  'machine_offline',
  'file_not_found',
  'path_conflict',
  'unsupported_binary',
  'unsupported_skipped',
  'too_large',
  'decode_error',
  'digest_mismatch',
  'permission_denied',
  'transient_io',
  'lsp_not_wired',
]);
export type CodeCollabV2ErrorCode = z.infer<typeof CodeCollabV2ErrorCodeSchema>;

export const CodeCollabV2ErrorSchema = z
  .object({
    status: z.literal('error'),
    code: CodeCollabV2ErrorCodeSchema,
    message: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
export type CodeCollabV2Error = z.infer<typeof CodeCollabV2ErrorSchema>;

export const CodeCollabV2OpenTextRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    path: z.string().min(1),
  })
  .strict();
export type CodeCollabV2OpenTextRequest = z.infer<typeof CodeCollabV2OpenTextRequestSchema>;

export const CodeCollabV2OpenTextOkSchema = z
  .object({
    status: z.literal('ok'),
    path: z.string().min(1),
    digest: CodeCollabV2FileDigestSchema,
    text: CodeCollabV2EncodedTextPayloadSchema,
    format: CodeCollabV2TextFormatSchema.optional(),
    readonly: z.boolean().optional(),
  })
  .strict();
export type CodeCollabV2OpenTextOk = z.infer<typeof CodeCollabV2OpenTextOkSchema>;

export const CodeCollabV2FileIndexRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
  })
  .strict();
export type CodeCollabV2FileIndexRequest = z.infer<typeof CodeCollabV2FileIndexRequestSchema>;

export const CodeCollabV2RefreshTextRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    path: z.string().min(1),
    digest: CodeCollabV2FileDigestSchema,
  })
  .strict();
export type CodeCollabV2RefreshTextRequest = z.infer<typeof CodeCollabV2RefreshTextRequestSchema>;

export const CodeCollabV2RefreshTextResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('up_to_date'),
      path: z.string().min(1),
      digest: CodeCollabV2FileDigestSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('updated'),
      path: z.string().min(1),
      digest: CodeCollabV2FileDigestSchema,
      text: CodeCollabV2EncodedTextPayloadSchema,
      format: CodeCollabV2TextFormatSchema.optional(),
      readonly: z.boolean().optional(),
    })
    .strict(),
]);
export type CodeCollabV2RefreshTextResponse = z.infer<typeof CodeCollabV2RefreshTextResponseSchema>;

export const CodeCollabV2SaveTextRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    requestedByUserId: z.string().trim().min(1),
    path: z.string().min(1),
    baseDigest: CodeCollabV2FileDigestSchema,
    text: CodeCollabV2EncodedTextPayloadSchema,
    format: CodeCollabV2TextFormatSchema.optional(),
  })
  .strict();
export type CodeCollabV2SaveTextRequest = z.infer<typeof CodeCollabV2SaveTextRequestSchema>;

export const CodeCollabV2SaveTextOkSchema = z
  .object({
    status: z.literal('ok'),
    path: z.string().min(1),
    digest: CodeCollabV2FileDigestSchema,
    rawBytes: z.number().int().nonnegative(),
  })
  .strict();
export type CodeCollabV2SaveTextOk = z.infer<typeof CodeCollabV2SaveTextOkSchema>;

export const CodeCollabV2SaveTextConflictSchema = z
  .object({
    status: z.literal('conflict'),
    reason: z.enum(['digest_mismatch', 'path_changed', 'file_deleted', 'path_conflict']),
    path: z.string().min(1),
    baseDigest: CodeCollabV2FileDigestSchema,
    diskDigest: CodeCollabV2FileDigestSchema.optional(),
    diskText: CodeCollabV2EncodedTextPayloadSchema.optional(),
  })
  .strict();
export type CodeCollabV2SaveTextConflict = z.infer<typeof CodeCollabV2SaveTextConflictSchema>;

export const CodeCollabV2SaveTextResponseSchema = z.discriminatedUnion('status', [
  CodeCollabV2SaveTextOkSchema,
  CodeCollabV2SaveTextConflictSchema,
]);
export type CodeCollabV2SaveTextResponse = z.infer<typeof CodeCollabV2SaveTextResponseSchema>;

// Workspace comparison scope for All Changes. `branch` compares against the resolved
// merge-base (committed branch changes + uncommitted + untracked); `uncommitted`
// compares HEAD against the working tree (staged + unstaged + untracked).
export const CodeCollabAllChangesScopeSchema = z.enum(['branch', 'uncommitted']);
export type CodeCollabAllChangesScope = z.infer<typeof CodeCollabAllChangesScopeSchema>;

export const CodeCollabV2OpenCurrentDiffRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    path: z.string().min(1),
    scope: CodeCollabAllChangesScopeSchema.optional(),
  })
  .strict();
export type CodeCollabV2OpenCurrentDiffRequest = z.infer<
  typeof CodeCollabV2OpenCurrentDiffRequestSchema
>;

export const CodeCollabV2DiffSnapshotSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      text: CodeCollabV2EncodedTextPayloadSchema,
      format: CodeCollabV2TextFormatSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('missing') }).strict(),
  z.object({ kind: z.literal('binary') }).strict(),
  z.object({ kind: z.literal('too_large') }).strict(),
]);
export type CodeCollabV2DiffSnapshot = z.infer<typeof CodeCollabV2DiffSnapshotSchema>;

export const CodeCollabV2OpenCurrentDiffResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      path: z.string().min(1),
      oldSnapshot: CodeCollabV2DiffSnapshotSchema,
      newSnapshot: CodeCollabV2DiffSnapshotSchema,
      add: z.number().int().nonnegative().optional(),
      del: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      path: z.string().min(1),
      reason: z.enum([
        'base_unavailable',
        'not_changed',
        'transient_io',
        'unsupported_binary',
        'not_a_git_worktree',
        'no_commits',
      ]),
      message: z.string().min(1).optional(),
    })
    .strict(),
]);
export type CodeCollabV2OpenCurrentDiffResponse = z.infer<
  typeof CodeCollabV2OpenCurrentDiffResponseSchema
>;

// Batched All Changes diff: one request returns every changed file's current diff
// (disk vs base) in a single response. The file set + base match `computeAllChanges`
// (tracked vs merge-base + untracked by default; HEAD vs disk when `scope` is
// `uncommitted`). Files too large to inline come back `deferred` and are lazily
// fetched via `open-current-diff` with the same scope.
export const CodeCollabV2OpenAllChangesDiffRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    // Inline this file first (the file the user clicked) regardless of size ordering.
    focusPath: z.string().min(1).optional(),
    scope: CodeCollabAllChangesScopeSchema.optional(),
  })
  .strict();
export type CodeCollabV2OpenAllChangesDiffRequest = z.infer<
  typeof CodeCollabV2OpenAllChangesDiffRequestSchema
>;

export const CodeCollabV2AllChangesDiffEntrySchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      path: z.string().min(1),
      oldSnapshot: CodeCollabV2DiffSnapshotSchema,
      newSnapshot: CodeCollabV2DiffSnapshotSchema,
      add: z.number().int().nonnegative().optional(),
      del: z.number().int().nonnegative().optional(),
    })
    .strict(),
  // Content exists but was not inlined (over per-file cap or total budget) — the client
  // fetches it on demand via `open-current-diff`. Line stats still ship for the list.
  z
    .object({
      status: z.literal('deferred'),
      path: z.string().min(1),
      add: z.number().int().nonnegative().optional(),
      del: z.number().int().nonnegative().optional(),
    })
    .strict(),
  // Terminal: file is in the change list but its base snapshot equals disk (no real diff
  // vs base). Binary / too-large files are NOT unavailable — they ship as `ok` with a
  // `binary` / `too_large` snapshot, matching single-file `open-current-diff`.
  z
    .object({
      status: z.literal('unavailable'),
      path: z.string().min(1),
      reason: z.enum(['not_changed']),
      add: z.number().int().nonnegative().optional(),
      del: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type CodeCollabV2AllChangesDiffEntry = z.infer<typeof CodeCollabV2AllChangesDiffEntrySchema>;

export const CodeCollabV2OpenAllChangesDiffResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      // Resolved diff base for diagnostics/consistency: merge-base sha (git) or a source
      // marker like `diff-store` (non-git).
      base: z.string().min(1),
      entries: z.array(CodeCollabV2AllChangesDiffEntrySchema),
      // True when any entry is `deferred` (UI can hint "some files load on demand").
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: z.enum(['base_unavailable', 'transient_io', 'not_a_git_worktree', 'no_commits']),
      message: z.string().min(1).optional(),
    })
    .strict(),
]);
export type CodeCollabV2OpenAllChangesDiffResponse = z.infer<
  typeof CodeCollabV2OpenAllChangesDiffResponseSchema
>;

export const CodeCollabV2OpenTurnDiffRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    turnId: z.string().trim().min(1),
    path: z.string().min(1),
  })
  .strict();
export type CodeCollabV2OpenTurnDiffRequest = z.infer<typeof CodeCollabV2OpenTurnDiffRequestSchema>;

export const CodeCollabV2OpenTurnDiffResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      path: z.string().min(1),
      turnId: z.string().trim().min(1),
      oldSnapshot: CodeCollabV2DiffSnapshotSchema,
      newSnapshot: CodeCollabV2DiffSnapshotSchema,
      add: z.number().int().nonnegative().optional(),
      del: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      path: z.string().min(1),
      turnId: z.string().trim().min(1),
      reason: z.enum(['turn_unavailable', 'not_changed', 'transient_io']),
      message: z.string().min(1).optional(),
    })
    .strict(),
]);
export type CodeCollabV2OpenTurnDiffResponse = z.infer<
  typeof CodeCollabV2OpenTurnDiffResponseSchema
>;

export const CodeCollabV2InitDirectoryRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    path: z.string().min(1),
  })
  .strict();
export type CodeCollabV2InitDirectoryRequest = z.infer<
  typeof CodeCollabV2InitDirectoryRequestSchema
>;

export const CodeCollabV2InitDirectoryOkSchema = z
  .object({
    status: z.literal('ok'),
    path: z.string().min(1),
    publishedEntries: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CodeCollabV2InitDirectoryOk = z.infer<typeof CodeCollabV2InitDirectoryOkSchema>;

export const CodeCollabV2LspUnsupportedSchema = z
  .object({
    status: z.literal('unsupported'),
    code: z.literal('lsp_not_wired'),
  })
  .strict();
export type CodeCollabV2LspUnsupported = z.infer<typeof CodeCollabV2LspUnsupportedSchema>;

export const CodeCollabV2FileTreeValueSchema = z.union([
  z.literal(true),
  z.object({ kind: z.literal('lazy') }).strict(),
  z.object({ kind: z.literal('binary') }).strict(),
  z
    .object({
      kind: z.literal('skipped'),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('too_large'),
      rawBytes: z.number().int().nonnegative().optional(),
      compressedBytes: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type CodeCollabV2FileTreeValue = z.infer<typeof CodeCollabV2FileTreeValueSchema>;

export const CodeCollabV2FileTreeStateSchema = z.record(
  z.string().min(1),
  CodeCollabV2FileTreeValueSchema
);
export type CodeCollabV2FileTreeState = z.infer<typeof CodeCollabV2FileTreeStateSchema>;

export const CodeCollabV2AllChangesValueSchema = z.union([
  z.literal(true),
  z
    .object({
      diff: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
      del: z.literal(true).optional(),
    })
    .strict(),
]);
export type CodeCollabV2AllChangesValue = z.infer<typeof CodeCollabV2AllChangesValueSchema>;

export const CodeCollabV2AllChangesStateSchema = z.record(
  z.string().min(1),
  CodeCollabV2AllChangesValueSchema
);
export type CodeCollabV2AllChangesState = z.infer<typeof CodeCollabV2AllChangesStateSchema>;

export const CodeCollabV2FileIndexValueSchema = z.union([
  z.literal(true),
  z
    .object({
      kind: z.literal('file'),
      change: CodeCollabV2AllChangesValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      change: CodeCollabV2AllChangesValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('binary'),
      change: CodeCollabV2AllChangesValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('too_large'),
      rawBytes: z.number().int().nonnegative().optional(),
      compressedBytes: z.number().int().nonnegative().optional(),
      change: CodeCollabV2AllChangesValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('deleted'),
      change: CodeCollabV2AllChangesValueSchema,
    })
    .strict(),
  z.object({ kind: z.literal('lazy') }).strict(),
  z
    .object({
      kind: z.literal('skipped'),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type CodeCollabV2FileIndexValue = z.infer<typeof CodeCollabV2FileIndexValueSchema>;

export const CodeCollabV2FileIndexStateSchema = z.record(
  z.string().min(1),
  CodeCollabV2FileIndexValueSchema
);
export type CodeCollabV2FileIndexState = z.infer<typeof CodeCollabV2FileIndexStateSchema>;

export const CodeCollabV2FileIndexSnapshotSchema = z
  .object({
    status: z.literal('ok'),
    ownerSessionId: z.string().trim().min(1),
    fileIndex: CodeCollabV2FileIndexStateSchema,
    updatedAtMs: z.number().finite().nonnegative(),
  })
  .strict();
export type CodeCollabV2FileIndexSnapshot = z.infer<typeof CodeCollabV2FileIndexSnapshotSchema>;

export type CodeCollabFileIndexFlockRow = {
  readonly key: readonly unknown[];
  readonly value?: unknown;
};

export type CodeCollabFileIndexFlockEvent = {
  readonly key: readonly unknown[];
  readonly value?: unknown;
};

export type CodeCollabFileIndexReadableFlock = {
  scan(): Iterable<CodeCollabFileIndexFlockRow>;
};

export type CodeCollabFileIndexWritableFlock = CodeCollabFileIndexReadableFlock & {
  set(key: [string], value: unknown, timestamp?: number): void;
  delete(key: [string], timestamp?: number): void;
  commit(): void;
};

export type CodeCollabFileIndexSignal = {
  readonly v: 1;
  readonly r: number;
};

const CODE_COLLAB_FILE_INDEX_SIGNAL_KEY: [string] = ['s'];

const codeCollabFileIndexKeyForWorkspacePath = (workspacePath: string): [string] => [workspacePath];

const isCodeCollabRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCodeCollabMissing = (value: unknown): value is null | undefined =>
  value === undefined || value === null;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const hasOnlyCodeCollabKeys = (
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): boolean => Object.keys(value).every((key) => allowedKeys.includes(key));

const normalizeCodeCollabAllChangesValue = (
  value: unknown
): CodeCollabV2AllChangesValue | undefined => {
  if (value === true) {
    return true;
  }
  if (!isCodeCollabRecord(value) || !hasOnlyCodeCollabKeys(value, ['diff', 'del'])) {
    return undefined;
  }

  const change: { diff?: [number, number]; del?: true } = {};
  if (!isCodeCollabMissing(value.diff)) {
    if (
      !Array.isArray(value.diff) ||
      value.diff.length !== 2 ||
      !isNonNegativeInteger(value.diff[0]) ||
      !isNonNegativeInteger(value.diff[1])
    ) {
      return undefined;
    }
    change.diff = [value.diff[0], value.diff[1]];
  }
  if (!isCodeCollabMissing(value.del)) {
    if (value.del !== true) {
      return undefined;
    }
    change.del = true;
  }
  return change;
};

type OptionalCodeCollabValue<T> = { ok: true; value?: T } | { ok: false };

const normalizeOptionalCodeCollabAllChangesValue = (
  value: unknown
): OptionalCodeCollabValue<CodeCollabV2AllChangesValue> => {
  if (isCodeCollabMissing(value)) {
    return { ok: true };
  }
  const normalized = normalizeCodeCollabAllChangesValue(value);
  return normalized === undefined ? { ok: false } : { ok: true, value: normalized };
};

const normalizeCodeCollabFileIndexValue = (
  value: unknown
): CodeCollabV2FileIndexValue | undefined => {
  if (value === true) {
    return true;
  }
  if (!isCodeCollabRecord(value)) {
    return undefined;
  }

  switch (value.kind) {
    case 'file':
    case 'text':
    case 'binary': {
      if (!hasOnlyCodeCollabKeys(value, ['kind', 'change'])) {
        return undefined;
      }
      const change = normalizeOptionalCodeCollabAllChangesValue(value.change);
      if (!change.ok) {
        return undefined;
      }
      return change.value === undefined
        ? { kind: value.kind }
        : { kind: value.kind, change: change.value };
    }
    case 'too_large': {
      if (!hasOnlyCodeCollabKeys(value, ['kind', 'rawBytes', 'compressedBytes', 'change'])) {
        return undefined;
      }
      const change = normalizeOptionalCodeCollabAllChangesValue(value.change);
      if (!change.ok) {
        return undefined;
      }
      const fileIndexValue: Extract<CodeCollabV2FileIndexValue, { kind: 'too_large' }> = {
        kind: 'too_large',
      };
      if (!isCodeCollabMissing(value.rawBytes)) {
        if (!isNonNegativeInteger(value.rawBytes)) {
          return undefined;
        }
        fileIndexValue.rawBytes = value.rawBytes;
      }
      if (!isCodeCollabMissing(value.compressedBytes)) {
        if (!isNonNegativeInteger(value.compressedBytes)) {
          return undefined;
        }
        fileIndexValue.compressedBytes = value.compressedBytes;
      }
      if (change.value !== undefined) {
        fileIndexValue.change = change.value;
      }
      return fileIndexValue;
    }
    case 'deleted': {
      if (!hasOnlyCodeCollabKeys(value, ['kind', 'change']) || isCodeCollabMissing(value.change)) {
        return undefined;
      }
      const change = normalizeCodeCollabAllChangesValue(value.change);
      return change === undefined ? undefined : { kind: 'deleted', change };
    }
    case 'lazy':
      return hasOnlyCodeCollabKeys(value, ['kind']) ? { kind: 'lazy' } : undefined;
    case 'skipped':
      return hasOnlyCodeCollabKeys(value, ['kind', 'reason']) &&
        typeof value.reason === 'string' &&
        value.reason.length > 0
        ? { kind: 'skipped', reason: value.reason }
        : undefined;
    default:
      return undefined;
  }
};

const normalizeCodeCollabFileIndexSignalValue = (
  value: unknown
): CodeCollabFileIndexSignal | undefined => {
  if (!isCodeCollabRecord(value) || !hasOnlyCodeCollabKeys(value, ['v', 'r'])) {
    return undefined;
  }
  return value.v === 1 && isNonNegativeInteger(value.r) ? { v: 1, r: value.r } : undefined;
};

const isCodeCollabFileIndexSignalKey = (key: readonly unknown[]): boolean =>
  key.length === 1 && key[0] === CODE_COLLAB_FILE_INDEX_SIGNAL_KEY[0];

/**
 * A row key carrying U+FFFD is not a real path: no scanner produces one (the
 * CLI reads names from the filesystem, which hands out well-formed UTF-8), so
 * it can only come from a byte stream that was decoded across a chunk boundary
 * — see `createUtf8StreamDecoder`. Such a row is an LWW record under its OWN
 * corrupted key, so a correct republish never overwrites it and the garbled
 * path would otherwise survive in the file tree and `@file` menu forever.
 * Treat it as absent on read and prune it on the next write.
 */
const isCorruptedCodeCollabWorkspacePath = (workspacePath: string): boolean =>
  workspacePath.includes('\uFFFD');

function scanCodeCollabFileIndexFlock(flock: CodeCollabFileIndexReadableFlock): {
  fileIndex: CodeCollabV2FileIndexState;
  corruptedPaths: string[];
} {
  const fileIndex: CodeCollabV2FileIndexState = {};
  const corruptedPaths: string[] = [];
  for (const row of flock.scan()) {
    if (row.value === undefined) {
      continue;
    }
    const [workspacePath, ...extra] = row.key;
    if (typeof workspacePath !== 'string' || workspacePath.length === 0 || extra.length > 0) {
      continue;
    }
    if (isCorruptedCodeCollabWorkspacePath(workspacePath)) {
      corruptedPaths.push(workspacePath);
      continue;
    }
    const parsed = normalizeCodeCollabFileIndexValue(row.value);
    if (!parsed) {
      continue;
    }
    fileIndex[workspacePath] = parsed;
  }
  return { fileIndex, corruptedPaths };
}

export function readCodeCollabFileIndexFromFlock(
  flock: CodeCollabFileIndexReadableFlock
): CodeCollabV2FileIndexState {
  return scanCodeCollabFileIndexFlock(flock).fileIndex;
}

export function readCodeCollabFileIndexSignalFromFlock(
  flock: CodeCollabFileIndexReadableFlock
): CodeCollabFileIndexSignal | null {
  for (const row of flock.scan()) {
    if (row.value === undefined || !isCodeCollabFileIndexSignalKey(row.key)) {
      continue;
    }
    const parsed = normalizeCodeCollabFileIndexSignalValue(row.value);
    if (!parsed) {
      throw new Error('Invalid Code Collab file-index signal Flock value.');
    }
    return parsed;
  }
  return null;
}

export function writeCodeCollabFileIndexSignalToFlock(
  flock: CodeCollabFileIndexWritableFlock,
  revision: number,
  nowMs: number
): boolean {
  if (!isNonNegativeInteger(revision)) {
    throw new Error('Code Collab file-index signal revision must be a non-negative integer.');
  }

  const previous = readCodeCollabFileIndexSignalFromFlock(flock);
  if (previous?.r === revision) {
    return false;
  }
  flock.set(CODE_COLLAB_FILE_INDEX_SIGNAL_KEY, { v: 1, r: revision }, nowMs);
  flock.commit();
  return true;
}

export function writeCodeCollabFileIndexToFlock(
  flock: CodeCollabFileIndexWritableFlock,
  next: CodeCollabV2FileIndexState,
  nowMs: number
): boolean {
  const { fileIndex: previous, corruptedPaths } = scanCodeCollabFileIndexFlock(flock);
  let changed = false;

  for (const workspacePath of corruptedPaths) {
    flock.delete(codeCollabFileIndexKeyForWorkspacePath(workspacePath), nowMs);
    changed = true;
  }

  for (const workspacePath of Object.keys(previous)) {
    if (Object.prototype.hasOwnProperty.call(next, workspacePath)) {
      continue;
    }
    flock.delete(codeCollabFileIndexKeyForWorkspacePath(workspacePath), nowMs);
    changed = true;
  }

  for (const [workspacePath, value] of Object.entries(next)) {
    const normalized = normalizeCodeCollabFileIndexValue(value);
    if (!normalized || codeCollabFileIndexValuesEqual(previous[workspacePath], normalized)) {
      continue;
    }
    flock.set(codeCollabFileIndexKeyForWorkspacePath(workspacePath), normalized, nowMs);
    changed = true;
  }

  if (changed) {
    flock.commit();
  }
  return changed;
}

export function applyCodeCollabFileIndexSignalFlockEvents(
  previous: CodeCollabFileIndexSignal | null,
  events: readonly CodeCollabFileIndexFlockEvent[]
): CodeCollabFileIndexSignal | null {
  let next = previous;
  for (const event of events) {
    if (!isCodeCollabFileIndexSignalKey(event.key)) {
      continue;
    }
    if (event.value === undefined) {
      next = null;
      continue;
    }
    const parsed = normalizeCodeCollabFileIndexSignalValue(event.value);
    if (!parsed) {
      throw new Error('Invalid Code Collab file-index signal Flock event.');
    }
    next = parsed;
  }
  return next;
}

export function applyCodeCollabFileIndexFlockEvents(
  previous: CodeCollabV2FileIndexState,
  events: readonly CodeCollabFileIndexFlockEvent[]
): CodeCollabV2FileIndexState {
  let next: CodeCollabV2FileIndexState | null = null;
  const mutableNext = (): CodeCollabV2FileIndexState => {
    next ??= { ...previous };
    return next;
  };

  for (const event of events) {
    const current = next ?? previous;
    const [workspacePath, ...extra] = event.key;
    if (typeof workspacePath !== 'string' || workspacePath.length === 0 || extra.length > 0) {
      continue;
    }
    if (isCorruptedCodeCollabWorkspacePath(workspacePath)) {
      if (Object.prototype.hasOwnProperty.call(current, workspacePath)) {
        delete mutableNext()[workspacePath];
      }
      continue;
    }
    if (event.value === undefined) {
      if (Object.prototype.hasOwnProperty.call(current, workspacePath)) {
        delete mutableNext()[workspacePath];
      }
      continue;
    }
    const parsed = normalizeCodeCollabFileIndexValue(event.value);
    if (!parsed) {
      if (Object.prototype.hasOwnProperty.call(current, workspacePath)) {
        delete mutableNext()[workspacePath];
      }
      continue;
    }
    if (codeCollabFileIndexValuesEqual(current[workspacePath], parsed)) {
      continue;
    }
    mutableNext()[workspacePath] = parsed;
  }

  return next ?? previous;
}

export function codeCollabAllChangesValuesEqual(
  left: CodeCollabV2AllChangesValue | undefined,
  right: CodeCollabV2AllChangesValue | undefined
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left === true || right === true) return false;
  const leftDiff = left.diff;
  const rightDiff = right.diff;
  return (
    left.del === right.del &&
    ((leftDiff === undefined && rightDiff === undefined) ||
      (leftDiff !== undefined &&
        rightDiff !== undefined &&
        leftDiff[0] === rightDiff[0] &&
        leftDiff[1] === rightDiff[1]))
  );
}

export function codeCollabFileIndexValuesEqual(
  left: CodeCollabV2FileIndexValue | undefined,
  right: CodeCollabV2FileIndexValue | undefined
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left === true || right === true) return false;
  switch (left.kind) {
    case 'file':
      return right.kind === 'file' && codeCollabAllChangesValuesEqual(left.change, right.change);
    case 'text':
      return right.kind === 'text' && codeCollabAllChangesValuesEqual(left.change, right.change);
    case 'binary':
      return right.kind === 'binary' && codeCollabAllChangesValuesEqual(left.change, right.change);
    case 'too_large':
      return (
        right.kind === 'too_large' &&
        left.rawBytes === right.rawBytes &&
        left.compressedBytes === right.compressedBytes &&
        codeCollabAllChangesValuesEqual(left.change, right.change)
      );
    case 'deleted':
      return right.kind === 'deleted' && codeCollabAllChangesValuesEqual(left.change, right.change);
    case 'lazy':
      return right.kind === 'lazy';
    case 'skipped':
      return right.kind === 'skipped' && left.reason === right.reason;
  }
  return assertNever(left);
}

export function codeCollabFileIndexStatesEqual(
  left: CodeCollabV2FileIndexState,
  right: CodeCollabV2FileIndexState
): boolean {
  const leftPaths = Object.keys(left);
  const rightPaths = Object.keys(right);
  if (leftPaths.length !== rightPaths.length) return false;
  for (const workspacePath of leftPaths) {
    if (!Object.prototype.hasOwnProperty.call(right, workspacePath)) return false;
    if (!codeCollabFileIndexValuesEqual(left[workspacePath], right[workspacePath])) return false;
  }
  return true;
}

export function codeCollabFileTreeValueToFileIndexValue(
  value: CodeCollabV2FileTreeValue,
  change?: CodeCollabV2AllChangesValue
): CodeCollabV2FileIndexValue {
  if (value === true) {
    return change === undefined ? true : { kind: 'file', change };
  }
  switch (value.kind) {
    case 'lazy':
      return { kind: 'lazy' };
    case 'binary':
    case 'too_large':
      return change === undefined ? true : { kind: 'file', change };
    case 'skipped':
      return { kind: 'skipped', reason: value.reason };
  }
  return assertNever(value);
}

export function codeCollabFileIndexValueToFileTreeValue(
  value: CodeCollabV2FileIndexValue
): CodeCollabV2FileTreeValue | undefined {
  if (value === true) {
    return true;
  }
  switch (value.kind) {
    case 'file':
    case 'text':
      return true;
    case 'binary':
    case 'too_large':
      return true;
    case 'lazy':
      return { kind: 'lazy' };
    case 'skipped':
      return { kind: 'skipped', reason: value.reason };
    case 'deleted':
      return undefined;
  }
  return assertNever(value);
}

export function codeCollabFileIndexValueChange(
  value: CodeCollabV2FileIndexValue
): CodeCollabV2AllChangesValue | undefined {
  if (value === true) {
    return undefined;
  }
  return 'change' in value ? value.change : undefined;
}

export function buildCodeCollabFileIndexState(
  fileTree: CodeCollabV2FileTreeState,
  allChanges: CodeCollabV2AllChangesState
): CodeCollabV2FileIndexState {
  const fileIndex: CodeCollabV2FileIndexState = {};
  for (const [workspacePath, value] of Object.entries(fileTree)) {
    fileIndex[workspacePath] = codeCollabFileTreeValueToFileIndexValue(
      value,
      allChanges[workspacePath]
    );
  }
  for (const [workspacePath, change] of Object.entries(allChanges)) {
    if (fileIndex[workspacePath] !== undefined) {
      continue;
    }
    fileIndex[workspacePath] = { kind: 'deleted', change };
  }
  return fileIndex;
}

export function codeCollabFileIndexToSharedState(fileIndex: CodeCollabV2FileIndexState): {
  readonly fileTree: CodeCollabV2FileTreeState;
  readonly allChanges: CodeCollabV2AllChangesState;
} {
  const fileTree: CodeCollabV2FileTreeState = {};
  const allChanges: CodeCollabV2AllChangesState = {};
  for (const [workspacePath, value] of Object.entries(fileIndex)) {
    const fileTreeValue = codeCollabFileIndexValueToFileTreeValue(value);
    if (fileTreeValue !== undefined) {
      fileTree[workspacePath] = fileTreeValue;
    }
    const change = codeCollabFileIndexValueChange(value);
    if (change !== undefined) {
      allChanges[workspacePath] = change;
    }
  }
  return { fileTree, allChanges };
}

export const CODE_COLLAB_V2_RPC_CONTENT_ENVELOPE_TYPE = 'code-collab-v2-content-envelope';
export const CODE_COLLAB_V2_RPC_CONTENT_KEY_VERSION = 1;
export const CODE_COLLAB_V2_RPC_CONTENT_KEY_ALGORITHM = 'AES-256-GCM';

export const CodeCollabV2RpcContentEnvelopeSchema = z
  .object({
    type: z.literal(CODE_COLLAB_V2_RPC_CONTENT_ENVELOPE_TYPE),
    keyVersion: z.literal(CODE_COLLAB_V2_RPC_CONTENT_KEY_VERSION),
    algorithm: z.literal(CODE_COLLAB_V2_RPC_CONTENT_KEY_ALGORITHM),
    ownerSessionId: z.string().trim().min(1),
    keyId: z.string().trim().min(1),
    iv: z.string().trim().min(1),
    ciphertext: z.string().trim().min(1),
  })
  .strict();
export type CodeCollabV2RpcContentEnvelope = z.infer<typeof CodeCollabV2RpcContentEnvelopeSchema>;

export const CodeCollabV2RpcResponseSchema = z.union([
  CodeCollabV2OpenTextOkSchema,
  CodeCollabV2FileIndexSnapshotSchema,
  CodeCollabV2RefreshTextResponseSchema,
  CodeCollabV2SaveTextResponseSchema,
  CodeCollabV2OpenCurrentDiffResponseSchema,
  CodeCollabV2OpenAllChangesDiffResponseSchema,
  CodeCollabV2OpenTurnDiffResponseSchema,
  CodeCollabV2InitDirectoryOkSchema,
  CodeCollabV2LspUnsupportedSchema,
]);
export type CodeCollabV2RpcResponse = z.infer<typeof CodeCollabV2RpcResponseSchema>;

export const normalizeCodeCollabDomainError = (
  error: unknown,
  fallback: {
    readonly code?: CodeCollabDomainErrorCode;
    readonly message?: string;
  } = {}
): CodeCollabDomainError => {
  const parsed = CodeCollabDomainErrorSchema.safeParse(error);
  if (parsed.success) return parsed.data;
  return {
    code: fallback.code ?? 'unexpected',
    message: fallback.message ?? 'Code Collab operation failed',
    redacted: true,
  };
};

const CODE_COLLAB_V2_CONTENT_KEY_DERIVATION_LABEL = 'lody-code-collab-v2-bootstrap-content-key-v1';
const CODE_COLLAB_V2_CONTENT_KEY_ID_DERIVATION_LABEL =
  'lody-code-collab-v2-bootstrap-content-key-id-v1';
const CODE_COLLAB_V2_BOOTSTRAP_CONTENT_KEY_SALT = 'lody-code-collab-v2-bootstrap-salt-v1';

export function deriveCodeCollabV2ContentKeyBytes(ownerSessionId: string): Uint8Array {
  return sha256Bytes(
    `${CODE_COLLAB_V2_CONTENT_KEY_DERIVATION_LABEL}\0${CODE_COLLAB_V2_BOOTSTRAP_CONTENT_KEY_SALT}\0${ownerSessionId}`
  );
}

export function deriveCodeCollabV2ContentKeyId(ownerSessionId: string): string {
  const digest = sha256Bytes(
    `${CODE_COLLAB_V2_CONTENT_KEY_ID_DERIVATION_LABEL}\0${CODE_COLLAB_V2_BOOTSTRAP_CONTENT_KEY_SALT}\0${ownerSessionId}`
  );
  return `ccv2:${bytesToHex(digest).slice(0, 24)}`;
}

export const CodeCollabFileEntrySchema = z
  .object({
    fileId: z.string().min(1),
    path: z.string().min(1),
    kind: CodeCollabFileKindSchema,
    specialKind: CodeCollabSpecialKindSchema.optional(),
    textEol: CodeCollabTextEolSchema.optional(),
    hasBom: z.boolean().optional(),
    mode: z.number().int().nonnegative().optional(),
    executable: z.boolean().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().optional(),
    contentDigest: z.string().optional(),
    linkTarget: z.string().optional(),
    unavailableReason: CodeCollabUnavailableReasonSchema.optional(),
    updatedAt: z.string().optional(),
    deletedAt: z.string().optional(),
  })
  .strict();
export type CodeCollabFileEntry = z.infer<typeof CodeCollabFileEntrySchema>;

export const CodeCollabFsNodeKindSchema = z.enum([
  'regular-file',
  'directory',
  'symlink',
  'fifo',
  'socket',
  'block-device',
  'char-device',
  'unknown',
]);
export type CodeCollabFsNodeKind = z.infer<typeof CodeCollabFsNodeKindSchema>;

export const CodeCollabFileStateSchema = z
  .object({
    exists: z.boolean(),
    path: z.string().optional(),
    kind: z.enum(['text', 'binary', 'large']).optional(),
    textDocId: z.string().optional(),
    textFrontiers: z.unknown().optional(),
    contentDigest: z.string().optional(),
    blobDigest: z.string().optional(),
    mode: z.number().int().nonnegative().optional(),
    executable: z.boolean().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CodeCollabFileState = z.infer<typeof CodeCollabFileStateSchema>;

export type CodeCollabRepositorySupport =
  | { supported: true; supportedFileCount: number }
  | {
      supported: false;
      reason: 'repository-too-large';
      supportedFileCount: number;
      maxSupportedFiles: number;
    };

export const getCodeCollabRepositorySupport = (
  supportedFileCount: number,
  maxSupportedFiles = CODE_COLLAB_LIMITS.maxSupportedFiles
): CodeCollabRepositorySupport => {
  if (!Number.isInteger(supportedFileCount) || supportedFileCount < 0) {
    throw new Error(`supportedFileCount must be a non-negative integer: ${supportedFileCount}`);
  }
  if (supportedFileCount > maxSupportedFiles) {
    return {
      supported: false,
      reason: 'repository-too-large',
      supportedFileCount,
      maxSupportedFiles,
    };
  }
  return { supported: true, supportedFileCount };
};

export const shouldCountForCodeCollabFileLimit = (
  entryKind: 'regular-file' | 'directory' | 'symlink' | 'special'
): boolean => entryKind === 'regular-file';

const SHA256_INITIAL_HASH: number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rightRotate = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

function sha256Bytes(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddingLength = (64 - ((bytes.length + 1 + 8) % 64)) % 64;
  const data = new Uint8Array(bytes.length + 1 + paddingLength + 8);
  data.set(bytes);
  data[bytes.length] = 0x80;

  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(data.length - 4, bitLength >>> 0);

  const hash = [...SHA256_INITIAL_HASH];
  const words = new Array<number>(64).fill(0);

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rightRotate(words[i - 15] ?? 0, 7) ^
        rightRotate(words[i - 15] ?? 0, 18) ^
        ((words[i - 15] ?? 0) >>> 3);
      const s1 =
        rightRotate(words[i - 2] ?? 0, 17) ^
        rightRotate(words[i - 2] ?? 0, 19) ^
        ((words[i - 2] ?? 0) >>> 10);
      words[i] = (((words[i - 16] ?? 0) + s0 + (words[i - 7] ?? 0) + s1) >>> 0) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rightRotate(e ?? 0, 6) ^ rightRotate(e ?? 0, 11) ^ rightRotate(e ?? 0, 25);
      const ch = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temp1 = (((h ?? 0) + s1 + ch + SHA256_K[i]! + words[i]!) >>> 0) >>> 0;
      const s0 = rightRotate(a ?? 0, 2) ^ rightRotate(a ?? 0, 13) ^ rightRotate(a ?? 0, 22);
      const maj = ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = ((d ?? 0) + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = ((hash[0] ?? 0) + (a ?? 0)) >>> 0;
    hash[1] = ((hash[1] ?? 0) + (b ?? 0)) >>> 0;
    hash[2] = ((hash[2] ?? 0) + (c ?? 0)) >>> 0;
    hash[3] = ((hash[3] ?? 0) + (d ?? 0)) >>> 0;
    hash[4] = ((hash[4] ?? 0) + (e ?? 0)) >>> 0;
    hash[5] = ((hash[5] ?? 0) + (f ?? 0)) >>> 0;
    hash[6] = ((hash[6] ?? 0) + (g ?? 0)) >>> 0;
    hash[7] = ((hash[7] ?? 0) + (h ?? 0)) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  for (let i = 0; i < hash.length; i += 1) {
    outputView.setUint32(i * 4, hash[i] ?? 0);
  }
  return output;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export type CodeCollabContentAvailability =
  | {
      available: true;
      source: 'text-doc' | 'blob' | 'metadata';
    }
  | {
      available: false;
      reason: CodeCollabContentUnavailableReason;
    };

export const getCodeCollabFileEntryContentAvailability = (
  entry: Pick<CodeCollabFileEntry, 'kind' | 'contentDigest' | 'unavailableReason'>
): CodeCollabContentAvailability => {
  if (entry.unavailableReason != null) {
    return { available: false, reason: entry.unavailableReason };
  }
  switch (entry.kind) {
    case 'text':
      return { available: true, source: 'text-doc' };
    case 'binary':
      return entry.contentDigest != null
        ? { available: true, source: 'blob' }
        : { available: false, reason: 'missing-blob-digest' };
    case 'large':
      return entry.contentDigest != null
        ? { available: true, source: 'blob' }
        : { available: false, reason: 'metadata-only' };
    case 'symlink':
    case 'special':
      return { available: false, reason: 'metadata-only' };
    case 'deleted':
      return { available: false, reason: 'deleted' };
  }
  return assertNever(entry.kind);
};

export const getCodeCollabFileStateContentAvailability = (
  state: CodeCollabFileState,
  options?: { blobAvailable?: boolean }
): CodeCollabContentAvailability => {
  if (!state.exists) {
    return { available: false, reason: 'deleted' };
  }
  if (state.kind === 'text') {
    return state.textFrontiers != null || state.textDocId != null
      ? { available: true, source: 'text-doc' }
      : { available: false, reason: 'missing-text-frontiers' };
  }
  if (state.kind === 'binary' || state.kind === 'large') {
    const digest = state.blobDigest ?? state.contentDigest;
    if (digest == null) {
      return { available: false, reason: 'missing-blob-digest' };
    }
    if (options?.blobAvailable === false) {
      return { available: false, reason: 'blob-expired' };
    }
    return { available: true, source: 'blob' };
  }
  return { available: false, reason: 'metadata-only' };
};

export type PathNormalizationResult =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: 'empty' | 'absolute' | 'traversal' | 'nul-byte' | 'windows-drive';
    };

export const normalizeWorkspaceRelativePath = (input: string): PathNormalizationResult => {
  if (input.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (input.includes('\0')) {
    return { ok: false, reason: 'nul-byte' };
  }
  const slashPath = input.replaceAll('\\', '/');
  if (slashPath.startsWith('/')) {
    return { ok: false, reason: 'absolute' };
  }
  if (/^[A-Za-z]:\//.test(slashPath)) {
    return { ok: false, reason: 'windows-drive' };
  }

  const parts: string[] = [];
  for (const part of slashPath.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length === 0) {
        return { ok: false, reason: 'traversal' };
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, path: parts.join('/') };
};

export type PathComparisonOptions = {
  caseSensitive: boolean;
  normalizeUnicode?: boolean;
};

export const getCodeCollabPathComparisonKey = (
  path: string,
  options: PathComparisonOptions
): string => {
  const unicodeNormalized = options.normalizeUnicode === false ? path : path.normalize('NFC');
  return options.caseSensitive ? unicodeNormalized : unicodeNormalized.toLocaleLowerCase('en-US');
};

export type CodeCollabPathCollision = {
  comparisonKey: string;
  paths: string[];
};

export const findCodeCollabPathCollisions = (
  paths: readonly string[],
  options: PathComparisonOptions
): CodeCollabPathCollision[] => {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = getCodeCollabPathComparisonKey(path, options);
    const group = groups.get(key);
    if (group != null) {
      group.push(path);
    } else {
      groups.set(key, [path]);
    }
  }

  return Array.from(groups.entries())
    .filter(([, group]) => new Set(group).size > 1)
    .map(([comparisonKey, group]) => ({
      comparisonKey,
      paths: Array.from(new Set(group)),
    }));
};

export const hasUtf8Bom = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

export const hasBinarySniffBytes = (
  bytes: Uint8Array,
  prefixBytes = CODE_COLLAB_LIMITS.binarySniffPrefixBytes
): boolean => {
  const length = Math.min(bytes.length, prefixBytes);
  for (let i = 0; i < length; i += 1) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
};

export const decodeUtf8Strict = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

export const detectTextEol = (text: string): CodeCollabTextEol => {
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n') {
      continue;
    }
    if (i > 0 && text[i - 1] === '\r') {
      crlf += 1;
    } else {
      lf += 1;
    }
  }
  if (lf === 0 && crlf === 0) {
    return 'unknown';
  }
  if (lf > 0 && crlf > 0) {
    return 'mixed';
  }
  return crlf > 0 ? 'crlf' : 'lf';
};

const normalizeTextEol = (text: string, eol: CodeCollabTextEol): string => {
  if (eol === 'lf') {
    return text.replace(/\r\n|\r/g, '\n');
  }
  if (eol === 'crlf') {
    return text.replace(/\r\n|\n|\r/g, '\r\n');
  }
  return text;
};

export const serializeCodeCollabText = (args: {
  text: string;
  textEol?: CodeCollabTextEol;
  hasBom?: boolean;
}): Uint8Array => {
  const textWithoutBom = args.text.startsWith('\uFEFF') ? args.text.slice(1) : args.text;
  const normalizedText = normalizeTextEol(textWithoutBom, args.textEol ?? 'unknown');
  const encoded = new TextEncoder().encode(normalizedText);
  if (!args.hasBom) {
    return encoded;
  }
  const output = new Uint8Array(encoded.length + 3);
  output.set([0xef, 0xbb, 0xbf], 0);
  output.set(encoded, 3);
  return output;
};

export type LongLineCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'line-too-long';
      maxUtf8Bytes: number;
      maxUtf16CodeUnits: number;
      lineUtf8Bytes: number;
      lineUtf16CodeUnits: number;
    };

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

export const checkRealtimeTextLineLimits = (
  text: string,
  limits: CodeCollabLimits = CODE_COLLAB_LIMITS
): LongLineCheckResult => {
  const lines = text.split(/\r\n|\n|\r/);
  for (const line of lines) {
    const lineUtf8Bytes = utf8ByteLength(line);
    const lineUtf16CodeUnits = line.length;
    if (
      lineUtf8Bytes > limits.maxRealtimeLineUtf8Bytes ||
      lineUtf16CodeUnits > limits.maxRealtimeLineUtf16CodeUnits
    ) {
      return {
        ok: false,
        reason: 'line-too-long',
        maxUtf8Bytes: limits.maxRealtimeLineUtf8Bytes,
        maxUtf16CodeUnits: limits.maxRealtimeLineUtf16CodeUnits,
        lineUtf8Bytes,
        lineUtf16CodeUnits,
      };
    }
  }
  return { ok: true };
};

export type RegularFileContentClassification =
  | {
      kind: 'text';
      sizeBytes: number;
      text: string;
      textEol: CodeCollabTextEol;
      hasBom: boolean;
    }
  | {
      kind: 'binary';
      sizeBytes: number;
    }
  | {
      kind: 'large';
      sizeBytes: number;
      unavailableReason: Extract<
        CodeCollabUnavailableReason,
        'text-too-large' | 'line-too-long' | 'unsupported-encoding'
      >;
    };

export type ClassifyRegularFileContentInput = {
  sizeBytes: number;
  bytes: Uint8Array;
};

export const classifyRegularFileContent = (
  input: ClassifyRegularFileContentInput,
  limits: CodeCollabLimits = CODE_COLLAB_LIMITS
): RegularFileContentClassification => {
  if (input.sizeBytes > limits.maxRealtimeTextBytes) {
    return {
      kind: 'large',
      sizeBytes: input.sizeBytes,
      unavailableReason: 'text-too-large',
    };
  }
  if (hasBinarySniffBytes(input.bytes, limits.binarySniffPrefixBytes)) {
    return { kind: 'binary', sizeBytes: input.sizeBytes };
  }

  const text = decodeUtf8Strict(input.bytes);
  if (text == null) {
    return {
      kind: 'large',
      sizeBytes: input.sizeBytes,
      unavailableReason: 'unsupported-encoding',
    };
  }

  const lineCheck = checkRealtimeTextLineLimits(text, limits);
  if (!lineCheck.ok) {
    return {
      kind: 'large',
      sizeBytes: input.sizeBytes,
      unavailableReason: 'line-too-long',
    };
  }

  return {
    kind: 'text',
    sizeBytes: input.sizeBytes,
    text,
    textEol: detectTextEol(text),
    hasBom: hasUtf8Bom(input.bytes),
  };
};

export type CodeCollabFileSystemNodeClassification =
  | { kind: 'regular-file'; countForFileLimit: true }
  | { kind: 'directory'; countForFileLimit: false }
  | { kind: 'symlink'; countForFileLimit: false }
  | {
      kind: 'special';
      specialKind: CodeCollabSpecialKind;
      countForFileLimit: false;
      unavailableReason: 'unsupported-special';
    };

export const classifyCodeCollabFileSystemNode = (
  nodeKind: CodeCollabFsNodeKind
): CodeCollabFileSystemNodeClassification => {
  switch (nodeKind) {
    case 'regular-file':
      return { kind: 'regular-file', countForFileLimit: true };
    case 'directory':
      return { kind: 'directory', countForFileLimit: false };
    case 'symlink':
      return { kind: 'symlink', countForFileLimit: false };
    case 'fifo':
      return {
        kind: 'special',
        specialKind: 'fifo',
        countForFileLimit: false,
        unavailableReason: 'unsupported-special',
      };
    case 'socket':
      return {
        kind: 'special',
        specialKind: 'socket',
        countForFileLimit: false,
        unavailableReason: 'unsupported-special',
      };
    case 'block-device':
      return {
        kind: 'special',
        specialKind: 'block-device',
        countForFileLimit: false,
        unavailableReason: 'unsupported-special',
      };
    case 'char-device':
      return {
        kind: 'special',
        specialKind: 'char-device',
        countForFileLimit: false,
        unavailableReason: 'unsupported-special',
      };
    case 'unknown':
      return {
        kind: 'special',
        specialKind: 'unknown',
        countForFileLimit: false,
        unavailableReason: 'unsupported-special',
      };
  }
  return assertNever(nodeKind);
};

function assertNever(value: never): never {
  throw new Error(`Unhandled Code Collab value: ${String(value)}`);
}

export const getCodeCollabExecutableFromMode = (mode: number | undefined): boolean | undefined => {
  if (mode == null) {
    return undefined;
  }
  return (mode & 0o111) !== 0;
};

export type CodeCollabMetadataDiff = {
  modeChanged: boolean;
  executableChanged: boolean;
  chmodOnly: boolean;
};

export const diffCodeCollabFileMetadata = (
  before: Pick<CodeCollabFileState, 'mode' | 'executable' | 'contentDigest' | 'blobDigest'>,
  after: Pick<CodeCollabFileState, 'mode' | 'executable' | 'contentDigest' | 'blobDigest'>
): CodeCollabMetadataDiff => {
  const modeChanged = before.mode !== after.mode;
  const beforeExecutable = before.executable ?? getCodeCollabExecutableFromMode(before.mode);
  const afterExecutable = after.executable ?? getCodeCollabExecutableFromMode(after.mode);
  const executableChanged = beforeExecutable !== afterExecutable;
  const contentChanged =
    before.contentDigest !== after.contentDigest || before.blobDigest !== after.blobDigest;
  return {
    modeChanged,
    executableChanged,
    chmodOnly: (modeChanged || executableChanged) && !contentChanged,
  };
};

export type SymlinkResolutionResult =
  | { kind: 'resolved'; path: string }
  | { kind: 'dangling'; path: string }
  | { kind: 'external'; target: string }
  | { kind: 'cycle'; path: string }
  | { kind: 'not-symlink'; path: string };

const dirname = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
};

const resolveRelativeTargetPath = (
  symlinkPath: string,
  linkTarget: string
): PathNormalizationResult => {
  const slashTarget = linkTarget.replaceAll('\\', '/');
  if (slashTarget.startsWith('/')) {
    return { ok: false, reason: 'absolute' };
  }
  if (/^[A-Za-z]:\//.test(slashTarget)) {
    return { ok: false, reason: 'windows-drive' };
  }
  const base = dirname(symlinkPath);
  return normalizeWorkspaceRelativePath(base.length === 0 ? slashTarget : `${base}/${slashTarget}`);
};

export const resolveCodeCollabSymlinkTarget = (
  symlinkPath: string,
  entriesByPath: ReadonlyMap<string, Pick<CodeCollabFileEntry, 'path' | 'kind' | 'linkTarget'>>,
  maxDepth = 16
): SymlinkResolutionResult => {
  const first = entriesByPath.get(symlinkPath);
  if (first == null || first.kind !== 'symlink') {
    return { kind: 'not-symlink', path: symlinkPath };
  }

  let current = first;
  const seen = new Set<string>([symlinkPath]);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (current.linkTarget == null || current.linkTarget.length === 0) {
      return { kind: 'dangling', path: current.path };
    }
    const target = resolveRelativeTargetPath(current.path, current.linkTarget);
    if (!target.ok) {
      return { kind: 'external', target: current.linkTarget };
    }
    const targetEntry = entriesByPath.get(target.path);
    if (targetEntry == null) {
      return { kind: 'dangling', path: target.path };
    }
    if (targetEntry.kind !== 'symlink') {
      return { kind: 'resolved', path: targetEntry.path };
    }
    if (seen.has(targetEntry.path)) {
      return { kind: 'cycle', path: targetEntry.path };
    }
    seen.add(targetEntry.path);
    current = targetEntry;
  }

  return { kind: 'cycle', path: current.path };
};

export type CodeCollabPermissionInput = {
  canRead: boolean;
  canWrite?: boolean;
  canHost?: boolean;
};

export const deriveCodeCollabRoleFromPermissions = (
  input: CodeCollabPermissionInput
): CodeCollabRole | null => {
  if (input.canHost === true) {
    return 'host';
  }
  if (input.canWrite === true) {
    return 'write';
  }
  if (input.canRead) {
    return 'read';
  }
  return null;
};

const CODE_COLLAB_WRITE_WORKSPACE_ROLES = new Set(['owner', 'admin', 'member']);
const CODE_COLLAB_READ_WORKSPACE_ROLES = new Set(['viewer', 'read', 'guest']);

export type CodeCollabRoleAuthorization =
  | { ok: true; role: CodeCollabRole }
  | {
      ok: false;
      reason: 'not-workspace-member' | 'insufficient-workspace-role' | 'host-not-eligible';
    };

export function getCodeCollabMaxRoleForWorkspaceMember(args: {
  workspaceRole: string | null | undefined;
  hostEligible?: boolean;
}): CodeCollabRole | null {
  const role = args.workspaceRole?.trim().toLowerCase();
  if (!role) {
    return null;
  }

  const baseRole: CodeCollabRole = CODE_COLLAB_WRITE_WORKSPACE_ROLES.has(role)
    ? 'write'
    : CODE_COLLAB_READ_WORKSPACE_ROLES.has(role)
      ? 'read'
      : 'read';

  return args.hostEligible === true && hasCodeCollabRoleAtLeast(baseRole, 'write')
    ? 'host'
    : baseRole;
}

export function authorizeCodeCollabRoleRequest(args: {
  workspaceRole: string | null | undefined;
  requestedRole: CodeCollabRole;
  hostEligible?: boolean;
}): CodeCollabRoleAuthorization {
  const requestedRole = CodeCollabRoleSchema.parse(args.requestedRole);
  const maxRole = getCodeCollabMaxRoleForWorkspaceMember(args);
  if (maxRole == null) {
    return { ok: false, reason: 'not-workspace-member' };
  }
  if (requestedRole === 'host' && maxRole !== 'host') {
    return { ok: false, reason: 'host-not-eligible' };
  }
  if (!hasCodeCollabRoleAtLeast(maxRole, requestedRole)) {
    return { ok: false, reason: 'insufficient-workspace-role' };
  }
  return { ok: true, role: requestedRole };
}

export type DeriveCodeCollabFileSourceStateInput = {
  historicalTurn?: boolean;
  role?: CodeCollabRole | null;
  liveHostState?: CodeCollabLiveHostState;
  unavailableReason?: CodeCollabUnavailableReason | null;
};

export const deriveCodeCollabFileSourceState = (
  input: DeriveCodeCollabFileSourceStateInput
): CodeCollabFileSourceState => {
  if (input.unavailableReason != null) {
    return 'degraded';
  }
  if (input.historicalTurn === true) {
    return 'historical-turn';
  }
  if (input.liveHostState !== undefined && input.liveHostState !== 'online') {
    return 'host-offline';
  }
  return input.role === 'read' ? 'live-readonly' : 'live-collaborative';
};

export type CodeCollabSessionFileProviderContract = {
  kind: CodeCollabProviderKind;
  listFiles(): Promise<CodeCollabFileEntry[]>;
  searchFiles(query: string): Promise<CodeCollabFileEntry[]>;
  getFile(pathOrFileId: string): Promise<CodeCollabFileEntry | null>;
};
