import { z } from 'zod';
import {
  SESSION_FILE_MAX_COUNT,
  SESSION_FILE_MAX_SIZE_BYTES,
  SESSION_IMAGE_ALLOWED_MIME_TYPES,
  SESSION_IMAGE_MAX_COUNT,
  SESSION_IMAGE_MAX_SIZE_BYTES,
  isSessionFileSourcePath,
  type ACPSessionId,
  type SessionTurnInputConfig,
} from './ai';
import type { AgentRoleId, SessionId } from './ids';
import { MAX_MESSAGE_TEXT_SPAN_MARK_LENGTH, MESSAGE_TEXT_SPAN_KINDS } from './message-text-spans';
import { RpcSecretPublicKeySchema } from './rpc-secret';
import { LodyOperationIdSchema } from './session-orchestration';
import { isSensitiveAcpConfigOptionId } from './session-preparation';
import { normalizeMcpServerIdSelection } from './workspace-mcp';
import {
  ACP_AUTH_FORM_FIELD_MAX_COUNT,
  ACP_AUTH_ID_MAX_LENGTH,
  ACP_AUTH_LABEL_MAX_LENGTH,
  ACP_AUTH_METHOD_MAX_COUNT,
  ACP_AUTH_SELECT_OPTION_MAX_COUNT,
  ACP_AUTH_TEXT_MAX_LENGTH,
  ACP_AUTHORIZATION_URL_MAX_LENGTH,
  isAcpAuthenticationFormWithinByteLimit,
} from './acp-authentication-limits';

// ============================================
// BASE ID TYPE SCHEMAS
// Zod's .brand() is incompatible with the repository's existing TypeScript
// brands. Convert at this validation boundary so parsed session ids carry the
// domain type without forcing casts throughout application code.
// ============================================

export const SessionIdSchema = z.string().transform((value) => value as SessionId);
export const MachineIdSchema = z.string();
export const WorkspaceIdSchema = z.string();
export const AgentConfigIdSchema = z.string();
export const ACPSessionIdSchema = z.string();
export const LocalProjectIdSchema = z.string();

export const WorktreeSetupScriptConfigSchema = z
  .object({
    scripts: z
      .object({
        bash: z.string().optional(),
        powershell: z.string().optional(),
      })
      .strict(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const WorktreeCleanupScriptConfigSchema = WorktreeSetupScriptConfigSchema;

// ============================================
// ACP SESSION CONFIG SCHEMAS
// ============================================

export const CliTypeSchema = z.enum(['kimi', 'grok', 'claude', 'codex']);
export const AgentConfigCliTypeSchema = z.enum(['builtin', 'registry', 'custom']);

/** Launch spec for `cliType: 'custom'` agents (see `CustomAcpLaunchSpec`). */
export const CustomAcpLaunchSpecSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
  })
  .strict();

export const BuiltinRuntimeOverridesSchema = z
  .object({
    codexPath: z.string().optional(),
    claudeCodeExecutable: z.string().optional(),
    kimiPath: z.string().optional(),
    grokPath: z.string().optional(),
  })
  .strict();

const AcpConfigOptionValueSchema = z.union([z.string(), z.boolean()]);
const AcpConfigOptionValuesSchema = z
  .record(z.string(), AcpConfigOptionValueSchema)
  .transform((values) =>
    Object.fromEntries(Object.entries(values).filter(([key]) => key !== '$cid'))
  );

export const IssuePRMentionSchema = z
  .object({
    type: z.enum(['issue', 'pr']),
    title: z.string(),
    url: z.string(),
    number: z.number(),
  })
  .strict();

const OptionalPositiveIntegerSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.number().int().positive().optional()
);

const OptionalStringSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional()
);

export const SessionImagePayloadSchema = z
  .object({
    imageId: z.string(),
    mimeType: z.enum(SESSION_IMAGE_ALLOWED_MIME_TYPES),
    fileName: OptionalStringSchema,
    sizeBytes: z.number().int().positive().max(SESSION_IMAGE_MAX_SIZE_BYTES),
    width: OptionalPositiveIntegerSchema,
    height: OptionalPositiveIntegerSchema,
    storageSessionId: SessionIdSchema.optional(),
  })
  .strict();

const SessionImageInputBlockSchema = SessionImagePayloadSchema.extend({
  type: z.literal('image'),
}).strict();

export const SessionImageGroupContentSchema = z
  .object({
    type: z.literal('image_group'),
    images: z.array(SessionImagePayloadSchema).min(1).max(SESSION_IMAGE_MAX_COUNT),
  })
  .strict();

// Base object (no cross-field refinement) so it can participate in
// `z.discriminatedUnion('type', ...)`. The transport/machineId invariant is
// enforced by `refineSessionFileBlock` at the array level (a ZodEffects schema
// cannot be a discriminated-union member).
const SessionFileBlockObjectSchema = z
  .object({
    type: z.literal('file'),
    fileId: z.string(),
    fileName: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative().max(SESSION_FILE_MAX_SIZE_BYTES),
    sha256: z.string(),
    textPreview: z.boolean(),
    sourcePath: z.string().refine(isSessionFileSourcePath).optional(),
    transport: z.enum(['r2', 'local']),
    machineId: OptionalStringSchema,
    uploadedAt: z.number(),
    storageSessionId: SessionIdSchema.optional(),
  })
  .strict();

const refineSessionFileBlock = (
  block: z.infer<typeof SessionFileBlockObjectSchema>,
  ctx: z.RefinementCtx,
  basePath: PropertyKey[] = []
): void => {
  // transport='local' means the bytes only exist on a specific machine pending
  // backfill; without machineId other devices can't render the honest
  // "uploading from <machine>" pending state.
  if (block.transport === 'local' && (block.machineId === undefined || block.machineId === '')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...basePath, 'machineId'],
      message: "machineId is required when transport is 'local'",
    });
  }
};

export const SessionFileBlockSchema = SessionFileBlockObjectSchema.superRefine((block, ctx) =>
  refineSessionFileBlock(block, ctx)
);

const MessageTextSpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    kind: z.enum(MESSAGE_TEXT_SPAN_KINDS),
    label: z.string().min(1),
    target: z.string().optional(),
    // The same bar `sanitizeMessageTextSpans` applies. This object is `.strict()`,
    // and a rejected span fails the whole block list — which surfaces as an empty
    // prompt, not as a missing chip — so a field one side knows must be declared
    // on both.
    mark: z.string().min(1).max(MAX_MESSAGE_TEXT_SPAN_MARK_LENGTH).optional(),
  })
  .strict();

const SessionTextInputBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    // Optional so every text block written before spans existed still parses.
    // Offsets are NOT checked against `text` here — only the shape is. The
    // range check belongs to `sanitizeMessageTextSpans`, which also runs on the
    // read path, where spans arrive through the session document's untyped
    // catchall and never see this schema at all.
    spans: z.array(MessageTextSpanSchema).optional(),
  })
  .strict();

const CommentReferenceReplySchema = z.object({
  authorName: z.string(),
  body: z.string(),
});

const CommentReferencePayloadSchema = z.object({
  source: z.enum(['lody', 'github']),
  path: z.string(),
  lineNumber: z.number().int(),
  side: z.enum(['additions', 'deletions']),
  commentBody: z.string(),
  authorName: z.string(),
  authorImage: z.string().optional(),
  replies: z.array(CommentReferenceReplySchema).optional(),
  turnId: z.string().optional(),
  mode: z.enum(['conversation', 'base']).optional(),
  threadId: z.string().optional(),
  githubThreadId: z.number().int().optional(),
});

const SessionCommentReferenceInputBlockSchema = CommentReferencePayloadSchema.extend({
  type: z.literal('comment_reference'),
});

const VisualAnnotationViewportSchema = z
  .object({
    width: z.number(),
    height: z.number(),
    scrollX: z.number(),
    scrollY: z.number(),
    devicePixelRatio: z.number(),
  })
  .strict();

const VisualAnnotationRectRatioSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();

const VisualAnnotationAnchorSchema = z
  .object({
    version: z.literal(1),
    page: z
      .object({
        url: z.string(),
        pathname: z.string(),
        viewport: VisualAnnotationViewportSchema,
      })
      .strict(),
    click: z
      .object({
        clientX: z.number(),
        clientY: z.number(),
        pageX: z.number(),
        pageY: z.number(),
        viewportXRatio: z.number(),
        viewportYRatio: z.number(),
      })
      .strict(),
    target: z
      .object({
        tag: z.string(),
        id: z.string().optional(),
        role: z.string().optional(),
        attributes: z.record(z.string(), z.string()),
        text: z.string().optional(),
        rect: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          })
          .strict(),
        rectRatio: VisualAnnotationRectRatioSchema,
        selector: z.string(),
        xpath: z.string().optional(),
      })
      .strict(),
    context: z
      .object({
        ancestors: z.array(
          z
            .object({
              tag: z.string(),
              id: z.string().optional(),
              role: z.string().optional(),
              selector: z.string().optional(),
              text: z.string().optional(),
            })
            .strict()
        ),
        nearbyText: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

const VisualAnnotationReferencePayloadSchema = z
  .object({
    source: z.literal('visual_annotation'),
    commentId: z.string(),
    turnId: z.string().optional(),
    body: z.string(),
    authorName: z.string().optional(),
    status: z.enum(['completed', 'submitted', 'cancelled']).optional(),
    anchor: VisualAnnotationAnchorSchema,
  })
  .strict();

const SessionVisualAnnotationReferenceInputBlockSchema =
  VisualAnnotationReferencePayloadSchema.extend({
    type: z.literal('visual_annotation_reference'),
  }).strict();

export const SessionInputBlockSchema = z.discriminatedUnion('type', [
  SessionTextInputBlockSchema,
  SessionImageInputBlockSchema,
  SessionFileBlockObjectSchema,
  SessionCommentReferenceInputBlockSchema,
  SessionVisualAnnotationReferenceInputBlockSchema,
]);

export const SessionInputBlocksSchema = z
  .array(SessionInputBlockSchema)
  .superRefine((blocks, ctx) => {
    let imageCount = 0;
    let fileCount = 0;
    blocks.forEach((block, index) => {
      if (block.type === 'image') {
        imageCount += 1;
      }
      if (block.type === 'file') {
        fileCount += 1;
        refineSessionFileBlock(block, ctx, [index]);
      }
    });

    if (imageCount > SESSION_IMAGE_MAX_COUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${SESSION_IMAGE_MAX_COUNT} images are allowed per message`,
      });
    }

    if (fileCount > SESSION_FILE_MAX_COUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${SESSION_FILE_MAX_COUNT} files are allowed per message`,
      });
    }
  });

