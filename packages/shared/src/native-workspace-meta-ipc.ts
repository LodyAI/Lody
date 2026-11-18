import { z } from 'zod';
import { SessionProjectRunSchema } from './workspace-project';
const id = z.string().min(1).max(1024);
const text = z.string().max(65536);
const number = z.number().finite();
const optional = <A extends z.ZodType>(schema: A) => schema.optional();
const object = (shape: z.ZodRawShape) => z.object(shape);
const strings = z.array(id);
const line = object({ add: number, del: number, files: number.optional() });
const project = z.discriminatedUnion('kind', [
  object({ kind: z.literal('github'), repoFullName: id, branch: id }),
  object({
    kind: z.literal('local'),
    localProjectId: id,
    branch: id.optional(),
    githubRepoFullName: id.optional(),
    useWorktree: z.boolean().optional(),
  }),
]);
const fields = {
  id,
  machineId: id,
  createdAt: text,
  userId: id,
  title: text,
  titleSource: z.enum(['user', 'generated', 'draft']),
  status: z.discriminatedUnion('type', [
    object({type:z.literal('idle')}),
    object({type:z.literal('running'),activity:z.literal('image_generation').optional(),phase:z.literal('finalizing').optional()}),
    object({type:z.literal('requestPermission')}),
    object({type:z.literal('initializing'),stage:z.enum(['git-clone','managed-runtime','acp','resuming']).optional(),detail:text.optional()}),
  ]),
  cliType: id,
  agentType: id,
  historyBackend: z.enum(['loro', 'roost']),
  origin: z.enum(['lody', 'external-acp']),
  agentConfigId: id,
  agentRoleId: id,
  agentRoleRevision: number,
  scheduleId: id,
  acpSessionId: id,
  openedBySessionId: id,
  openedByRootSessionId: id,
  parentSessionId: id,
  childSessionPlacement: z.literal('side-panel'),
  fromFeedbackPostId: id,
  notificationId: id,
  lastMessageAt: number,
  lastReadAt: number,
  lastRunningSeen: number,
  isArchived: z.boolean(),
  collaborationStopped: z.boolean(),
  isTabClosed: z.boolean(),
  isPinned: z.boolean(),
  isWorktree: z.boolean(),
  workspaceDirty: z.boolean(),
  workspaceUnpushed: z.boolean(),
  repoFullName: text,
  baseBranch: text,
  branchName: text,
  project,
  projectRun: SessionProjectRunSchema,
  lastModel: object({ modelId: text.optional(), name: text.optional() }).nullable(),
  contextWindowUsage: object({ size: number, used: number }),
  diffStats: object({ allChange: line }),
  pullRequests: z.array(
    object({ url: text, status: z.enum(['open', 'closed', 'merged', 'draft']) })
  ),
  pullRequestState: z.record(
    text,
    object({
      s: z.enum(['s', 'f', 'p', 'e', 'x']).optional(),
      m: z.enum(['c', 'b', 'd', 'h', 'u']).optional(),
      r: z.enum(['y', 'n']).optional(),
      t: number,
    })
  ),
  latestUserMsgId: id,
  lastCanceledTurn: id,
  lastHandledUserMsgId: id,
  lastFailedUserMsgId: id,
  processingUserMsgId: id,
  lastMissingHistoryUserMsgId: id,
  settledActivationUserMsgId: id,
  dismissedGoalThreadId: id,
  pinnedHistoryId: id,
  missingHistoryUserMsgIds: z.record(id, z.literal(true)),
  steerTurnStatuses: z.record(
    id,
    z.enum(['pending', 'processing', 'handled', 'failed', 'canceled', 'delivery_unknown'])
  ),
  steerOperationLedger: z.record(
    id,
    object({
      operationId: id,
      userTurnId: id,
      expectedTurnId: id,
      cancellationPolicy: z.enum(['promote', 'preserve']),
      phase: z.enum(['prepared', 'submitted', 'settled']),
      delivery: z.enum(['not_submitted', 'applied', 'not_applied', 'unknown']),
      status: z.enum([
        'pending',
        'processing',
        'handled',
        'failed',
        'canceled',
        'delivery_unknown',
      ]),
      updatedAt: number,
    })
  ),
  queuePromotionLedger: z.record(
    id,
    object({
      queueCid: id,
      userTurnId: id,
      state: z.enum(['prepared', 'history_accepted', 'activation_published', 'queue_consumed']),
      updatedAt: number,
    })
  ),
  previewCandidate: object({ status: id, updatedAt: number }),
  previewConnection: object({ status: id, updatedAt: number }),
  iosSimulatorPreviewRequestId: id,
  androidEmulatorPreviewRequestId: id,
  externalHistory: object({
    provider: id,
    source: z.literal('local-acp-history'),
    sourceAcpSessionId: id,
    sourceUpdatedAt: text.optional(),
    replayDigest: text.optional(),
    hashVersion: number.optional(),
    importedTurnCount: number,
    lastSyncAt: number,
    status: z.enum(['synced', 'sync_conflict', 'metadata_only']).optional(),
    conflictReason: text.optional(),
  }),
  messageQueueUpdatedAt: number,
  messageQueueUpdateVersion: object({
    updatedAt: number,
    frontiers: z.array(
      object({ peer: z.string().regex(/^\d+$/), counter: z.number().int().nonnegative() })
    ),
  }),
  messageQueueCheckedAt: number,
  awaitingUserSince: number,
  autoReview: object({ runId: id, t: number }),
};
const machineFields = {
  id,
  name: text,
  ownerUserId: id,
  hostType: z.enum(['user', 'cloud']),
  cliVersion: text,
  os: text,
  supportRegistryAgentTypes: strings,
  sessions: strings,
  lastSeen: number,
  rpcVersion: text,
  supportsLocalProjectHistoryRpc: z.boolean(),
  protocolCapabilities: z.record(id, z.number().int().nonnegative()),
  timeZone: text,
};
const sessionPatch = z
  .object(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, optional(value)])))
  .strict();
const snapshotSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    docs: z.array(
      z
        .object({ docId: id, deleted: z.boolean(), meta: z.record(z.string(), z.unknown()) })
        .strict()
    ),
    flockDocs: z.array(
      z
        .object({
          flockDocId: id,
          deleted: z.boolean(),
          expiresAtMs: number.nonnegative().optional(),
        })
        .strict()
    ),
  })
  .strict();
export type WorkspaceMetaPublicSnapshot = {
  revision: number;
  docs: { docId: string; deleted: boolean; meta: Record<string, unknown> }[];
  flockDocs: { flockDocId: string; deleted: boolean; expiresAtMs?: number }[];
};
export type WorkspaceMetaScope = { registrationId: string; requestId: string };
export const workspaceMetaScopeSchema = z.object({ registrationId: id, requestId: id }).strict();
export const workspaceMetaStatefulSchema = workspaceMetaScopeSchema
  .extend({ expectedGeneration: id })
  .strict();
export const workspaceMetaCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upsert-doc'), docId: id, patch: sessionPatch }).strict(),
  ...(['ensure-doc', 'delete-doc', 'restore-doc', 'purge-doc'] as const).map((kind) =>
    z.object({ kind: z.literal(kind), docId: id }).strict()
  ),
  z
    .object({
      kind: z.literal('ensure-flock'),
      flockDocId: id,
      expiresAtMs: number.nonnegative().optional(),
    })
    .strict(),
  ...(['delete-flock', 'restore-flock', 'purge-flock'] as const).map((kind) =>
    z.object({ kind: z.literal(kind), flockDocId: id }).strict()
  ),
]);
export type WorkspaceMetaPublicCommand = z.infer<typeof workspaceMetaCommandSchema>;
export const workspaceMetaCommitSchema = workspaceMetaStatefulSchema
  .extend({ command: workspaceMetaCommandSchema })
  .strict();
export const workspaceMetaUnobserveSchema = workspaceMetaScopeSchema
  .extend({ leaseId: id })
  .strict();
export const workspaceMetaErrorCodeSchema = z.enum([
  'invalid_request',
  'access_denied',
  'restart_required',
  'cleanup_unconfirmed',
  'not_committed',
  'operation_failed',
  'unavailable',
]);
export type WorkspaceMetaErrorCode = z.infer<typeof workspaceMetaErrorCodeSchema>;
export class WorkspaceMetaIpcError extends Error {
  constructor(readonly code: WorkspaceMetaErrorCode = 'operation_failed') {
    super(`workspace_meta_${code}`);
    this.name = 'WorkspaceMetaIpcError';
  }
}
export function workspaceMetaErrorCode(error: unknown): WorkspaceMetaErrorCode {
  const parsed = workspaceMetaErrorCodeSchema.safeParse(
    error && typeof error === 'object' && 'code' in error ? error.code : undefined
  );
  return parsed.success ? parsed.data : 'operation_failed';
}
function projectFields(value: unknown, shape: Record<string, z.ZodType>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const candidate = (value as Record<string, unknown>)[key];
    if (candidate === undefined) continue;
    const parsed = schema.safeParse(candidate);
    if (parsed.success) result[key] = parsed.data;
  }
  // PR lifecycle registers have an open identity, but their values are closed.
  if (shape === fields)
    for (const [key, candidate] of Object.entries(value))
      if (key.startsWith('prLifecycle:')) {
        const parsed = object({
          s: z.enum(['open', 'closed', 'merged', 'draft']),
          u: number,
        }).safeParse(candidate);
        if (parsed.success) result[key] = parsed.data;
      }
  return result;
}
/** Allowlist every nesting level. Unknown private fields stay solely in Node. */
export function projectWorkspaceMetaPublicSnapshot(
  value: unknown,
  allowsFlock: (id: string) => boolean
): WorkspaceMetaPublicSnapshot {
  const input = snapshotSchema.parse(value);
  return {
    revision: input.revision,
    docs: input.docs
      .filter((row) => !row.docId.startsWith('agent-'))
      .map((row) => ({
        ...row,
        meta: row.docId.startsWith('session-')
          ? projectFields(row.meta, fields)
          : row.docId.startsWith('machine-')
            ? projectFields(row.meta, machineFields)
            : {},
      })),
    flockDocs: input.flockDocs.filter((row) => allowsFlock(row.flockDocId)),
  };
}
export function parseWorkspaceMetaPublicSnapshot(value: unknown): WorkspaceMetaPublicSnapshot {
  const input = snapshotSchema.parse(value);
  const projected = projectWorkspaceMetaPublicSnapshot(input, () => true);
  // Parsing a response may remove fields, never add permission to a write.
  return projected;
}
export const workspaceMetaEventSchema = workspaceMetaScopeSchema
  .extend({
    generation: id,
    leaseId: id,
    snapshot: snapshotSchema,
    by: z.enum(['local', 'sync', 'live']),
  })
  .strict();
export type WorkspaceMetaEvent = WorkspaceMetaScope & {
  generation: string;
  leaseId: string;
  snapshot: WorkspaceMetaPublicSnapshot;
  by: 'local' | 'sync' | 'live';
};
export function parseWorkspaceMetaEvent(value: unknown): WorkspaceMetaEvent {
  const event = workspaceMetaEventSchema.parse(value);
  return { ...event, snapshot: parseWorkspaceMetaPublicSnapshot(event.snapshot) };
}