export const ACPSessionConfigSchema = z
  .object({
    prompt: z.string(),
    inputBlocks: SessionInputBlocksSchema.optional(),
    cliType: AgentConfigCliTypeSchema,
    agentType: z.string().trim().min(1),
    customAcp: CustomAcpLaunchSpecSchema.optional(),
    runtimeOverrides: BuiltinRuntimeOverridesSchema.optional(),
    modeId: z.string().optional(),
    modelId: z.string().optional(),
    configOptionValues: AcpConfigOptionValuesSchema.optional(),
    mcpServerIds: z.array(z.string()).optional(),
    taskToolsEnabled: z.boolean().optional(),
    agentRoleId: z.string().trim().min(1).nullable().optional(),
    agentRoleRevision: z.number().int().nonnegative().optional(),
    issuePRMentions: z.array(IssuePRMentionSchema).optional(),
    resume: ACPSessionIdSchema.optional(),
    chainDepth: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const LooseSessionTurnInputConfigSchema = z
  .object({
    prompt: z.string().optional(),
    inputBlocks: SessionInputBlocksSchema.optional(),
    cliType: AgentConfigCliTypeSchema.optional(),
    agentType: z.string().trim().min(1).optional(),
    customAcp: CustomAcpLaunchSpecSchema.optional(),
    runtimeOverrides: BuiltinRuntimeOverridesSchema.optional(),
    modeId: z.string().optional(),
    modelId: z.string().optional(),
    configOptionValues: AcpConfigOptionValuesSchema.optional(),
    mcpServerIds: z.array(z.string()).optional(),
    taskToolsEnabled: z.boolean().optional(),
    agentRoleId: z.string().trim().min(1).nullable().optional(),
    agentRoleRevision: z.number().int().nonnegative().optional(),
    issuePRMentions: z.array(IssuePRMentionSchema).optional(),
    resume: ACPSessionIdSchema.optional(),
    chainDepth: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const trimOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const maybeParseField = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  normalize?: (parsed: T) => T | undefined
): T | undefined => {
  if (typeof value === 'undefined') {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return normalize ? normalize(parsed.data) : parsed.data;
};

export const normalizeSessionTurnInputConfig = (
  value: unknown
): SessionTurnInputConfig | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized: SessionTurnInputConfig = {};

  const prompt = trimOptionalString(record.prompt);
  if (prompt) {
    normalized.prompt = prompt;
  }

  const inputBlocks = maybeParseField(SessionInputBlocksSchema, record.inputBlocks);
  if (inputBlocks) {
    normalized.inputBlocks = inputBlocks;
  }

  const cliType = maybeParseField(AgentConfigCliTypeSchema, record.cliType);
  if (cliType) {
    normalized.cliType = cliType;
  }

  const agentType = trimOptionalString(record.agentType);
  if (agentType) {
    normalized.agentType = agentType;
  }

  const customAcp = maybeParseField(CustomAcpLaunchSpecSchema, record.customAcp);
  if (customAcp) {
    normalized.customAcp = customAcp;
  }

  const runtimeOverrides = maybeParseField(BuiltinRuntimeOverridesSchema, record.runtimeOverrides);
  if (runtimeOverrides) {
    normalized.runtimeOverrides = runtimeOverrides;
  }

  const modeId = trimOptionalString(record.modeId);
  if (modeId) {
    normalized.modeId = modeId;
  }

  const modelId = trimOptionalString(record.modelId);
  if (modelId) {
    normalized.modelId = modelId;
  }

  const configOptionValues = maybeParseField(
    AcpConfigOptionValuesSchema,
    record.configOptionValues
  );
  if (configOptionValues) {
    normalized.configOptionValues = configOptionValues;
  }

  const mcpServerIds = normalizeMcpServerIdSelection(record.mcpServerIds);
  if (mcpServerIds) {
    normalized.mcpServerIds = mcpServerIds;
  }

  const taskToolsEnabled = maybeParseField(z.boolean(), record.taskToolsEnabled);
  if (taskToolsEnabled !== undefined) {
    normalized.taskToolsEnabled = taskToolsEnabled;
  }

  if (record.agentRoleId === null) {
    normalized.agentRoleId = null;
  } else {
    const agentRoleId = trimOptionalString(record.agentRoleId);
    if (agentRoleId) {
      normalized.agentRoleId = agentRoleId as AgentRoleId;
    }
  }

  const agentRoleRevision = maybeParseField(
    z.number().int().nonnegative(),
    record.agentRoleRevision
  );
  if (agentRoleRevision !== undefined) {
    normalized.agentRoleRevision = agentRoleRevision;
  }

  const issuePRMentions = maybeParseField(z.array(IssuePRMentionSchema), record.issuePRMentions);
  if (issuePRMentions) {
    normalized.issuePRMentions = issuePRMentions;
  }

  const resume = maybeParseField(ACPSessionIdSchema, record.resume, (parsed) => {
    const trimmed = parsed.trim();
    return trimmed ? (trimmed as ACPSessionId) : undefined;
  });
  if (resume) {
    normalized.resume = resume as ACPSessionId;
  }

  const chainDepth = maybeParseField(z.number().int().nonnegative(), record.chainDepth);
  if (chainDepth !== undefined) {
    normalized.chainDepth = chainDepth;
  }

  const looseParsed = LooseSessionTurnInputConfigSchema.safeParse(record);
  if (!looseParsed.success && Object.keys(normalized).length === 0) {
    return undefined;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

export const ProjectRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('github'),
      repoFullName: z.string(),
      branch: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('local'),
      localProjectId: LocalProjectIdSchema,
      branch: z.string().trim().min(1).optional(),
      githubRepoFullName: z.string().trim().min(1).optional(),
      useWorktree: z.boolean().optional(),
    })
    .strict(),
]);

export const SessionStartMetaSchema = z
  .object({
    fromFeedbackPostId: z.string().trim().min(1).optional(),
  })
  .strict();

// ============================================
// CONTROL MESSAGE SCHEMAS
// ============================================

export const SessionCreateRequestSchema = z
  .object({
    type: z.literal('session/create'),
    sessionId: SessionIdSchema,
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    project: ProjectRefSchema.optional(),
    meta: SessionStartMetaSchema.optional(),
    acpSessionConfig: ACPSessionConfigSchema,
    worktreeSetup: WorktreeSetupScriptConfigSchema.optional(),
    worktreeCleanup: WorktreeCleanupScriptConfigSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
    userTurnId: z.string().optional(),
    userId: z.string(),
    userName: z.string(),
    userEmail: z.string(),
    parentSessionId: SessionIdSchema.optional(),
  })
  .strict();

export const SessionCreateResponseSchema = z
  .object({
    type: z.literal('session/create_response'),
    sessionId: SessionIdSchema,
    success: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export const SessionCreateAckSchema = z
  .object({
    type: z.literal('session/create_ack'),
    sessionId: SessionIdSchema,
  })
  .strict();

export const SessionChatRequestSchema = z
  .object({
    type: z.literal('session/chat'),
    sessionId: SessionIdSchema,
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    project: ProjectRefSchema.optional(),
    acpSessionConfig: ACPSessionConfigSchema,
    userTurnId: z.string(),
    userId: z.string(),
    userName: z.string(),
    userEmail: z.string(),
  })
  .strict();

export const SessionChatResponseSchema = z
  .object({
    type: z.literal('session/chat_response'),
    sessionId: SessionIdSchema,
    userTurnId: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export const SessionChatAckSchema = z
  .object({
    type: z.literal('session/chat_ack'),
    sessionId: SessionIdSchema,
    userTurnId: z.string(),
  })
  .strict();

export const SessionCancelRequestSchema = z
  .object({
    type: z.literal('session/cancel'),
    sessionId: SessionIdSchema,
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    turnId: z.string(),
  })
  .strict();

export const SessionCancelResponseSchema = z
  .object({
    type: z.literal('session/cancel_response'),
    sessionId: SessionIdSchema,
    success: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export const SessionSteerRequestSchema = z
  .object({
    type: z.literal('session/steer'),
    sessionId: SessionIdSchema,
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    expectedTurnId: z.string().trim().min(1),
    userTurnId: z.string().trim().min(1),
    userId: z.string().trim().min(1),
    timestamp: z.string().trim().min(1),
    inputConfig: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * `applied` is an execution acknowledgement: the adapter observed the queued
 * prompt's SDK activation and the CLI committed the new turn ownership. It is
 * deliberately stronger than the delivery-only `accepted` dispatch response.
 */
export const SessionSteerResponseSchema = z
  .object({
    type: z.literal('session/steer_response'),
    sessionId: SessionIdSchema,
    userTurnId: z.string().trim().min(1),
    applied: z.boolean(),
    disposition: z.enum([
      'applied',
      'unsupported',
      'no-active-turn',
      'stale-turn',
      'busy',
      'error',
    ]),
    error: z.string().optional(),
  })
  .strict();

export const SessionTerminateResponseSchema = z
  .object({
    type: z.literal('session/terminate_response'),
    sessionId: SessionIdSchema,
    success: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export const SessionForkErrorCodeSchema = z.enum([
  'SOURCE_SESSION_NOT_FOUND',
  'SOURCE_SESSION_ARCHIVED',
  'SOURCE_SESSION_BUSY',
  'SOURCE_TURN_NOT_FORKABLE',
  'SOURCE_PROJECT_NOT_WORKTREE_CAPABLE',
  'SOURCE_WORKTREE_DIRTY',
  'SOURCE_HEAD_UNAVAILABLE',
  'FORK_UNAVAILABLE',
  'TARGET_SESSION_CONFLICT',
  'MACHINE_ACCESS_DENIED',
  'ACP_FORK_FAILED',
  'WORKTREE_CREATE_FAILED',
  'WORKTREE_SETUP_FAILED',
  'HISTORY_CLONE_FAILED',
  'TARGET_WRITE_FAILED',
  'INTERNAL_ERROR',
]);

export const SessionForkWarningCodeSchema = z.enum([
  'ATTACHMENT_UNAVAILABLE',
  'HISTORICAL_TURN_DIFF_UNAVAILABLE',
]);

export const SessionEditAndResendErrorCodeSchema = z.enum([
  'SESSION_NOT_FOUND',
  'SESSION_ARCHIVED',
  'UNSUPPORTED_AGENT',
  'STALE_USER_TURN',
  'USER_TURN_NOT_EDITABLE',
  'ACTIVE_AUTOMATION',
  'MACHINE_ACCESS_DENIED',
  'ACP_SESSION_UNAVAILABLE',
  'ACP_FORK_FAILED',
  'CANCEL_FAILED',
  'HISTORY_WRITE_FAILED',
  'INTERNAL_ERROR',
]);

export const SessionEditAndResendSpecSchema = z
  .object({
    sessionId: SessionIdSchema,
    expectedUserTurnId: z.string().trim().min(1),
    replacementUserTurnId: z.string().trim().min(1),
    requestedByUserId: z.string().trim().min(1),
    timestamp: z.string().trim().min(1),
    // Opaque on the wire. The owning CLI applies the same normalization used
    // for ordinary dispatch before it creates the replacement history entry.
    inputConfig: z.record(z.string(), z.unknown()),
  })
  .strict()
  .refine((spec) => spec.expectedUserTurnId !== spec.replacementUserTurnId, {
    message: 'replacementUserTurnId must differ from expectedUserTurnId',
    path: ['replacementUserTurnId'],
  });

export const SessionEditAndResendResponseSchema = z
  .object({
    type: z.literal('session/edit-and-resend_response'),
    sessionId: SessionIdSchema,
    replacementUserTurnId: z.string().trim().min(1),
    success: z.boolean(),
    error: z
      .object({
        code: SessionEditAndResendErrorCodeSchema,
        message: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SessionForkSpecSchema = z
  .object({
    sourceSessionId: SessionIdSchema,
    sourceTurnId: z.string().trim().min(1),
    targetSessionId: SessionIdSchema,
    requestedByUserId: z.string().trim().min(1),
    targetContext: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('shared') }).strict(),
        z
          .object({
            kind: z.literal('new-worktree'),
            acknowledgeDirtySource: z.literal(true).optional(),
          })
          .strict(),
      ])
      .optional(),
    targetPlacement: z.literal('side-panel').optional(),
  })
  .strict()
  .refine((spec) => !(spec.targetContext?.kind === 'new-worktree' && spec.targetPlacement), {
    message: 'A new-worktree fork cannot use child-session placement.',
    path: ['targetPlacement'],
  });

export const SessionForkResponseSchema = z
  .object({
    type: z.literal('session/fork_response'),
    sourceSessionId: SessionIdSchema,
    targetSessionId: SessionIdSchema,
    success: z.boolean(),
    disposition: z.enum(['accepted', 'confirmation-required', 'completed', 'failed']).optional(),
    operationId: z.string().trim().min(1).optional(),
    reason: z.literal('SOURCE_WORKTREE_DIRTY').optional(),
    partial: z.boolean(),
    warnings: z.array(
      z
        .object({
          code: SessionForkWarningCodeSchema,
          message: z.string().trim().min(1),
        })
        .strict()
    ),
    error: z
      .object({
        code: SessionForkErrorCodeSchema,
        message: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SessionForkOperationSchema = z
  .object({
    id: z.string().trim().min(1),
    sourceSessionId: SessionIdSchema,
    sourceTurnId: z.string().trim().min(1),
    requestedByUserId: z.string().trim().min(1),
    targetContext: z.enum(['shared', 'new-worktree']),
    capturedHeadSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/u)
      .optional(),
    sourceWasDirty: z.boolean().optional(),
    state: z.enum(['preparing', 'failed']),
    phase: z
      .enum(['preparing-worktree', 'running-setup', 'starting-agent', 'committing'])
      .optional(),
    error: z
      .object({
        code: SessionForkErrorCodeSchema,
        message: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1),
  })
  .strict();

export type SessionForkSpec = z.infer<typeof SessionForkSpecSchema>;
export type SessionForkResponse = z.infer<typeof SessionForkResponseSchema>;
export type SessionForkErrorCode = z.infer<typeof SessionForkErrorCodeSchema>;
export type SessionForkWarningCode = z.infer<typeof SessionForkWarningCodeSchema>;
export type SessionForkOperation = z.infer<typeof SessionForkOperationSchema>;
export type SessionEditAndResendSpec = z.infer<typeof SessionEditAndResendSpecSchema>;
export type SessionEditAndResendResponse = z.infer<typeof SessionEditAndResendResponseSchema>;
export type SessionEditAndResendErrorCode = z.infer<typeof SessionEditAndResendErrorCodeSchema>;

export function sessionEditAndResendFailure(
  spec: Pick<SessionEditAndResendSpec, 'sessionId' | 'replacementUserTurnId'>,
  code: SessionEditAndResendErrorCode,
  message: string
): SessionEditAndResendResponse {
  return {
    type: 'session/edit-and-resend_response',
    sessionId: spec.sessionId,
    replacementUserTurnId: spec.replacementUserTurnId,
    success: false,
    error: { code, message },
  };
}

/**
 * Canonical failure envelope for `session/fork`. Every rejection path (CLI
 * service, CLI access check, web facade, RPC error mapper) builds its response
 * here so the shape stays in one place.
 */
export function sessionForkFailure(
  ids: Pick<SessionForkResponse, 'sourceSessionId' | 'targetSessionId'>,
  code: SessionForkErrorCode,
  message: string
): SessionForkResponse {
  return {
    type: 'session/fork_response',
    sourceSessionId: ids.sourceSessionId,
    targetSessionId: ids.targetSessionId,
    success: false,
    partial: false,
    warnings: [],
    error: { code, message },
  };
}

/**
 * Machine RPC fast-path dispatch of a user turn (`session/dispatch-turn`).
 * `accepted` means the machine durably holds the turn payload (or already ran
 * it); it is a delivery ACK, not an authorization or execution result.
 */
export const SessionDispatchTurnResponseSchema = z
  .object({
    type: z.literal('session/dispatch-turn_response'),
    sessionId: SessionIdSchema,
    userTurnId: z.string().trim().min(1),
    accepted: z.boolean(),
    disposition: z.enum(['accepted', 'duplicate', 'already-terminal', 'not-owned', 'error']),
    error: z.string().optional(),
  })
  .strict();

export type SessionDispatchTurnResponse = z.infer<typeof SessionDispatchTurnResponseSchema>;

const SessionPreparationIdSchema = z.string().trim().min(1).max(128);
export const SessionPreparationRunConfigSchema = z
  .object({
    modeId: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).optional(),
    configOptionValues: AcpConfigOptionValuesSchema.transform((values) =>
      Object.fromEntries(
        Object.entries(values).filter(([configId]) => !isSensitiveAcpConfigOptionId(configId))
      )
    ).optional(),
    mcpServerIds: z
      .array(z.string())
      .transform((ids) => normalizeMcpServerIdSelection(ids) ?? [])
      .optional(),
    taskToolsEnabled: z.boolean().optional(),
  })
  .strict();

/**
 * Ephemeral ACP preparation for a draft session. Draft text, launch secrets,
 * and secret-shaped ACP option values stay out of the RPC request stream.
 */
export const SessionPreparationSpecSchema = z
  .object({
    preparationId: SessionPreparationIdSchema,
    sessionId: SessionIdSchema,
    requestedByUserId: z.string().trim().min(1),
    agentConfigId: AgentConfigIdSchema,
    cliType: AgentConfigCliTypeSchema,
    agentType: z.string().trim().min(1),
    project: ProjectRefSchema.optional(),
    runConfig: SessionPreparationRunConfigSchema.optional(),
  })
  .strict();

export type SessionPreparationSpec = z.infer<typeof SessionPreparationSpecSchema>;

export const SessionPreparationCancelSpecSchema = z
  .object({
    preparationId: SessionPreparationIdSchema,
    sessionId: SessionIdSchema,
    requestedByUserId: z.string().trim().min(1),
  })
  .strict();

export type SessionPreparationCancelSpec = z.infer<typeof SessionPreparationCancelSpecSchema>;

export const SessionPrepareResponseSchema = z
  .object({
    type: z.literal('session/prepare_response'),
    preparationId: SessionPreparationIdSchema,
    sessionId: SessionIdSchema,
    accepted: z.boolean(),
    disposition: z.enum(['accepted', 'duplicate', 'replaced', 'busy', 'not-owned', 'error']),
    error: z.string().optional(),
  })
  .strict();

export type SessionPrepareResponse = z.infer<typeof SessionPrepareResponseSchema>;

export const SessionPrepareCancelResponseSchema = z
  .object({
    type: z.literal('session/prepare-cancel_response'),
    preparationId: SessionPreparationIdSchema,
    sessionId: SessionIdSchema,
    cancelled: z.boolean(),
    disposition: z.enum(['cancelled', 'not-found', 'not-owned', 'error']),
    error: z.string().optional(),
  })
  .strict();

export type SessionPrepareCancelResponse = z.infer<typeof SessionPrepareCancelResponseSchema>;

// Permission schemas (simplified - actual types come from @agentclientprotocol/sdk)
const PermissionMetaSchema = z.record(z.string(), z.unknown()).nullable();

export const PermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  kind: z.enum(['allow_once', 'allow_always', 'deny', 'reject_once']).optional(),
});

export const RequestPermissionRequestSchema = z.object({
  sessionId: SessionIdSchema,
  toolCall: z
    .object({
      toolCallId: z.string(),
      title: z.string().optional(),
      status: z.string().optional(),
      kind: z.string().optional(),
    })
    .loose(),
  options: z.array(PermissionOptionSchema),
  _meta: PermissionMetaSchema.optional(),
});

export const PermissionOutcomeSchema = z.union([
  z.object({ outcome: z.literal('cancelled'), _meta: PermissionMetaSchema.optional() }).loose(),
  z
    .object({
      outcome: z.literal('selected'),
      optionId: z.string(),
      _meta: PermissionMetaSchema.optional(),
    })
    .loose(),
]);

export const PermissionRequestMessageSchema = z
  .object({
    type: z.literal('session/permission_request'),
    sessionId: SessionIdSchema,
    requestId: z.string(),
    request: RequestPermissionRequestSchema.loose(),
  })
  .strict();

export const PermissionResponseMessageSchema = z.object({
  type: z.literal('session/permission_response'),
  sessionId: SessionIdSchema,
  requestId: z.string(),
  outcome: PermissionOutcomeSchema,
});

// ============================================
// MACHINE STATUS AND CONTROL SCHEMAS
// ============================================

export const MachineResourceInfoSchema = z
  .object({
    totalMemoryGB: z.number(),
    usedMemoryGB: z.number(),
    freeMemoryGB: z.number(),
    totalCpus: z.number(),
    cpuUsagePercent: z.number(),
  })
  .strict();

export const MachineStatusRequestSchema = z
  .object({
    type: z.literal('machine/status'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .strict();

export const MachineLifecycleLaunchModeSchema = z.enum([
  'daemon',
  'foreground',
  'electron',
  'unknown',
]);

export const MachineLifecycleUnsupportedReasonSchema = z.enum([
  'not_daemon',
  'electron',
  'unsupported_install',
]);

export const MachineLifecycleCapabilitySchema = z
  .object({
    launchMode: MachineLifecycleLaunchModeSchema,
    canRemoteRestart: z.boolean(),
    canRemoteUpgrade: z.boolean(),
    reason: MachineLifecycleUnsupportedReasonSchema.optional(),
  })
  .strict();

export const MachineStatusResponseSchema = z
  .object({
    type: z.literal('machine/status_response'),
    machineId: MachineIdSchema,
    success: z.boolean(),
    resources: MachineResourceInfoSchema.optional(),
    lifecycle: MachineLifecycleCapabilitySchema.optional(),
    error: z.string().optional(),
  })
  .strict();

export const MachinePingRequestSchema = z
  .object({
    type: z.literal('machine/ping'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    requestId: z.string().trim().min(1),
  })
  .strict();

export const MachinePingResponseSchema = z
  .object({
    type: z.literal('machine/ping_response'),
    machineId: MachineIdSchema,
    requestId: z.string().trim().min(1),
    success: z.boolean(),
    message: z.literal('pong').optional(),
    error: z.string().optional(),
  })
  .strict();

export const MachineLifecycleDispositionSchema = z.enum([
  'accepted',
  'already_pending',
  'unauthorized',
  'invalid_target',
  'unsupported_launch_mode',
  'unsupported_install',
  'error',
]);

export const MachineRestartRequestSchema = z
  .object({
    type: z.literal('machine/restart'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    requesterUserId: z.string().trim().min(1),
    requestToken: z.string().trim().min(1),
    requestId: z.string().trim().min(1),
  })
  .strict();

export const MachineRestartResponseSchema = z
  .object({
    type: z.literal('machine/restart_response'),
    machineId: MachineIdSchema,
    requestId: z.string().trim().min(1),
    success: z.boolean(),
    accepted: z.boolean(),
    disposition: MachineLifecycleDispositionSchema,
    error: z.string().optional(),
  })
  .strict();

export const MachineUpgradeRequestSchema = z
  .object({
    type: z.literal('machine/upgrade'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    requesterUserId: z.string().trim().min(1),
    requestToken: z.string().trim().min(1),
    requestId: z.string().trim().min(1),
    targetVersion: z.string().trim().min(1).optional(),
  })
  .strict();

export const MachineUpgradeResponseSchema = z
  .object({
    type: z.literal('machine/upgrade_response'),
    machineId: MachineIdSchema,
    requestId: z.string().trim().min(1),
    success: z.boolean(),
    accepted: z.boolean(),
    disposition: MachineLifecycleDispositionSchema,
    currentVersion: z.string().optional(),
    targetVersion: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

const AcpModeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
  })
  .strict();

const AcpModelSchema = z
  .object({
    modelId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

const AcpConfigOptionValueSummarySchema = z
  .object({
    value: z.string(),
    name: z.string(),
    description: z.string().optional(),
    group: z.string().optional(),
  })
  .strict();

const AcpConfigOptionSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    category: z.string().optional(),
    type: z.enum(['select', 'boolean']),
    currentValue: AcpConfigOptionValueSchema,
    options: z.array(AcpConfigOptionValueSummarySchema),
  })
  .strict();

const AcpCapabilityCacheEntrySchema = z
  .object({
    cliType: AgentConfigCliTypeSchema,
    agentType: z.string().trim().min(1),
    cacheVersion: z.number().optional(),
    provenance: z.literal('runtime').optional(),
    sourceVersion: z.string().optional(),
    modes: z.array(AcpModeSchema),
    models: z.array(AcpModelSchema),
    configOptions: z.array(AcpConfigOptionSummarySchema).optional(),
    modelReasoningEfforts: z.record(z.string(), z.array(z.string())).optional(),
    availableCommands: z
      .array(
        z
          .object({
            name: z.string(),
            description: z.string().optional(),
          })
          .strict()
      )
      .optional(),
    sessionFork: z.boolean().optional(),
    acknowledgedSteer: z.boolean().optional(),
    sessionForkWorktree: z.boolean().optional(),
    fetchedAt: z.number(),
  })
  .strict();

const MachineAcpAuthMethodSummarySchema = z
  .object({
    type: z.enum(['agent', 'env_var', 'terminal']),
    id: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH).optional(),
    name: z.string().max(ACP_AUTH_LABEL_MAX_LENGTH).optional(),
    description: z.string().max(ACP_AUTH_TEXT_MAX_LENGTH).optional(),
    args: z.array(z.string().max(ACP_AUTH_LABEL_MAX_LENGTH)).max(64).optional(),
  })
  .strict();

const MachineAcpAuthenticationFormFieldSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH),
      type: z.literal('text'),
      label: z.string().trim().min(1).max(ACP_AUTH_LABEL_MAX_LENGTH),
      description: z.string().max(ACP_AUTH_TEXT_MAX_LENGTH).optional(),
      required: z.boolean(),
      defaultValue: z.string().max(ACP_AUTH_TEXT_MAX_LENGTH).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH),
      type: z.literal('secret'),
      label: z.string().trim().min(1).max(ACP_AUTH_LABEL_MAX_LENGTH),
      description: z.string().max(ACP_AUTH_TEXT_MAX_LENGTH).optional(),
      required: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH),
      type: z.literal('select'),
      label: z.string().trim().min(1).max(ACP_AUTH_LABEL_MAX_LENGTH),
      description: z.string().max(ACP_AUTH_TEXT_MAX_LENGTH).optional(),
      required: z.boolean(),
      options: z
        .array(
          z
            .object({
              value: z.string().min(1).max(ACP_AUTH_TEXT_MAX_LENGTH),
              label: z.string().trim().min(1).max(ACP_AUTH_LABEL_MAX_LENGTH),
            })
            .strict()
        )
        .min(1)
        .max(ACP_AUTH_SELECT_OPTION_MAX_COUNT),
      defaultValue: z.string().max(ACP_AUTH_TEXT_MAX_LENGTH).optional(),
    })
    .strict(),
]);

const MachineAcpAuthenticationFormSchema = z
  .object({
    title: z.string().max(ACP_AUTH_LABEL_MAX_LENGTH).optional(),
    description: z.string().max(ACP_AUTH_TEXT_MAX_LENGTH).optional(),
    fields: z
      .array(MachineAcpAuthenticationFormFieldSchema)
      .min(1)
      .max(ACP_AUTH_FORM_FIELD_MAX_COUNT),
  })
  .strict()
  .superRefine((value, context) => {
    if (!isAcpAuthenticationFormWithinByteLimit(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Authentication form exceeds the serialized size limit',
      });
    }
    const fieldIds = new Set<string>();
    value.fields.forEach((field, fieldIndex) => {
      if (fieldIds.has(field.id)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'id'],
          message: 'Authentication form field ids must be unique',
        });
      }
      fieldIds.add(field.id);
      if (field.type !== 'select') return;
      const optionValues = new Set<string>();
      field.options.forEach((option, optionIndex) => {
        if (optionValues.has(option.value)) {
          context.addIssue({
            code: 'custom',
            path: ['fields', fieldIndex, 'options', optionIndex, 'value'],
            message: 'Authentication select option values must be unique',
          });
        }
        optionValues.add(option.value);
      });
      if (field.defaultValue !== undefined && !optionValues.has(field.defaultValue)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'defaultValue'],
          message: 'Authentication select default must match an option',
        });
      }
    });
  });

export const MachineAcpCapabilitiesRefreshRequestSchema = z
  .object({
    type: z.literal('machine/acp-capabilities-refresh'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    configId: AgentConfigIdSchema,
  })
  .strict();

export const MachineAcpCapabilitiesRefreshResponseSchema = z
  .object({
    type: z.literal('machine/acp-capabilities-refresh_response'),
    machineId: MachineIdSchema,
    configId: AgentConfigIdSchema,
    cliType: AgentConfigCliTypeSchema,
    agentType: z.string().trim().min(1),
    success: z.boolean(),
    modes: z.array(AcpModeSchema).optional(),
    models: z.array(AcpModelSchema).optional(),
    configOptions: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          category: z.string().optional(),
          optionCount: z.number(),
        })
      )
      .optional(),
    capability: AcpCapabilityCacheEntrySchema.optional(),
    availableCommands: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
        })
      )
      .optional(),
    authRequired: z.boolean().optional(),
    authMethods: z
      .array(MachineAcpAuthMethodSummarySchema)
      .max(ACP_AUTH_METHOD_MAX_COUNT)
      .optional(),
    error: z.string().optional(),
  })
  .strict();

const MachineAcpAuthenticateRequestBaseSchema = z.object({
  type: z.literal('machine/acp-authenticate'),
  machineId: MachineIdSchema,
  workspaceId: WorkspaceIdSchema,
  requestId: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH),
});

export const MachineAcpAuthenticateRequestSchema = z.discriminatedUnion('action', [
  MachineAcpAuthenticateRequestBaseSchema.extend({
    action: z.literal('start'),
    configId: AgentConfigIdSchema,
  }).strict(),
  MachineAcpAuthenticateRequestBaseSchema.extend({
    action: z.literal('cancel'),
    authenticationRequestId: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH),
  }).strict(),
  MachineAcpAuthenticateRequestBaseSchema.extend({
    action: z.literal('submit-code'),
    authenticationRequestId: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH),
    authorizationCode: z.string().trim().min(1).max(ACP_AUTH_LABEL_MAX_LENGTH),
  }).strict(),
  MachineAcpAuthenticateRequestBaseSchema.extend({
    action: z.literal('submit-input'),
    authenticationRequestId: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH),
    interactionId: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH),
    authenticationInput: z.string().min(1).max(65536),
  }).strict(),
]);

export const MachineAcpAuthenticateResponseSchema = z
  .object({
    type: z.literal('machine/acp-authenticate_response'),
    machineId: MachineIdSchema,
    requestId: z.string().trim().min(1),
    agentType: z.string().trim().min(1),
    success: z.boolean(),
    disposition: z.enum([
      'authenticated',
      'cancelled',
      'not-running',
      'input-accepted',
      'method-required',
      'error',
    ]),
    capabilitiesRefreshed: z.boolean().optional(),
    authRequired: z.boolean().optional(),
    authMethods: z
      .array(MachineAcpAuthMethodSummarySchema)
      .max(ACP_AUTH_METHOD_MAX_COUNT)
      .optional(),
    error: z.string().optional(),
  })
  .strict();

export const MachineAcpAuthenticationProgressMessageSchema = z
  .object({
    type: z.literal('machine/acp-authentication-progress'),
    machineId: MachineIdSchema,
    requestId: z.string().trim().min(1),
    agentType: z.string().trim().min(1),
    status: z.enum([
      'starting',
      'auth-methods',
      'authorization',
      'input-required',
      'output',
      'authenticated',
      'cancelled',
      'error',
    ]),
    authMethods: z
      .array(MachineAcpAuthMethodSummarySchema)
      .max(ACP_AUTH_METHOD_MAX_COUNT)
      .optional(),
    interactionId: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH).optional(),
    message: z.string().max(ACP_AUTH_TEXT_MAX_LENGTH).optional(),
    form: MachineAcpAuthenticationFormSchema.optional(),
    authorizationUrl: z
      .string()
      .url()
      .max(ACP_AUTHORIZATION_URL_MAX_LENGTH)
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'https:' || protocol === 'http:';
      }, 'authorizationUrl must use http or https')
      .optional(),
    userCode: z.string().trim().min(1).max(128).optional(),
    acceptsAuthorizationCode: z.boolean().optional(),
    authorizationCodePublicKey: RpcSecretPublicKeySchema.optional(),
    authenticationInputPublicKey: RpcSecretPublicKeySchema.optional(),
    requiresAuthorizationConsent: z.boolean().optional(),
    expiresInSeconds: z.number().int().positive().optional(),
    stream: z.enum(['stdout', 'stderr']).optional(),
    output: z.string().max(16_384).optional(),
    error: z.string().max(65_536).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'authorization' && !value.authorizationUrl) {
      context.addIssue({
        code: 'custom',
        path: ['authorizationUrl'],
        message: 'authorizationUrl is required for authorization progress',
      });
    }
    if (
      value.status === 'auth-methods' &&
      (!value.interactionId ||
        !value.authMethods?.length ||
        value.authMethods.some((method) => !method.id || method.type !== 'agent') ||
        new Set(value.authMethods.map((method) => method.id)).size !== value.authMethods.length)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['authMethods'],
        message: 'auth-methods progress requires an interaction and methods with ids',
      });
    }
    if (value.status === 'input-required' && (!value.interactionId || !value.form)) {
      context.addIssue({
        code: 'custom',
        path: ['form'],
        message: 'input-required progress requires an interaction and form',
      });
    }
    if (
      value.status === 'authorization' &&
      value.requiresAuthorizationConsent &&
      !value.interactionId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['interactionId'],
        message: 'URL consent requires an interaction id',
      });
    }
  });

export const MachineAcpBinaryStatusRequestSchema = z
  .object({
    type: z.literal('machine/acp-binary-status'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    agentType: z.string().trim().min(1),
  })
  .strict();

export const MachineAcpBinaryStatusResponseSchema = z
  .object({
    type: z.literal('machine/acp-binary-status_response'),
    machineId: MachineIdSchema,
    agentType: z.string().trim().min(1),
    success: z.boolean(),
    status: z.enum([
      'installed',
      'not-applicable',
      'not-installed',
      'unsupported-platform',
      'incompatible-host',
      'error',
    ]),
    command: z.string().optional(),
    platformArch: z.string().optional(),
    installPath: z.string().optional(),
    version: z.string().optional(),
    current: z.string().optional(),
    required: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export const MachineAcpBinaryInstallRequestSchema = z
  .object({
    type: z.literal('machine/acp-binary-install'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    agentType: z.string().trim().min(1),
  })
  .strict();

export const MachineAcpBinaryInstallResponseSchema = z
  .object({
    type: z.literal('machine/acp-binary-install_response'),
    machineId: MachineIdSchema,
    agentType: z.string().trim().min(1),
    success: z.boolean(),
    command: z.string().optional(),
    installPath: z.string().optional(),
    version: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export const MachineAcpBinaryProgressMessageSchema = z
  .object({
    type: z.literal('machine/acp-binary-progress'),
    machineId: MachineIdSchema,
    agentType: z.string().trim().min(1),
    status: z.enum([
      'checking',
      'not-installed',
      'downloading',
      'verifying',
      'extracting',
      'publishing',
      'installed',
      'unsupported-platform',
      'incompatible-host',
      'error',
    ]),
    downloadedBytes: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    percent: z.number().min(0).max(100).optional(),
    platformArch: z.string().optional(),
    version: z.string().optional(),
    current: z.string().optional(),
    required: z.string().optional(),
    command: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export const MachineBugReportRequestSchema = z
  .object({
    type: z.literal('machine/bug-report'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    description: z.string().trim().min(1),
    reporterUserId: z.string().trim().min(1),
    requestToken: z.string().trim().min(1),
  })
  .strict();

export const MachineBugReportResponseSchema = z
  .object({
    type: z.literal('machine/bug-report_response'),
    machineId: MachineIdSchema,
    success: z.boolean(),
    bugReportId: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

const SessionCodeCollabHostStartStatusSchema = z.enum([
  'started',
  'already-running',
  'disabled',
  'failed',
  'stopped',
]);

/**
 * @deprecated Legacy compatibility only. Code Collab v2 uses machine RPC methods
 * under `code-collab/*`; current CLIs reject this request as unsupported.
 */
export const SessionCodeCollabHostStartRequestSchema = z
  .object({
    type: z.literal('session/code-collab-host-start'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    sessionId: SessionIdSchema,
    requestedByUserId: z.string().trim().min(1),
  })
  .strict();

/**
 * @deprecated Legacy compatibility response for `session/code-collab-host-start`.
 */
export const SessionCodeCollabHostStartResponseSchema = z
  .object({
    type: z.literal('session/code-collab-host-start_response'),
    sessionId: SessionIdSchema,
    success: z.boolean(),
    status: SessionCodeCollabHostStartStatusSchema.optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

export const SessionImageUploadRequestSchema = z
  .object({
    type: z.literal('session/image-upload'),
    machineId: MachineIdSchema,
    sessionId: SessionIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    paths: z.array(z.string().trim().min(1)).min(1).max(SESSION_IMAGE_MAX_COUNT),
  })
  .strict();

export const SessionImageUploadResponseSchema = z
  .object({
    type: z.literal('session/image-upload_response'),
    sessionId: SessionIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    success: z.boolean(),
    error: z.string().optional(),
    message: z.string().optional(),
    historyEntryId: z.string().optional(),
    attachedTo: z.enum(['active_turn', 'new_entry']).optional(),
    content: SessionImageGroupContentSchema.optional(),
    images: z
      .array(
        SessionImagePayloadSchema.extend({
          downloadUrl: z.string().url(),
        }).strict()
      )
      .min(1)
      .max(SESSION_IMAGE_MAX_COUNT)
      .optional(),
  })
  .strict();

export const SessionFileUploadRequestSchema = z
  .object({
    type: z.literal('session/file-upload'),
    machineId: MachineIdSchema,
    sessionId: SessionIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    paths: z.array(z.string().trim().min(1)).min(1).max(SESSION_FILE_MAX_COUNT),
  })
  .strict();

export const SessionFileUploadResponseSchema = z
  .object({
    type: z.literal('session/file-upload_response'),
    sessionId: SessionIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    success: z.boolean(),
    error: z.string().optional(),
    message: z.string().optional(),
    historyEntryId: z.string().optional(),
    attachedTo: z.enum(['active_turn', 'new_entry']).optional(),
    files: z
      .array(
        // Cloud uploads are always relay-stored; only the send-local response
        // may carry transport 'local'.
        SessionFileBlockObjectSchema.extend({
          downloadUrl: z.string().url(),
          transport: z.literal('r2'),
        }).strict()
      )
      .min(1)
      .max(SESSION_FILE_MAX_COUNT)
      .optional(),
  })
  .strict();

export const SessionFileSendLocalRequestSchema = z
  .object({
    type: z.literal('session/file-send-local'),
    machineId: MachineIdSchema,
    sessionId: SessionIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    paths: z.array(z.string().trim().min(1)).min(1).max(SESSION_FILE_MAX_COUNT),
  })
  .strict();

export const SessionFileSendLocalResponseSchema = z
  .object({
    type: z.literal('session/file-send-local_response'),
    sessionId: SessionIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    success: z.boolean(),
    error: z.string().optional(),
    message: z.string().optional(),
    // Local-transport blocks carry no downloadUrl (bytes not yet in the relay
    // store). `SessionFileBlockSchema` enforces the transport='local' ⇒
    // machineId invariant via its superRefine.
    files: z.array(SessionFileBlockSchema).min(1).max(SESSION_FILE_MAX_COUNT).optional(),
  })
  .strict();

const PreviewProtocolSchema = z.enum(['http', 'https']);

export const PreviewTargetSchema = z
  .object({
    protocol: PreviewProtocolSchema,
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    path: z.string().trim().min(1).max(16_384).optional(),
  })
  .strict();

const PreviewCandidateSourceSchema = z
  .object({
    toolName: z.string().trim().min(1).optional(),
    devServerType: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    pid: z.number().int().positive().optional(),
  })
  .strict();

const PreviewErrorCodeSchema = z.enum([
  'host_not_loopback',
  'host_not_private',
  'host_prohibited',
  'target_resolution_failed',
  'target_changed',
  'user_confirmation_required',
  'invalid_port',
  'invalid_protocol',
  'session_mismatch',
  'session_not_found',
  'session_archived',
  'port_not_listening',
  'local_server_unreachable',
  'process_not_owned_by_session',
  'preview_already_active',
  'resource_limit_exceeded',
  'preview_expired',
  'preview_idle_timeout',
  'grant_denied',
  'tunnel_not_configured',
  'tunnel_creation_failed',
  'cloud_authorization_failed',
  'internal_error',
]);

const PreviewValidationStageSchema = z.enum(['report', 'create', 'connect', 'revoke']);

const PreviewValidationResultSchema = z
  .object({
    lastCheckedAt: z.number().int().nonnegative(),
    stage: PreviewValidationStageSchema,
    ok: z.boolean(),
    errorCode: PreviewErrorCodeSchema.optional(),
    message: z.string().optional(),
  })
  .strict();

const PreviewCandidateSchema = z
  .object({
    status: z.enum(['none', 'reported', 'validating', 'available', 'invalid']),
    candidateId: z.string().optional(),
    target: PreviewTargetSchema.optional(),
    source: PreviewCandidateSourceSchema.optional(),
    reportedAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
    validation: PreviewValidationResultSchema.optional(),
  })
  .strict();

const PreviewConnectionErrorSchema = z
  .object({
    stage: PreviewValidationStageSchema,
    errorCode: PreviewErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();

const PreviewResourceLimitsSchema = z
  .object({
    maxRequestBodyBytes: z.number().int().positive(),
    maxResponseBodyBytes: z.number().int().positive(),
    maxRequestDurationMs: z.number().int().positive(),
  })
  .strict();

const PreviewResourceUsageSchema = z
  .object({
    httpRequestCount: z.number().int().nonnegative().optional(),
    webSocketOpenCount: z.number().int().nonnegative().optional(),
    requestBytesIn: z.number().int().nonnegative().optional(),
    responseBytesOut: z.number().int().nonnegative().optional(),
    limitExceededCount: z.number().int().nonnegative().optional(),
    lastLimitExceededAt: z.number().int().nonnegative().optional(),
    lastCloseReason: z.string().optional(),
  })
  .strict();

const PreviewConnectionSchema = z
  .object({
    status: z.enum(['idle', 'creating', 'active', 'failed', 'revoked', 'expired']),
    grantId: z.string().optional(),
    publicUrl: z.string().url().optional(),
    tunnelId: z.string().optional(),
    target: PreviewTargetSchema.optional(),
    viewerScope: z
      .object({ type: z.literal('workspace') })
      .strict()
      .optional(),
    approvedByUserId: z.string().optional(),
    createdAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
    leaseExpiresAt: z.number().int().nonnegative().optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
    lastActiveAt: z.number().int().nonnegative().optional(),
    revokedAt: z.number().int().nonnegative().optional(),
    revokeReason: z.string().optional(),
    resourceLimits: PreviewResourceLimitsSchema.optional(),
    resourceUsage: PreviewResourceUsageSchema.optional(),
    error: PreviewConnectionErrorSchema.optional(),
  })
  .strict();

const PreviewEndpointSchema = z
  .object({
    endpointId: z.string().trim().min(1),
    kind: z.enum(['local-proxy', 'cloud-gateway']),
    viewerUrl: z.string().url(),
    shareUrl: z.string().url().optional(),
    target: PreviewTargetSchema,
    capabilities: z
      .object({
        visualAnnotation: z.boolean(),
        shareable: z.boolean(),
      })
      .strict(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const PreviewCandidateReportRequestSchema = z
  .object({
    type: z.literal('session/preview-candidate-report'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    sessionId: SessionIdSchema,
    target: PreviewTargetSchema,
    source: PreviewCandidateSourceSchema.optional(),
  })
  .strict();

export const PreviewCandidateReportResponseSchema = z
  .object({
    type: z.literal('session/preview-candidate-report_response'),
    sessionId: SessionIdSchema,
    success: z.boolean(),
    candidate: PreviewCandidateSchema.optional(),
    error: PreviewErrorCodeSchema.optional(),
    message: z.string().optional(),
  })
  .strict();

export const SessionPreviewCreateRequestSchema = z
  .object({
    type: z.literal('session/preview-create'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    sessionId: SessionIdSchema,
    requestedByUserId: z.string().trim().min(1),
    target: PreviewTargetSchema,
    approval: z
      .object({
        source: z.enum(['browser_address', 'share_action']),
        targetClass: z.literal('loopback'),
        target: PreviewTargetSchema,
        confirmedByUserId: z.string().trim().min(1),
        confirmedAt: z.number().int().nonnegative(),
      })
      .strict(),
    replaceExisting: z.boolean().optional(),
  })
  .strict();

export const SessionPreviewCreateResponseSchema = z
  .object({
    type: z.literal('session/preview-create_response'),
    sessionId: SessionIdSchema,
    success: z.boolean(),
    connection: PreviewConnectionSchema.optional(),
    error: PreviewErrorCodeSchema.optional(),
    message: z.string().optional(),
  })
  .strict();

export const SessionPreviewRevokeRequestSchema = z
  .object({
    type: z.literal('session/preview-revoke'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    sessionId: SessionIdSchema,
    requestedByUserId: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export const SessionPreviewRevokeResponseSchema = z
  .object({
    type: z.literal('session/preview-revoke_response'),
    sessionId: SessionIdSchema,
    success: z.boolean(),
    connection: PreviewConnectionSchema.optional(),
    error: PreviewErrorCodeSchema.optional(),
    message: z.string().optional(),
  })
  .strict();

export const SessionPreviewEndpointAcquireResponseSchema = z
  .object({
    type: z.literal('session/preview-endpoint-acquire_response'),
    sessionId: SessionIdSchema,
    success: z.boolean(),
    endpoint: PreviewEndpointSchema.optional(),
    error: PreviewErrorCodeSchema.optional(),
    message: z.string().optional(),
  })
  .strict();

export const SessionPreviewEndpointReleaseResponseSchema = z
  .object({
    type: z.literal('session/preview-endpoint-release_response'),
    sessionId: SessionIdSchema,
    endpointId: z.string().trim().min(1).optional(),
    success: z.boolean(),
    error: PreviewErrorCodeSchema.optional(),
    message: z.string().optional(),
  })
  .strict();

export const LocalSessionControlRequestSchema = z.discriminatedUnion('type', [
  SessionCreateRequestSchema,
  SessionChatRequestSchema,
  SessionCancelRequestSchema,
  SessionSteerRequestSchema,
  MachineStatusRequestSchema,
  MachinePingRequestSchema,
  MachineRestartRequestSchema,
  MachineUpgradeRequestSchema,
  MachineAcpCapabilitiesRefreshRequestSchema,
  MachineAcpAuthenticateRequestSchema,
  MachineAcpBinaryStatusRequestSchema,
  MachineAcpBinaryInstallRequestSchema,
  SessionCodeCollabHostStartRequestSchema,
  SessionImageUploadRequestSchema,
  SessionFileUploadRequestSchema,
  SessionFileSendLocalRequestSchema,
  PreviewCandidateReportRequestSchema,
  SessionPreviewCreateRequestSchema,
  SessionPreviewRevokeRequestSchema,
]);

export const LocalSessionControlResponseSchema = z.discriminatedUnion('type', [
  SessionCreateAckSchema,
  SessionCreateResponseSchema,
  SessionChatAckSchema,
  SessionChatResponseSchema,
  SessionCancelResponseSchema,
  SessionSteerResponseSchema,
  MachineStatusResponseSchema,
  MachinePingResponseSchema,
  MachineRestartResponseSchema,
  MachineUpgradeResponseSchema,
  MachineAcpCapabilitiesRefreshResponseSchema,
  MachineAcpAuthenticateResponseSchema,
  MachineAcpAuthenticationProgressMessageSchema,
  MachineAcpBinaryStatusResponseSchema,
  MachineAcpBinaryInstallResponseSchema,
  MachineAcpBinaryProgressMessageSchema,
  SessionCodeCollabHostStartResponseSchema,
  SessionImageUploadResponseSchema,
  SessionFileUploadResponseSchema,
  SessionFileSendLocalResponseSchema,
  PreviewCandidateReportResponseSchema,
  SessionPreviewCreateResponseSchema,
  SessionPreviewRevokeResponseSchema,
]);

export const LocalProjectAddRequestSchema = z
  .object({
    type: z.literal('local-project/add'),
    machineId: MachineIdSchema,
    rootPath: z.string().trim().min(1),
    workspace: z.string().trim().min(1).optional(),
    allWorkspaces: z.boolean().optional(),
  })
  .strict();

export const LocalProjectPrepareAddRequestSchema = z
  .object({
    type: z.literal('local-project/prepare-add'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    rootPath: z.string().trim().min(1),
  })
  .strict();

export const LocalProjectListRootsRequestSchema = z
  .object({
    type: z.literal('local-project/list-roots'),
    machineId: MachineIdSchema,
  })
  .strict();

export const LocalProjectBrowseDirRequestSchema = z
  .object({
    type: z.literal('local-project/browse-dir'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    absolutePath: z.string().trim().min(1).optional(),
    showHidden: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectDeleteRequestSchema = z
  .object({
    type: z.literal('local-project/delete'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectRemovalPreflightRequestSchema = z
  .object({
    type: z.literal('local-project/removal-preflight'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectListRequestSchema = z
  .object({
    type: z.literal('local-project/list'),
    machineId: MachineIdSchema,
  })
  .strict();

export const LocalProjectGitStateRequestSchema = z
  .object({
    type: z.literal('local-project/git-state'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
  })
  .strict();

export const LocalProjectListFilesRequestSchema = z
  .object({
    type: z.literal('local-project/list-files'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    maxFiles: z.number().int().positive().optional(),
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectListDirRequestSchema = z
  .object({
    type: z.literal('local-project/list-dir'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    relativePath: z.string(),
    limit: z.number().int().positive().optional(),
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectListSkillsRequestSchema = z
  .object({
    type: z.literal('local-project/list-skills'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    skillDirs: z.array(z.string().trim().min(1)),
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectListGlobalSkillsRequestSchema = z
  .object({
    type: z.literal('local-project/list-global-skills'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectReadFileRequestSchema = z
  .object({
    type: z.literal('local-project/read-file'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    relativePath: z.string(),
    maxBytes: z.number().int().positive().optional(),
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectCheckoutBranchRequestSchema = z
  .object({
    type: z.literal('local-project/checkout-branch'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    branchName: z.string(),
  })
  .strict();

export const LocalProjectGetWorktreeSetupRequestSchema = z
  .object({
    type: z.literal('local-project/get-worktree-setup'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectSetWorktreeSetupRequestSchema = z
  .object({
    type: z.literal('local-project/set-worktree-setup'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    config: WorktreeSetupScriptConfigSchema,
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectGetWorktreeCleanupRequestSchema = z
  .object({
    type: z.literal('local-project/get-worktree-cleanup'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectSetWorktreeCleanupRequestSchema = z
  .object({
    type: z.literal('local-project/set-worktree-cleanup'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    config: WorktreeCleanupScriptConfigSchema,
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

const LocalProjectHistoryProviderSchema = z
  .object({
    cliType: AgentConfigCliTypeSchema,
    agentType: z.string().trim().min(1),
  })
  .strict();

export const LocalProjectSyncHistoryRequestSchema = z
  .object({
    type: z.literal('local-project/sync-history'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    provider: LocalProjectHistoryProviderSchema,
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectImportHistoryRequestSchema = z
  .object({
    type: z.literal('local-project/import-history'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    provider: LocalProjectHistoryProviderSchema,
    acpSessionIds: z.array(ACPSessionIdSchema),
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const LocalProjectResolveHistoryConflictRequestSchema = z
  .object({
    type: z.literal('local-project/resolve-history-conflict'),
    machineId: MachineIdSchema,
    workspaceId: WorkspaceIdSchema,
    localProjectId: LocalProjectIdSchema,
    provider: LocalProjectHistoryProviderSchema,
    sessionId: SessionIdSchema,
    acpSessionId: ACPSessionIdSchema,
    requestedByUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const WorktreeListFilesRequestSchema = z
  .object({
    type: z.literal('worktree/list-files'),
    machineId: MachineIdSchema,
    repoFullName: z.string().trim().min(1),
    sessionId: SessionIdSchema,
    maxFiles: z.number().int().positive().optional(),
  })
  .strict();

export const WorktreeReadFileRequestSchema = z
  .object({
    type: z.literal('worktree/read-file'),
    machineId: MachineIdSchema,
    repoFullName: z.string().trim().min(1),
    sessionId: SessionIdSchema,
    relativePath: z.string(),
    maxBytes: z.number().int().positive().optional(),
  })
  .strict();

export const LocalProjectControlRequestSchema = z.discriminatedUnion('type', [
  LocalProjectAddRequestSchema,
  LocalProjectPrepareAddRequestSchema,
  LocalProjectListRootsRequestSchema,
  LocalProjectBrowseDirRequestSchema,
  LocalProjectDeleteRequestSchema,
  LocalProjectRemovalPreflightRequestSchema,
  LocalProjectListRequestSchema,
  LocalProjectGitStateRequestSchema,
  LocalProjectListFilesRequestSchema,
  LocalProjectListDirRequestSchema,
  LocalProjectListSkillsRequestSchema,
  LocalProjectListGlobalSkillsRequestSchema,
  LocalProjectReadFileRequestSchema,
  LocalProjectCheckoutBranchRequestSchema,
  LocalProjectGetWorktreeSetupRequestSchema,
  LocalProjectSetWorktreeSetupRequestSchema,
  LocalProjectGetWorktreeCleanupRequestSchema,
  LocalProjectSetWorktreeCleanupRequestSchema,
  LocalProjectSyncHistoryRequestSchema,
  LocalProjectImportHistoryRequestSchema,
  LocalProjectResolveHistoryConflictRequestSchema,
  WorktreeListFilesRequestSchema,
  WorktreeReadFileRequestSchema,
]);

const LocalProjectFileListResultSchema = z
  .object({
    paths: z.array(z.string()),
    truncated: z.boolean(),
  })
  .strict();

const LocalProjectFileReadResultSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    truncated: z.boolean(),
    encoding: z.enum(['utf8', 'base64']).optional(),
  })
  .strict();

const LocalProjectDirectoryListResultSchema = z
  .object({
    entries: z.array(
      z
        .object({
          name: z.string(),
          type: z.enum(['file', 'directory']),
        })
        .strict()
    ),
    truncated: z.boolean(),
  })
  .strict();

const ProjectSkillSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    author: z.string().optional(),
    relativePath: z.string(),
    absolutePath: z.string().optional(),
    isSymlink: z.boolean(),
    symlinkTarget: z.string().optional(),
    content: z.string().optional(),
  })
  .strict();

const ProjectSkillGroupSchema = z
  .object({
    scope: z.enum(['project', 'global', 'system']),
    dir: z.string(),
    skills: z.array(ProjectSkillSchema),
    truncated: z.boolean(),
    skippedExternalSymlinks: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  })
  .strict();

const ProjectSkillsResultSchema = z
  .object({
    groups: z.array(ProjectSkillGroupSchema),
    contentFingerprint: z.string().optional(),
  })
  .strict();

const LocalProjectBrowseRootsResultSchema = z
  .object({
    platform: z.enum(['darwin', 'linux', 'win32']),
    pathSeparator: z.enum(['/', '\\']),
    homeDir: z.string(),
    drives: z.array(z.string()).optional(),
  })
  .strict();

const LocalProjectBrowseDirectoryResultSchema = z
  .object({
    path: z.string(),
    parentPath: z.string().nullable(),
    entries: z.array(
      z
        .object({
          name: z.string(),
          absolutePath: z.string(),
          isSymlink: z.boolean(),
          hidden: z.boolean(),
          hints: z
            .object({
              git: z.boolean().optional(),
            })
            .strict()
            .optional(),
          registeredProjectId: LocalProjectIdSchema.optional(),
          error: z.literal('unreadable').optional(),
        })
        .strict()
    ),
    truncated: z.boolean(),
    nextCursor: z.string().optional(),
  })
  .strict();

export const LocalProjectGitStateSchema = z.discriminatedUnion('git', [
  z
    .object({
      git: z.literal(true),
      branches: z.array(z.string()),
      currentBranch: z.string().nullable(),
      defaultBranch: z.string().nullable(),
      githubRepoFullName: z.string().nullable(),
      workingTree: z
        .object({
          clean: z.boolean(),
          staged: z.boolean(),
          unstaged: z.boolean(),
          untracked: z.boolean(),
          conflicted: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      git: z.literal(false),
    })
    .strict(),
]);

const LocalProjectCheckoutBranchResultSchema = z.union([
  z
    .object({
      success: z.literal(true),
      currentBranch: z.string(),
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      error: z.string(),
    })
    .strict(),
]);

const LocalProjectHistorySyncSummarySchema = z
  .object({
    listed: z.number().int().nonnegative(),
    imported: z.number().int().nonnegative(),
    refreshed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    conflicted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failures: z.array(
      z
        .object({
          acpSessionId: z.string(),
          message: z.string(),
        })
        .strict()
    ),
  })
  .strict();

const LocalProjectHistoryCatalogItemSchema = z
  .object({
    acpSessionId: z.string(),
    title: z.string(),
    updatedAt: z.string().optional(),
    importedSessionId: z.string().optional(),
    status: z.enum(['available', 'imported', 'sync_conflict']).optional(),
  })
  .strict();

const LocalProjectHistoryCatalogResultSchema = z
  .object({
    listed: z.number().int().nonnegative(),
    lastListedAt: z.number().int().nonnegative(),
    sessions: z.array(LocalProjectHistoryCatalogItemSchema),
  })
  .strict();

const LocalProjectHistoryImportResultSchema = z
  .object({
    summary: LocalProjectHistorySyncSummarySchema,
    catalog: LocalProjectHistoryCatalogResultSchema,
  })
  .strict();

const LocalProjectHistoryConflictResolveResultSchema = z
  .object({
    sessionId: SessionIdSchema,
    acpSessionId: ACPSessionIdSchema,
    status: z.literal('resolved'),
    catalog: LocalProjectHistoryCatalogResultSchema,
  })
  .strict();

const LocalProjectWorktreeCleanupItemSchema = z
  .object({
    sessionId: SessionIdSchema,
    title: z.string(),
    path: z.string(),
  })
  .strict();

const LocalProjectWorktreeCleanupFailureSchema = LocalProjectWorktreeCleanupItemSchema.extend({
  message: z.string(),
}).strict();

const LocalProjectWorktreeCleanupPreflightResultSchema = z
  .object({
    clean: z.array(LocalProjectWorktreeCleanupItemSchema),
    dirty: z.array(LocalProjectWorktreeCleanupItemSchema),
    failed: z.array(LocalProjectWorktreeCleanupFailureSchema),
  })
  .strict();

const LocalProjectControlErrorCodeSchema = z.enum([
  'invalid_request',
  'machine_mismatch',
  'workspace_required',
  'workspace_not_found',
  'daemon_unavailable',
  'access_denied',
  'local_project_not_found',
  'path_invalid',
  'execution_failed',
  'invalid_response',
]);

const LocalProjectControlErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    type: z.enum([
      'local-project/add',
      'local-project/prepare-add',
      'local-project/list-roots',
      'local-project/browse-dir',
      'local-project/delete',
      'local-project/removal-preflight',
      'local-project/list',
      'local-project/git-state',
      'local-project/list-files',
      'local-project/list-dir',
      'local-project/list-skills',
      'local-project/list-global-skills',
      'local-project/read-file',
      'local-project/checkout-branch',
      'local-project/get-worktree-setup',
      'local-project/set-worktree-setup',
      'local-project/get-worktree-cleanup',
      'local-project/set-worktree-cleanup',
      'local-project/sync-history',
      'local-project/import-history',
      'local-project/resolve-history-conflict',
      'worktree/list-files',
      'worktree/read-file',
    ]),
    error: LocalProjectControlErrorCodeSchema,
    message: z.string(),
    data: z.unknown().optional(),
  })
  .strict();

export const LocalProjectControlResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/add'),
      result: z
        .object({
          localProjectId: LocalProjectIdSchema,
          name: z.string(),
          rootPath: z.string(),
          workspaceIds: z.array(WorkspaceIdSchema),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/prepare-add'),
      result: z
        .object({
          localProjectId: LocalProjectIdSchema,
          name: z.string(),
          rootPath: z.string(),
          alreadyRegistered: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/list-roots'),
      result: LocalProjectBrowseRootsResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/browse-dir'),
      result: LocalProjectBrowseDirectoryResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/delete'),
      result: z
        .object({
          localProjectId: LocalProjectIdSchema,
          name: z.string(),
          rootPath: z.string(),
          workspaceIds: z.array(WorkspaceIdSchema),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/removal-preflight'),
      result: LocalProjectWorktreeCleanupPreflightResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/list'),
      result: z
        .object({
          workspaces: z.array(
            z
              .object({
                workspaceId: WorkspaceIdSchema,
                workspaceName: z.string(),
                projects: z.array(
                  z
                    .object({
                      localProjectId: LocalProjectIdSchema,
                      name: z.string(),
                      rootPath: z.string(),
                    })
                    .strict()
                ),
              })
              .strict()
          ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/git-state'),
      result: LocalProjectGitStateSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/list-files'),
      result: LocalProjectFileListResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/list-dir'),
      result: LocalProjectDirectoryListResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/list-skills'),
      result: ProjectSkillsResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/list-global-skills'),
      result: ProjectSkillsResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/read-file'),
      result: LocalProjectFileReadResultSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/checkout-branch'),
      result: LocalProjectCheckoutBranchResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/get-worktree-setup'),
      result: WorktreeSetupScriptConfigSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/set-worktree-setup'),
      result: WorktreeSetupScriptConfigSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/get-worktree-cleanup'),
      result: WorktreeCleanupScriptConfigSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/set-worktree-cleanup'),
      result: WorktreeCleanupScriptConfigSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/sync-history'),
      result: LocalProjectHistoryCatalogResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/import-history'),
      result: LocalProjectHistoryImportResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('local-project/resolve-history-conflict'),
      result: LocalProjectHistoryConflictResolveResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('worktree/list-files'),
      result: LocalProjectFileListResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal('worktree/read-file'),
      result: LocalProjectFileReadResultSchema.nullable(),
    })
    .strict(),
  LocalProjectControlErrorResponseSchema,
]);

export const ClientToServerSchema = z.discriminatedUnion('type', [
  SessionCreateRequestSchema,
  SessionChatRequestSchema,
  SessionCancelRequestSchema,
  PermissionResponseMessageSchema,
  MachineStatusRequestSchema,
  MachinePingRequestSchema,
  MachineRestartRequestSchema,
  MachineUpgradeRequestSchema,
  MachineAcpCapabilitiesRefreshRequestSchema,
  MachineAcpAuthenticateRequestSchema,
  MachineAcpBinaryStatusRequestSchema,
  MachineAcpBinaryInstallRequestSchema,
]);

export const ServerToClientSchema = z.discriminatedUnion('type', [
  SessionCreateResponseSchema,
  SessionCreateAckSchema,
  SessionChatResponseSchema,
  SessionChatAckSchema,
  SessionCancelResponseSchema,
  PermissionRequestMessageSchema,
  MachineStatusResponseSchema,
  MachinePingResponseSchema,
  MachineRestartResponseSchema,
  MachineUpgradeResponseSchema,
  MachineAcpCapabilitiesRefreshResponseSchema,
  MachineAcpAuthenticateResponseSchema,
  MachineAcpAuthenticationProgressMessageSchema,
  MachineAcpBinaryStatusResponseSchema,
  MachineAcpBinaryInstallResponseSchema,
  MachineAcpBinaryProgressMessageSchema,
]);

export const MachineToServerSchema = z.discriminatedUnion('type', [
  PermissionRequestMessageSchema,
  SessionCreateResponseSchema,
  SessionChatResponseSchema,
  SessionCancelResponseSchema,
  MachineStatusResponseSchema,
  MachinePingResponseSchema,
  MachineRestartResponseSchema,
  MachineUpgradeResponseSchema,
  MachineAcpCapabilitiesRefreshResponseSchema,
  MachineAcpAuthenticateResponseSchema,
  MachineAcpAuthenticationProgressMessageSchema,
  MachineAcpBinaryStatusResponseSchema,
  MachineAcpBinaryInstallResponseSchema,
  MachineAcpBinaryProgressMessageSchema,
]);

export const ServerToMachineSchema = z.discriminatedUnion('type', [
  SessionCreateRequestSchema,
  SessionChatRequestSchema,
  SessionCancelRequestSchema,
  PermissionResponseMessageSchema,
  MachineStatusRequestSchema,
  MachinePingRequestSchema,
  MachineRestartRequestSchema,
  MachineUpgradeRequestSchema,
  MachineAcpCapabilitiesRefreshRequestSchema,
  MachineAcpAuthenticateRequestSchema,
  MachineAcpBinaryStatusRequestSchema,
  MachineAcpBinaryInstallRequestSchema,
]);

export const ServerReceiveMessageSchema = z.discriminatedUnion('type', [
  SessionCreateRequestSchema,
  SessionChatRequestSchema,
  SessionCancelRequestSchema,
  PermissionResponseMessageSchema,
  PermissionRequestMessageSchema,
  SessionCreateResponseSchema,
  SessionChatResponseSchema,
  SessionCancelResponseSchema,
  MachineStatusRequestSchema,
  MachineStatusResponseSchema,
  MachinePingRequestSchema,
  MachinePingResponseSchema,
  MachineRestartRequestSchema,
  MachineRestartResponseSchema,
  MachineUpgradeRequestSchema,
  MachineUpgradeResponseSchema,
  MachineAcpCapabilitiesRefreshRequestSchema,
  MachineAcpCapabilitiesRefreshResponseSchema,
  MachineAcpAuthenticateRequestSchema,
  MachineAcpAuthenticateResponseSchema,
  MachineAcpAuthenticationProgressMessageSchema,
  MachineAcpBinaryStatusRequestSchema,
  MachineAcpBinaryStatusResponseSchema,
  MachineAcpBinaryInstallRequestSchema,
  MachineAcpBinaryInstallResponseSchema,
  MachineAcpBinaryProgressMessageSchema,
]);

export const ServerSendMessageSchema = z.discriminatedUnion('type', [
  SessionCreateResponseSchema,
  SessionCreateAckSchema,
  SessionChatResponseSchema,
  SessionChatAckSchema,
  SessionCancelResponseSchema,
  PermissionRequestMessageSchema,
  SessionCreateRequestSchema,
  SessionChatRequestSchema,
  SessionCancelRequestSchema,
  PermissionResponseMessageSchema,
  MachineStatusRequestSchema,
  MachineStatusResponseSchema,
  MachinePingRequestSchema,
  MachinePingResponseSchema,
  MachineRestartRequestSchema,
  MachineRestartResponseSchema,
  MachineUpgradeRequestSchema,
  MachineUpgradeResponseSchema,
  MachineAcpCapabilitiesRefreshRequestSchema,
  MachineAcpCapabilitiesRefreshResponseSchema,
  MachineAcpAuthenticateRequestSchema,
  MachineAcpAuthenticateResponseSchema,
  MachineAcpAuthenticationProgressMessageSchema,
  MachineAcpBinaryStatusRequestSchema,
  MachineAcpBinaryStatusResponseSchema,
  MachineAcpBinaryInstallRequestSchema,
  MachineAcpBinaryInstallResponseSchema,
  MachineAcpBinaryProgressMessageSchema,
]);

// ============================================
// MESSAGE CONTENT SCHEMAS
// ============================================

export const RoleSchema = z.enum(['user', 'assistant', 'system']);

// Match @agentclientprotocol/sdk ToolCallStatus type
export const ToolCallStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);

export const ToolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
  'bash',
  'computer',
  'write',
  'mcp',
]);

export const WorktreeScriptPhaseSchema = z.enum(['setup', 'cleanup']);

export const PlanEntrySchema = z
  .object({
    id: z.string().optional(),
    content: z.string(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
  })
  .loose();

const TerminalExitStatusSchema = z
  .object({
    exitCode: z.number().nullable().optional(),
    signal: z.string().nullable().optional(),
  })
  .loose();

const StandardToolContentSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      text: z.string(),
    })
    .loose(),
  z
    .object({
      type: z.literal('image'),
      data: z.string(),
      mimeType: z.string(),
      uri: z.string().nullable().optional(),
    })
    .loose(),
  z
    .object({
      type: z.literal('audio'),
      data: z.string(),
      mimeType: z.string(),
    })
    .loose(),
  z
    .object({
      type: z.literal('resource_link'),
      uri: z.string(),
      name: z.string(),
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      mimeType: z.string().nullable().optional(),
      size: z.number().nullable().optional(),
    })
    .loose(),
  z
    .object({
      type: z.literal('resource'),
      resource: z.record(z.string(), z.unknown()),
    })
    .loose(),
]);

export const ToolCallContentSchema = z.union([
  // Legacy blocks used by older history entries
  z
    .object({
      type: z.literal('input'),
      input: z.record(z.string(), z.unknown()),
    })
    .loose(),
  z
    .object({
      type: z.literal('output'),
      output: z.unknown(),
    })
    .loose(),
  z
    .object({
      type: z.literal('text'),
      text: z.string(),
    })
    .loose(),
  // ACP blocks
  z
    .object({
      type: z.literal('content'),
      content: StandardToolContentSchema,
    })
    .loose(),
  z
    .object({
      type: z.literal('terminal'),
      terminalId: z.string(),
    })
    .loose(),
  // Stable terminal snapshots stored in history (do not depend on ACP rawOutput structure)
  z
    .object({
      type: z.literal('terminal_command'),
      command: z.string(),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
    })
    .loose(),
  z
    .object({
      type: z.literal('terminal_output'),
      output: z.string(),
      stream: z.enum(['combined', 'stdout', 'stderr']).optional(),
      terminalId: z.string().optional(),
      truncated: z.boolean().optional(),
      exitStatus: TerminalExitStatusSchema.optional(),
    })
    .loose(),
  z
    .object({
      type: z.literal('diff'),
      path: z.string(),
      oldText: z.string().nullable().optional(),
      newText: z.string(),
    })
    .loose(),
]);

export const ToolCallLocationSchema = z.object({
  path: z.string(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
});

export const AvailableCommandSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

export const PermissionRequestInfoSchema = z.object({
  requestId: z.string(),
  options: z.array(PermissionOptionSchema),
  _meta: PermissionMetaSchema.optional(),
  outcome: PermissionOutcomeSchema.optional(),
});

// System notice name schema
export const SystemNoticeNameSchema = z.enum([
  'resume_from_external_chat_history',
  'chat_failed',
  'agent_warning',
]);

// Metadata for resume_from_external_chat_history system notice
export const ResumeFromExternalChatHistoryMetaSchema = z.object({
  truncated: z.boolean().optional(),
  terminalOmitted: z.boolean().optional(),
  thinkingOmitted: z.boolean().optional(),
});

// Metadata for agent_warning system notice: a warning issued by the agent
// runtime (e.g. Codex app-server `warning`/`configWarning` notifications),
// carried structured via ACP session_info_update `_meta` instead of agent text.
export const AgentWarningMetaSchema = z.object({
  message: z.string(),
  source: z.string().optional(),
});

// Who authored a history item; agent-authored content cannot use turn-level userId.
export const MessageItemActorSchema = z.object({
  kind: z.enum(['human', 'agent']),
  agentConfigId: z.string().optional(),
  name: z.string().optional(),
});

// Metadata for the task_proposal system notice
export const TaskProposalMetaSchema = z.object({
  proposalId: z.string().trim().min(1),
  title: z.string(),
  body: z.string().optional(),
  outcome: z.enum(['created', 'dismissed']).optional(),
  taskId: z.string().optional(),
  proposedBy: MessageItemActorSchema.optional(),
});

// Reason codes for chat_failed system notice
export const ChatFailedReasonSchema = z.enum([
  'session_archived',
  'agent_type_mismatch',
  'session_init_failed',
  'session_restore_failed',
  'session_not_found',
  'memory_pressure',
  'acp_not_ready',
  'agent_disconnected',
  'agent_no_output',
  'turn_pre_prompt_failed',
  'message_delivery_failed',
  'machine_access_denied',
  'acp_auth_required',
  'acp_internal_error',
  'acp_upstream_api_error',
  'acp_provider_overloaded',
  'acp_session_storage_incompatible',
  'acp_resource_not_found',
  'acp_request_cancelled',
  'acp_method_not_found',
  'acp_invalid_params',
  'acp_invalid_request',
  'acp_parse_error',
  'acp_unknown_error',
]);

export const ChatFailedCodeSchema = z.enum(['git_executable_not_found']);

// Metadata for chat_failed system notice
export const ChatFailedMetaSchema = z.object({
  reason: ChatFailedReasonSchema,
  code: ChatFailedCodeSchema.optional(),
  message: z.string().optional(),
});

// Non-system notice MessageContent discriminated union
export const NonSystemNoticeMessageContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  SessionImageInputBlockSchema,
  SessionImageGroupContentSchema,
  SessionFileBlockObjectSchema,
  z.object({
    type: z.literal('thought'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('plan'),
    entries: z.array(PlanEntrySchema),
  }),
  z.object({
    type: z.literal('proposed_plan'),
    turnId: z.string(),
    markdown: z.string(),
    status: z.enum(['delta', 'completed', 'cleared']),
    isLatest: z.boolean(),
  }),
  z.object({
    type: z.literal('goal'),
    threadId: z.string(),
    turnId: z.string().nullable().optional(),
    objective: z.string(),
    status: z.enum([
      'active',
      'paused',
      'blocked',
      'usageLimited',
      'budgetLimited',
      'complete',
      'cleared',
    ]),
    tokenBudget: z.number().nullable().optional(),
    tokensUsed: z.number().optional(),
    timeUsedSeconds: z.number().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
  }),
  z.object({
    type: z.literal('tool_call'),
    toolCallId: z.string(),
    title: z.string().nullable().optional(),
    status: ToolCallStatusSchema,
    kind: ToolKindSchema.optional(),
    content: z.array(ToolCallContentSchema).optional(),
    locations: z.array(ToolCallLocationSchema).optional(),
    rawInput: z.record(z.string(), z.unknown()).optional(),
    rawOutput: z.record(z.string(), z.unknown()).optional(),
    activityKind: z.enum(['context_compaction', 'codex_retry']).optional(),
    // Canonical tool name, when the agent published one (ACP `title` is human-facing).
    toolName: z.string().optional(),
    // IANA timezone of the machine that ran a scheduling tool (cron is local-time to it).
    schedulingTimeZone: z.string().optional(),
    // Epoch ms when a scheduling tool call was first persisted (true creation moment;
    // turn-level timestamps are not a safe proxy — see `recordedAtMs` in ai.ts).
    recordedAtMs: z.number().optional(),
    permissionRequest: PermissionRequestInfoSchema.optional(),
  }),
  z.object({
    type: z.literal('available_commands'),
    commands: z.array(AvailableCommandSchema),
  }),
  z.object({
    type: z.literal('operation_completion'),
    deliveryId: z.string().trim().min(1),
    operationId: LodyOperationIdSchema,
    operationKind: z.enum([
      'session_create',
      'session_create_many',
      'session_chat',
      'session_chat_many',
    ]),
    completion: z.unknown(),
    continuation: z
      .object({
        status: z.literal('not_started'),
        reason: z
          .object({
            code: z.literal('CONFIGURATION_UNAVAILABLE'),
            message: z.string(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  }),
]);

// System notice message content schema
export const SystemNoticeSchema = z.discriminatedUnion('name', [
  z.object({
    type: z.literal('system_notice'),
    name: z.literal('resume_from_external_chat_history'),
    meta: ResumeFromExternalChatHistoryMetaSchema.optional(),
  }),
  z.object({
    type: z.literal('system_notice'),
    name: z.literal('chat_failed'),
    meta: ChatFailedMetaSchema.optional(),
  }),
  z.object({
    type: z.literal('system_notice'),
    name: z.literal('agent_warning'),
    meta: AgentWarningMetaSchema.optional(),
  }),
  z.object({
    type: z.literal('system_notice'),
    name: z.literal('task_proposal'),
    meta: TaskProposalMetaSchema.optional(),
  }),
]);

export const WorktreeScriptStepSchema = z.object({
  command: z.string(),
  status: z.enum(['in_progress', 'completed', 'failed']),
  output: z.string(),
  truncated: z.boolean().optional(),
  exitStatus: TerminalExitStatusSchema.optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});

export const WorktreeScriptContentSchema = z.object({
  type: z.literal('worktree_script'),
  phase: WorktreeScriptPhaseSchema,
  status: z.enum(['in_progress', 'completed', 'failed']),
  steps: z.array(WorktreeScriptStepSchema),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});

// MessageContent union
export const MessageContentSchema = z.union([
  NonSystemNoticeMessageContentSchema,
  SystemNoticeSchema,
  WorktreeScriptContentSchema,
]);

export const MessageContentArraySchema = z.array(MessageContentSchema);

// ============================================
// TYPE EXPORTS (inferred from schemas)
// ============================================

// Use original ServerToMachine type for compatibility with branded types
// Zod validates structure at runtime, original types provide compile-time safety
export type MessageContentValidated = z.infer<typeof MessageContentSchema>;
export type MessageContentArrayValidated = z.infer<typeof MessageContentArraySchema>;

// Individual message types - re-export original types from message.ts
// Zod validates at runtime, then we use original types for type safety
import type {
  ClientToServer,
  MachineToServer,
  PermissionRequestMessage,
  PermissionResponseMessage,
  ServerReceiveMessage,
  ServerSendMessage,
  ServerToClient,
  ServerToMachine,
  SessionCancelRequest,
  SessionCancelResponse,
  SessionSteerRequest,
  SessionSteerResponse,
  SessionChatAck,
  SessionChatRequest,
  SessionChatResponse,
  SessionCreateAck,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionImageUploadRequest,
  SessionImageUploadResponse,
  SessionFileUploadRequest,
  SessionFileUploadResponse,
  SessionFileSendLocalRequest,
  SessionFileSendLocalResponse,
  PreviewCandidateReportRequest,
  PreviewCandidateReportResponse,
  SessionPreviewCreateRequest,
  SessionPreviewCreateResponse,
  SessionPreviewRevokeRequest,
  SessionPreviewRevokeResponse,
  MachineStatusRequest,
  MachineStatusResponse,
  MachinePingRequest,
  MachinePingResponse,
  MachineRestartRequest,
  MachineRestartResponse,
  MachineUpgradeRequest,
  MachineUpgradeResponse,
  MachineAcpCapabilitiesRefreshRequest,
  MachineAcpCapabilitiesRefreshResponse,
  MachineAcpAuthenticateRequest,
  MachineAcpAuthenticateResponse,
  MachineAcpAuthenticationProgressMessage,
  MachineAcpBinaryStatusRequest,
  MachineAcpBinaryStatusResponse,
  MachineAcpBinaryInstallRequest,
  MachineAcpBinaryInstallResponse,
  MachineAcpBinaryProgressMessage,
  SessionCodeCollabHostStartRequest,
  SessionCodeCollabHostStartResponse,
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalSessionControlRequest,
  LocalSessionControlResponse,
} from './message';

// Re-export original types for handlers to use after validation
export type {
  SessionCreateRequest as SessionCreateRequestValidated,
  SessionCreateResponse as SessionCreateResponseValidated,
  SessionCreateAck as SessionCreateAckValidated,
  SessionChatRequest as SessionChatRequestValidated,
  SessionChatResponse as SessionChatResponseValidated,
  SessionImageUploadRequest as SessionImageUploadRequestValidated,
  SessionImageUploadResponse as SessionImageUploadResponseValidated,
  SessionFileUploadRequest as SessionFileUploadRequestValidated,
  SessionFileUploadResponse as SessionFileUploadResponseValidated,
  SessionFileSendLocalRequest as SessionFileSendLocalRequestValidated,
  SessionFileSendLocalResponse as SessionFileSendLocalResponseValidated,
  PreviewCandidateReportRequest as PreviewCandidateReportRequestValidated,
  PreviewCandidateReportResponse as PreviewCandidateReportResponseValidated,
  SessionPreviewCreateRequest as SessionPreviewCreateRequestValidated,
  SessionPreviewCreateResponse as SessionPreviewCreateResponseValidated,
  SessionPreviewRevokeRequest as SessionPreviewRevokeRequestValidated,
  SessionPreviewRevokeResponse as SessionPreviewRevokeResponseValidated,
  SessionChatAck as SessionChatAckValidated,
  SessionCancelRequest as SessionCancelRequestValidated,
  SessionCancelResponse as SessionCancelResponseValidated,
  SessionSteerRequest as SessionSteerRequestValidated,
  SessionSteerResponse as SessionSteerResponseValidated,
  PermissionRequestMessage as PermissionRequestMessageValidated,
  PermissionResponseMessage as PermissionResponseMessageValidated,
  MachineStatusRequest as MachineStatusRequestValidated,
  MachineStatusResponse as MachineStatusResponseValidated,
  MachinePingRequest as MachinePingRequestValidated,
  MachinePingResponse as MachinePingResponseValidated,
  MachineRestartRequest as MachineRestartRequestValidated,
  MachineRestartResponse as MachineRestartResponseValidated,
  MachineUpgradeRequest as MachineUpgradeRequestValidated,
  MachineUpgradeResponse as MachineUpgradeResponseValidated,
  MachineAcpCapabilitiesRefreshRequest as MachineAcpCapabilitiesRefreshRequestValidated,
  MachineAcpCapabilitiesRefreshResponse as MachineAcpCapabilitiesRefreshResponseValidated,
  MachineAcpAuthenticateRequest as MachineAcpAuthenticateRequestValidated,
  MachineAcpAuthenticateResponse as MachineAcpAuthenticateResponseValidated,
  MachineAcpAuthenticationProgressMessage as MachineAcpAuthenticationProgressMessageValidated,
  MachineAcpBinaryStatusRequest as MachineAcpBinaryStatusRequestValidated,
  MachineAcpBinaryStatusResponse as MachineAcpBinaryStatusResponseValidated,
  MachineAcpBinaryInstallRequest as MachineAcpBinaryInstallRequestValidated,
  MachineAcpBinaryInstallResponse as MachineAcpBinaryInstallResponseValidated,
  MachineAcpBinaryProgressMessage as MachineAcpBinaryProgressMessageValidated,
  SessionCodeCollabHostStartRequest as SessionCodeCollabHostStartRequestValidated,
  SessionCodeCollabHostStartResponse as SessionCodeCollabHostStartResponseValidated,
};

export type ClientToServerValidated = ClientToServer;
export type MachineToServerValidated = MachineToServer;
export type ServerToClientValidated = ServerToClient;
export type ServerToMachineValidated = ServerToMachine;
export type ServerReceiveMessageValidated = ServerReceiveMessage;
export type ServerSendMessageValidated = ServerSendMessage;
export type LocalSessionControlRequestValidated = LocalSessionControlRequest;
export type LocalSessionControlResponseValidated = LocalSessionControlResponse;
export type LocalProjectControlRequestValidated = LocalProjectControlRequest;
export type LocalProjectControlResponseValidated = LocalProjectControlResponse;

// ============================================
// VALIDATION HELPERS
// ============================================

type UnknownRecord = Record<string, unknown>;
const LEGACY_DEFAULT_BRANCH = 'main';
const LEGACY_BUILTIN_CLI_TYPES: ReadonlySet<string> = new Set(['claude', 'codex']);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function getTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isLegacyBuiltinCliType(value: string | undefined): value is z.infer<typeof CliTypeSchema> {
  return value !== undefined && LEGACY_BUILTIN_CLI_TYPES.has(value);
}

function isAgentConfigCliTypeString(
  value: string | undefined
): value is z.infer<typeof AgentConfigCliTypeSchema> {
  return value === 'builtin' || value === 'registry' || value === 'custom';
}

/**
 * Backward compatibility normalizer for legacy ProjectRef payloads.
 *
 * Why:
 * - Current schemas are strict and reject unknown keys.
 * - Older senders may still send `project.project` as a branch alias.
 *
 * Release policy:
 * - This is temporary and must be removed for the formal release cleanup.
 * - Keep the lifecycle documented in docs/backward-compatibility.md.
 */
function normalizeLegacyProjectRef(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const kind = value.kind;
  if (kind !== 'github' && kind !== 'local') {
    return value;
  }

  const normalized: UnknownRecord = { ...value };
  const legacyProject = normalized.project;

  const existingBranch = getTrimmedString(normalized.branch);
  if (existingBranch) {
    normalized.branch = existingBranch;
  } else {
    const legacyBranchFromString = getTrimmedString(legacyProject);
    const legacyBranchFromObject = isRecord(legacyProject)
      ? (getTrimmedString(legacyProject.branch) ?? getTrimmedString(legacyProject.project))
      : undefined;
    const resolvedBranch = legacyBranchFromString ?? legacyBranchFromObject;
    if (resolvedBranch) {
      normalized.branch = resolvedBranch;
    }
  }

  if (isRecord(legacyProject)) {
    if (kind === 'github' && !getTrimmedString(normalized.repoFullName)) {
      const repoFullName = getTrimmedString(legacyProject.repoFullName);
      if (repoFullName) {
        normalized.repoFullName = repoFullName;
      }
    }
    if (kind === 'local' && !getTrimmedString(normalized.localProjectId)) {
      const localProjectId = getTrimmedString(legacyProject.localProjectId);
      if (localProjectId) {
        normalized.localProjectId = localProjectId;
      }
    }
    if (kind === 'local' && !getTrimmedString(normalized.githubRepoFullName)) {
      const githubRepoFullName = getTrimmedString(legacyProject.githubRepoFullName);
      if (githubRepoFullName) {
        normalized.githubRepoFullName = githubRepoFullName;
      }
    }
    if (kind === 'local' && typeof normalized.useWorktree !== 'boolean') {
      const useWorktree = legacyProject.useWorktree;
      if (typeof useWorktree === 'boolean') {
        normalized.useWorktree = useWorktree;
      }
    }
  }

  if ('project' in normalized) {
    delete normalized.project;
  }

  return normalized;
}

/**
 * Backward compatibility normalizer for legacy session message shapes.
 *
 * Supported legacy inputs:
 * - Nested legacy branch alias: `project.project`
 * - Flat legacy fields: `repoFullName`/`localProjectId` + optional `branch`
 * - Legacy `githubRepo` (+ optional `branch`)
 * - Legacy ACP config: `acpSessionConfig.agentType=claude|codex` (without `cliType`)
 * - Mixed ACP config: `acpSessionConfig.cliType=claude|codex` (without `agentType`)
 *
 * Output:
 * - Canonical strict shape with `project: ProjectRef` and normalized `acpSessionConfig`.
 */
function normalizeLegacySessionProject(message: UnknownRecord): UnknownRecord {
  const normalized: UnknownRecord = { ...message };

  normalized.project = normalizeLegacyProjectRef(normalized.project);

  const currentProject = normalized.project;
  const projectRecord = isRecord(currentProject) ? currentProject : undefined;
  const explicitBranch =
    getTrimmedString(normalized.branch) ??
    getTrimmedString(currentProject) ??
    (projectRecord
      ? (getTrimmedString(projectRecord.branch) ?? getTrimmedString(projectRecord.project))
      : undefined);
  const repoFullName =
    (projectRecord ? getTrimmedString(projectRecord.repoFullName) : undefined) ??
    getTrimmedString(normalized.repoFullName) ??
    getTrimmedString(normalized.githubRepo);
  const localProjectId =
    (projectRecord ? getTrimmedString(projectRecord.localProjectId) : undefined) ??
    getTrimmedString(normalized.localProjectId);
  const localGitHubRepoFullName = projectRecord
    ? getTrimmedString(projectRecord.githubRepoFullName)
    : undefined;
  const localUseWorktree = projectRecord?.useWorktree;
  const branch =
    explicitBranch ??
    // Legacy payloads could carry repo identity but no branch before branch-aware startup.
    (repoFullName ? LEGACY_DEFAULT_BRANCH : undefined);

  if (branch && repoFullName) {
    normalized.project = { kind: 'github', repoFullName, branch };
  } else if (localProjectId) {
    normalized.project = {
      kind: 'local',
      localProjectId,
      ...(branch ? { branch } : {}),
      ...(localGitHubRepoFullName ? { githubRepoFullName: localGitHubRepoFullName } : {}),
      ...(typeof localUseWorktree === 'boolean' ? { useWorktree: localUseWorktree } : {}),
    };
  }

  if ('repoFullName' in normalized) {
    delete normalized.repoFullName;
  }
  if ('localProjectId' in normalized) {
    delete normalized.localProjectId;
  }
  if ('branch' in normalized) {
    delete normalized.branch;
  }
  if ('githubRepo' in normalized) {
    delete normalized.githubRepo;
  }

  return normalized;
}

/**
 * Backward compatibility normalizer for legacy ACP session config shape.
 *
 * Legacy inputs before #1221:
 * - `agentType: 'claude' | 'codex'` (no `cliType`)
 *
 * Transitional mixed inputs (old persisted session meta + new sender):
 * - `cliType: 'claude' | 'codex'` (no `agentType`)
 *
 * Canonical output:
 * - `cliType: 'builtin'`
 * - `agentType: 'claude' | 'codex'`
 */
function normalizeLegacyAcpSessionConfig(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const normalized: UnknownRecord = { ...value };
  delete normalized.chatMode;
  const cliType = getTrimmedString(normalized.cliType);
  const agentType = getTrimmedString(normalized.agentType);

  if (isAgentConfigCliTypeString(cliType) && agentType) {
    normalized.cliType = cliType;
    normalized.agentType = agentType;
    return normalized;
  }

  // Keep invalid non-legacy cliType untouched so schema validation can reject it.
  if (cliType && !isLegacyBuiltinCliType(cliType)) {
    return normalized;
  }

  // Legacy payload before #1221: only `agentType=claude|codex`.
  if (!cliType && isLegacyBuiltinCliType(agentType)) {
    normalized.cliType = 'builtin';
    normalized.agentType = agentType;
    return normalized;
  }

  // Transitional payload from old session meta: `cliType=claude|codex` and missing `agentType`.
  if (isLegacyBuiltinCliType(cliType) && !agentType) {
    normalized.cliType = 'builtin';
    normalized.agentType = cliType;
    return normalized;
  }

  // If both legacy fields exist, prefer `agentType` to align with local-session-control parser.
  if (isLegacyBuiltinCliType(cliType) && isLegacyBuiltinCliType(agentType)) {
    normalized.cliType = 'builtin';
    normalized.agentType = agentType;
    return normalized;
  }

  return normalized;
}

/**
 * Scope guard: normalize legacy shapes only for session/create + session/chat.
 * Other message types remain unchanged.
 */
function normalizeLegacySessionMessage(parsed: unknown): unknown {
  if (!isRecord(parsed)) {
    return parsed;
  }
  const messageType = parsed.type;
  if (messageType === 'session/create' || messageType === 'session/chat') {
    const normalized = normalizeLegacySessionProject(parsed);
    if (!isRecord(normalized)) {
      return normalized;
    }
    normalized.acpSessionConfig = normalizeLegacyAcpSessionConfig(normalized.acpSessionConfig);
    return normalized;
  }
  return parsed;
}

/**
 * Parse and validate a ServerToMachine message from JSON string
 * @throws {z.ZodError} if validation fails
 */
export function parseServerToMachine(data: string): ServerToMachine {
  const parsed: unknown = JSON.parse(data);
  const normalized = normalizeLegacySessionMessage(parsed);
  return ServerToMachineSchema.parse(normalized) as ServerToMachine;
}

/** Result type for safe parsing */
export type SafeParseResult<T> = { success: true; data: T } | { success: false; error: z.ZodError };

/**
 * Safely parse a ServerToMachine message, returning a result object
 */
export function safeParseServerToMachine(data: string): SafeParseResult<ServerToMachine> {
  try {
    const parsed: unknown = JSON.parse(data);
    const normalized = normalizeLegacySessionMessage(parsed);
    const result = ServerToMachineSchema.safeParse(normalized);
    if (result.success) {
      return { success: true, data: result.data as ServerToMachine };
    }
    return { success: false, error: result.error };
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: 'custom',
          message: 'Invalid JSON',
          path: [],
        },
      ]),
    };
  }
}

export function parseLocalSessionControlRequest(data: string): LocalSessionControlRequest {
  const parsed: unknown = JSON.parse(data);
  const normalized = normalizeLegacySessionMessage(parsed);
  return LocalSessionControlRequestSchema.parse(normalized) as LocalSessionControlRequest;
}

export function safeParseLocalSessionControlRequest(
  data: string
): SafeParseResult<LocalSessionControlRequest> {
  try {
    const parsed: unknown = JSON.parse(data);
    const normalized = normalizeLegacySessionMessage(parsed);
    const result = LocalSessionControlRequestSchema.safeParse(normalized);
    if (result.success) {
      return { success: true, data: result.data as LocalSessionControlRequest };
    }
    return { success: false, error: result.error };
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: 'custom',
          message: 'Invalid JSON',
          path: [],
        },
      ]),
    };
  }
}

export function parseLocalProjectControlRequest(data: string): LocalProjectControlRequest {
  const parsed: unknown = JSON.parse(data);
  return LocalProjectControlRequestSchema.parse(parsed) as LocalProjectControlRequest;
}

export function safeParseLocalProjectControlRequest(
  data: string
): SafeParseResult<LocalProjectControlRequest> {
  try {
    const parsed: unknown = JSON.parse(data);
    const result = LocalProjectControlRequestSchema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data as LocalProjectControlRequest };
    }
    return { success: false, error: result.error };
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: 'custom',
          message: 'Invalid JSON',
          path: [],
        },
      ]),
    };
  }
}

export function parseServerToClient(data: string): ServerToClient {
  const parsed: unknown = JSON.parse(data);
  return ServerToClientSchema.parse(parsed) as ServerToClient;
}

export function safeParseServerToClient(data: string): SafeParseResult<ServerToClient> {
  try {
    const parsed: unknown = JSON.parse(data);
    const result = ServerToClientSchema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data as ServerToClient };
    }
    return { success: false, error: result.error };
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: 'custom',
          message: 'Invalid JSON',
          path: [],
        },
      ]),
    };
  }
}

export function parseServerReceiveMessage(data: string): ServerReceiveMessage {
  const parsed: unknown = JSON.parse(data);
  const normalized = normalizeLegacySessionMessage(parsed);
  return ServerReceiveMessageSchema.parse(normalized) as ServerReceiveMessage;
}

export function safeParseServerReceiveMessage(data: string): SafeParseResult<ServerReceiveMessage> {
  try {
    const parsed: unknown = JSON.parse(data);
    const normalized = normalizeLegacySessionMessage(parsed);
    const result = ServerReceiveMessageSchema.safeParse(normalized);
    if (result.success) {
      return { success: true, data: result.data as ServerReceiveMessage };
    }
    return { success: false, error: result.error };
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: 'custom',
          message: 'Invalid JSON',
          path: [],
        },
      ]),
    };
  }
}

/**
 * Parse and validate MessageContent array from JSON string
 * @throws {z.ZodError} if validation fails
 */
export function parseMessageContentArray(data: string): MessageContentArrayValidated {
  const parsed: unknown = JSON.parse(data);
  return MessageContentArraySchema.parse(parsed);
}

/**
 * Safely parse MessageContent array, returning a result object
 */
export function safeParseMessageContentArray(
  data: string
): SafeParseResult<MessageContentArrayValidated> {
  try {
    const parsed: unknown = JSON.parse(data);
    const result = MessageContentArraySchema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error };
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: 'custom',
          message: 'Invalid JSON',
          path: [],
        },
      ]),
    };
  }
}
