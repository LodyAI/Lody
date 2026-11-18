import { z } from 'zod';
import {
  AgentConfigEditSchema,
  MachineCatalogError,
  type MachineCatalogCommand,
} from './machine-catalog';
import { machineFlockKeys, parseMachineFlockRow } from './machine-flock';
import { isManagedBuiltinAgentType } from './ai';
import { CodexAuthProfileSchema } from './codex-auth-profile';
import { MemoryAssociationSchema } from './memory-provider';
import { MAGPIE_TARGETS, normalizeMagpieGateway } from './magpie-import';

export const MACHINE_CATALOG_COMMAND_MAX_BYTES = 64 * 1024;
export const MACHINE_CATALOG_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const id = z.string().min(1).max(512);
const text = z.string().max(32 * 1024);
const path = z.string().min(1).max(4096);
const time = z.number().finite();
const count = z.number().int().nonnegative().safe();
const status = z.enum(['queued', 'preparing-runtime', 'verifying', 'awaiting-auth', 'failed']);
const failure = z.enum(['runtime-unavailable', 'runtime-install-failed', 'verification-failed']);
const launch = z.object({ command: path, args: z.array(text).max(256).optional() }).strict();
const overrides = z
  .object({
    antigravityPath: path.optional(),
    codexPath: path.optional(),
    claudeCodeExecutable: path.optional(),
    kimiPath: path.optional(),
    grokPath: path.optional(),
    devinPath: path.optional(),
    piPath: path.optional(),
    piExtensions: z.array(path).max(32).optional(),
    antigravitySkipPermissions: z.boolean().optional(),
  })
  .strict();
const config = z
  .object({
    id,
    machineId: id,
    name: id,
    description: text.optional(),
    cliType: z.enum(['builtin', 'registry', 'custom']),
    agentType: id,
    env: z.record(id, text),
    prompt: text.optional(),
    customAcp: launch.optional(),
    runtimeOverrides: overrides.optional(),
    magpieGatewayUrl: z.string().max(256).optional(),
    codexAuth: CodexAuthProfileSchema.optional(),
    brandId: id.optional(),
    titleGeneration: z
      .object({ configOptionValues: z.record(id, z.union([text, z.boolean()])).optional() })
      .strict()
      .optional(),
  })
  .strict();
// AgentConfigEditSchema owns changed-field validation. These additional nested
// shapes make its extensible records finite write-only IPC input, never raw rows.
const edits = AgentConfigEditSchema.refine(
  (value) =>
    (value.customAcp?.kind !== 'replace' || launch.safeParse(value.customAcp.value).success) &&
    (value.runtimeOverrides?.kind !== 'replace' ||
      overrides.safeParse(value.runtimeOverrides.value).success)
);
const project = z
  .object({
    id,
    name: id,
    rootPath: path,
    createdAtMs: time,
    lastOpenedAtMs: time.optional(),
    githubRepoFullName: id.optional(),
    standaloneVisible: z.boolean().optional(),
  })
  .strict();
const archive = z
  .object({ v: z.literal(1), requestedAt: time, requestedBy: id.optional() })
  .strict();
const deletion = z
  .object({
    v: z.literal(1),
    requestedAt: time,
    repoFullName: id.optional(),
    branchName: id.optional(),
    baseBranchName: id.optional(),
    localProjectId: id.optional(),
    originalRootPath: path.optional(),
    isWorktree: z.literal(true).optional(),
    keptWorktreePath: path.optional(),
  })
  .strict();
// Completion/status/cleanupResult belongs to the trusted consumer, not a UI intent.
const projectDeletion = z
  .object({
    v: z.literal(1),
    requestedAt: time,
    requestedBy: id.optional(),
    projectName: id.optional(),
    originalRootPath: path.optional(),
    cleanupWorktrees: z.literal(true).optional(),
  })
  .strict();
const cancellation = z.object({ v: z.literal(1), id, machineId: id, cancelledAt: time }).strict();
const queue = z
  .object({
    v: z.literal(1),
    id,
    machineId: id,
    config,
    status: z.literal('queued'),
    attempt: z.number().int().positive().safe(),
    createdAt: time,
    updatedAt: time,
  })
  .strict();
const commands = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('import-magpie'),
      request: z
        .object({
          gatewayUrl: z.string().max(256),
          targets: z.array(z.enum(MAGPIE_TARGETS)).min(1).max(MAGPIE_TARGETS.length),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('create-agent'), config }).strict(),
  z.object({ kind: z.literal('edit-agent'), id, editToken: id, changes: edits }).strict(),
  z.object({ kind: z.literal('remove-agent'), id, editToken: id, now: time }).strict(),
  z.object({ kind: z.literal('set-dot-lody-path'), path }).strict(),
  z.object({ kind: z.literal('clear-dot-lody-path') }).strict(),
  z
    .object({ kind: z.literal('dismiss-local-project-deletion'), projectId: id, completedAt: time })
    .strict(),
  z
    .object({
      kind: z.literal('invalidate-project-history-import'),
      projectId: id,
      provider: z
        .object({
          cliType: z.enum(['builtin', 'registry', 'custom']),
          agentType: id,
          agentConfigId: id.optional(),
        })
        .strict(),
      sourceAcpSessionId: id,
      importedSessionId: id,
    })
    .strict(),
  z.object({ kind: z.literal('remove-session-launch-reference'), sessionId: id }).strict(),
  z.object({ kind: z.literal('save-local-project'), project }).strict(),
  z.object({ kind: z.literal('ensure-local-project'), project }).strict(),
  z
    .object({
      kind: z.literal('edit-local-project'),
      id,
      changes: z
        .object({
          standaloneVisible: z.boolean().optional(),
          githubRepoFullName: z
            .discriminatedUnion('kind', [
              z.object({ kind: z.literal('set'), value: id.regex(/^[\w.-]+\/[\w.-]+$/) }).strict(),
              z.object({ kind: z.literal('clear') }).strict(),
            ])
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('associate-memory'), association: MemoryAssociationSchema }).strict(),
  z.object({ kind: z.literal('link-memory'), association: MemoryAssociationSchema }).strict(),
  z.object({ kind: z.literal('edit-memory'), association: MemoryAssociationSchema }).strict(),
  z.object({ kind: z.literal('remove-memory'), providerId: id, memoryId: id }).strict(),
  z.object({ kind: z.literal('archive-session'), sessionId: id, command: archive }).strict(),
  z.object({ kind: z.literal('delete-session'), sessionId: id, command: deletion }).strict(),
  z
    .object({ kind: z.literal('delete-local-project'), projectId: id, command: projectDeletion })
    .strict(),
  z.object({ kind: z.literal('queue-provider-setup'), task: queue }).strict(),
  z
    .object({
      kind: z.literal('retry-provider-setup'),
      id,
      expected: z.object({ attempt: count, status, updatedAt: time }).strict(),
      now: time,
    })
    .strict(),
  z.object({ kind: z.literal('cancel-provider-setup'), cancellation }).strict(),
  z
    .object({
      kind: z.literal('set-builtin-opt-out'),
      agentType: id.refine(isManagedBuiltinAgentType),
      removedAt: time,
    })
    .strict(),
]);

export class MachineCatalogIpcError extends Error {
  constructor(readonly code: MachineCatalogIpcErrorCode = 'invalid_request') {
    super(`machine_catalog_${code}`);
    this.name = 'MachineCatalogIpcError';
  }
}
function budget(value: unknown, max: number) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded && new TextEncoder().encode(encoded).byteLength <= max) return;
  } catch {
    /* Input diagnostics must never echo write-only credentials. */
  }
  throw new MachineCatalogIpcError();
}
/** targetMachineId comes from the authenticated main registration/selected-room
 * grant. The DTO cannot select account, workspace, room, namespace or storage.
 * Parsing never grants management or substitutes a trusted launch/setup probe. */
export function parseMachineCatalogIpcCommand(
  value: unknown,
  targetMachineId: string
): MachineCatalogCommand {
  budget(value, MACHINE_CATALOG_COMMAND_MAX_BYTES);
  try {
    const result = commands.parse(value) as MachineCatalogCommand;
    const row = (key: Parameters<typeof parseMachineFlockRow>[0], value: unknown) => {
      if (!parseMachineFlockRow(key, value)) throw new MachineCatalogIpcError();
    };
    switch (result.kind) {
      case 'create-agent':
        if (result.config.machineId !== targetMachineId) throw new MachineCatalogIpcError();
        AgentConfigEditSchema.parse({ env: { kind: 'replace', value: result.config.env } });
        row(machineFlockKeys.agentConfig(result.config.id), result.config);
        break;
      case 'queue-provider-setup':
        if (
          result.task.machineId !== targetMachineId ||
          result.task.config.machineId !== targetMachineId
        )
          throw new MachineCatalogIpcError();
        AgentConfigEditSchema.parse({ env: { kind: 'replace', value: result.task.config.env } });
        row(machineFlockKeys.providerSetup(result.task.id), result.task);
        break;
      case 'cancel-provider-setup':
        if (result.cancellation.machineId !== targetMachineId) throw new MachineCatalogIpcError();
        row(
          machineFlockKeys.providerSetupCancellation(result.cancellation.id),
          result.cancellation
        );
        break;
      case 'link-memory':
      case 'edit-memory':
      case 'associate-memory':
        if (result.association.machineId !== targetMachineId) throw new MachineCatalogIpcError();
        row(
          machineFlockKeys.memory(result.association.providerId, result.association.memoryId),
          result.association
        );
        break;
      case 'ensure-local-project':
      case 'save-local-project':
        row(machineFlockKeys.localProject(result.project.id), result.project);
        break;
      case 'archive-session':
        row(machineFlockKeys.archiveSessionCommand(result.sessionId), result.command);
        break;
      case 'delete-session':
        row(machineFlockKeys.deleteSessionCommand(result.sessionId), result.command);
        break;
      case 'delete-local-project':
        row(machineFlockKeys.deleteLocalProjectCommand(result.projectId), result.command);
        break;
      case 'import-magpie':
        if (new Set(result.request.targets).size !== result.request.targets.length)
          throw new MachineCatalogIpcError();
        return {
          kind: 'import-magpie',
          request: {
            gatewayUrl: normalizeMagpieGateway(result.request.gatewayUrl),
            targets: result.request.targets,
          },
        };
    }
    return result;
  } catch {
    throw new MachineCatalogIpcError();
  }
}

export const machineCatalogIpcRequestSchema = z
  .object({
    registrationId: z.string().uuid(),
    requestId: z.string().uuid(),
    machineId: id,
  })
  .strict();
// Stateful calls must name the mounted server generation before any work starts.
// Startup read/observe still use the unextended registration request above.
export const machineCatalogIpcStatefulRequestSchema = machineCatalogIpcRequestSchema
  .extend({ expectedGeneration: id })
  .strict();
export const machineCatalogIpcUploadRequestSchema = machineCatalogIpcStatefulRequestSchema;
export const machineCatalogIpcEditorRequestSchema = machineCatalogIpcStatefulRequestSchema
  .extend({ id })
  .strict();
export const machineCatalogIpcExecuteRequestSchema = machineCatalogIpcStatefulRequestSchema
  .extend({ command: z.unknown() })
  .strict();
export const machineCatalogIpcUnsubscribeSchema = machineCatalogIpcRequestSchema
  .extend({ leaseId: z.string().uuid() })
  .strict();

// Outward parsers deliberately select every field; stored unknown fields and
// launch/task credentials cannot cross even if a trusted source gains fields.
const agentSummary = z.object({
  id,
  machineId: id,
  name: text,
  description: text.optional(),
  cliType: z.enum(['builtin', 'registry', 'custom']),
  agentType: id,
  brandId: id.optional(),
});
const setupSummary = z.object({
  v: z.literal(1).default(1),
  id,
  machineId: id,
  config: agentSummary,
  status,
  attempt: count,
  createdAt: time,
  updatedAt: time,
  failureCode: failure.optional(),
});
const list = <T extends z.ZodType>(schema: T) => z.array(schema).max(4096);
const optionValue = z.union([text, z.boolean()]);
const configOption = z.object({
  id,
  name: text,
  description: text.nullish().transform((value) => value ?? undefined),
  category: id.optional(),
  type: z.enum(['select', 'boolean']),
  currentValue: optionValue,
  options: list(
    z.object({
      value: text,
      name: text,
      description: text.nullish().transform((value) => value ?? undefined),
      group: text.optional(),
    })
  ),
});
const mode = z.object({
  id,
  name: text,
  description: text.nullish().transform((value) => value ?? undefined),
});
const model = z.object({
  modelId: id,
  name: text,
  description: text.nullish().transform((value) => value ?? undefined),
});
export const machineCatalogPublicCapabilitySchema = z.object({
  cliType: z.enum(['builtin', 'registry', 'custom']),
  agentType: id,
  authority: z.enum(['unavailable', 'provisional', 'authoritative', 'degraded']),
  canValidateRolePins: z.boolean(),
  optionCoverage: z.object({ complete: z.boolean(), withheldOptionIds: list(id) }).optional(),
  modes: list(mode),
  models: list(model),
  configOptions: list(configOption).optional(),
  availableCommands: list(
    z.object({ name: id, description: text.nullish().transform((value) => value ?? undefined) })
  ).optional(),
  sessionFork: z.boolean().optional(),
  sessionForkWorktree: z.boolean().optional(),
  sessionTitle: z.boolean().optional(),
  acknowledgedSteer: z.boolean().optional(),
  goalActions: z
    .array(z.enum(['set', 'pause', 'resume', 'clear']))
    .max(4)
    .optional(),
  modelReasoningEfforts: z.record(id, list(id)).optional(),
  declaredModelControls: z
    .record(id, z.object({ effortValues: list(id).optional(), fastMode: z.boolean().optional() }))
    .optional(),
  observedModelConfigOptions: z.record(id, list(configOption)).optional(),
});
export const machineCatalogPublicRateLimitSchema = z.object({
  limitId: id,
  scope: z.object({ providerId: id, modelId: id.optional() }),
  limitName: text.nullish(),
  planName: text.nullish(),
  windows: list(
    z.object({
      label: text.optional(),
      usedPercent: z.number().finite().min(0).max(100),
      windowDurationSeconds: z.number().finite().nullable(),
      resetsAtEpochSeconds: z.number().finite().nullable(),
    })
  ),
  wallet: z
    .object({
      balanceCents: z.number().finite(),
      totalCents: z.number().finite(),
      monthlyChargeLimitEnabled: z.boolean(),
      monthlyChargeLimitCents: z.number().finite(),
      monthlyUsedCents: z.number().finite(),
      currency: id,
    })
    .nullable()
    .optional(),
});
export type MachineCatalogPublicRateLimit = z.infer<typeof machineCatalogPublicRateLimitSchema>;
// sourceVersion is private: runtime-override suffixes can embed saved launch paths.
// The trusted runtime port retains it for cache/CAS checks; IPC exposes IDs only.
export const machineCatalogIpcProjectionSchema = z.object({
  dotlodyPath: path.optional(),
  agents: list(agentSummary),
  projects: list(project.strip()),
  memories: list(MemoryAssociationSchema.strip()),
  acp: list(
    z.object({
      configId: id,
      cliType: id,
      agentType: id,
      fetchedAt: time,
      modes: list(z.object({ id, name: text })),
      models: list(z.object({ modelId: id, name: text })),
      optionIds: list(id),
      sessionFork: z.boolean(),
      sessionTitle: z.boolean(),
      acknowledgedSteer: z.boolean(),
      publicCapability: machineCatalogPublicCapabilitySchema.optional(),
      quotaEligibility: z
        .object({ subscription: z.boolean(), query: z.boolean(), resetForecast: z.boolean() })
        .optional(),
    })
  ),
  modelCapabilities: list(z.object({ configId: id, modelIds: list(id) })),
  modelOptions: list(z.object({ configId: id, modelId: id, shape: text })),
  modelShapes: list(z.object({ configId: id, shapeId: id, optionIds: list(id) })),
  quotas: list(
    z.object({
      configId: id.optional(),
      cliType: id,
      limitId: id,
      used: time.optional(),
      limit: time.optional(),
      remaining: time.optional(),
      resetsAt: time.optional(),
      snapshot: machineCatalogPublicRateLimitSchema.optional(),
    })
  ),
  optOuts: list(z.object({ agentType: id, removedAt: time })),
  providerSetups: list(setupSummary),
  commandCounts: z.object({
    archiveSession: count,
    deleteSession: count,
    deleteLocalProject: count,
    providerCancellation: count,
  }),
  localProjectDeletions: list(
    z.object({ projectId: id, requestedAt: time, completed: z.boolean() })
  ).optional(),
  localProjectDeletionResults: list(
    z.object({
      projectId: id,
      projectName: text.optional(),
      completedAt: time,
      deletedCount: count,
      skippedDirtyCount: count,
      failedCount: count,
    })
  ),
  legacyLaunchCount: count,
});
export type MachineCatalogIpcProjection = z.infer<typeof machineCatalogIpcProjectionSchema>;
export const machineCatalogIpcSnapshotSchema = z.object({
  machineId: id,
  generation: id,
  synced: z.boolean(),
  projection: machineCatalogIpcProjectionSchema,
});
export type MachineCatalogIpcSnapshot = z.infer<typeof machineCatalogIpcSnapshotSchema>;
const editor = agentSummary.extend({
  editToken: id,
  expiresAt: time,
  credentials: z.object({
    envPresent: z.boolean(),
    customLaunchPresent: z.boolean(),
    runtimeOverridesPresent: z.boolean(),
    profilePresent: z.boolean(),
  }),
  hasPrompt: z.boolean(),
  credentialVerification: z.literal('unknown'),
});
export function parseMachineCatalogIpcSnapshot(value: unknown): MachineCatalogIpcSnapshot {
  try {
    const parsed = machineCatalogIpcSnapshotSchema.parse(value);
    if (
      parsed.projection.agents.some((agent) => agent.machineId !== parsed.machineId) ||
      parsed.projection.providerSetups.some(
        (task) =>
          task.machineId !== parsed.machineId ||
          task.config.machineId !== parsed.machineId ||
          task.id !== task.config.id
      ) ||
      parsed.projection.memories.some((memory) => memory.machineId !== parsed.machineId)
    )
      throw new MachineCatalogIpcError();
    budget(parsed, MACHINE_CATALOG_SNAPSHOT_MAX_BYTES);
    return parsed;
  } catch {
    throw new MachineCatalogIpcError('operation_failed');
  }
}
export function parseMachineCatalogIpcEditor(value: unknown) {
  try {
    const parsed = editor.parse(value);
    budget(parsed, MACHINE_CATALOG_COMMAND_MAX_BYTES);
    return parsed;
  } catch {
    throw new MachineCatalogIpcError('operation_failed');
  }
}
export type MachineCatalogIpcEditor = z.infer<typeof editor>;
export type MachineCatalogIpcErrorCode =
  | MachineCatalogError['code']
  | 'invalid_request'
  | 'restart_required'
  | 'cleanup_unconfirmed'
  | 'unavailable';
export const machineCatalogIpcErrorCodeSchema = z.enum([
  'access_denied',
  'edit_conflict',
  'edit_expired',
  'not_found',
  'invalid_edit',
  'verification_required',
  'verification_failed',
  'operation_failed',
  'invalid_request',
  'restart_required',
  'cleanup_unconfirmed',
  'unavailable',
]);
export function machineCatalogIpcErrorCode(error: unknown): MachineCatalogIpcErrorCode {
  if (error instanceof Error && 'code' in error) {
    const parsed = machineCatalogIpcErrorCodeSchema.safeParse(error.code);
    if (parsed.success) return parsed.data;
  }
  return 'operation_failed';
}
export type MachineCatalogIpcEvent = z.infer<typeof machineCatalogIpcUnsubscribeSchema> &
  (
    | { readonly type: 'snapshot'; readonly snapshot: MachineCatalogIpcSnapshot }
    | { readonly type: 'error'; readonly code: MachineCatalogIpcErrorCode }
  );

export const machineCatalogIpcEditorResultSchema = z.object({ generation: id, editor }).strict();
export const machineCatalogIpcCommandResultSchema = z
  .object({
    generation: id,
    changed: z.boolean(),
    association: MemoryAssociationSchema.optional(),
    project: project.optional(),
  })
  .strict();
export const machineCatalogIpcUploadResultSchema = z.object({ generation: id }).strict();
export const machineCatalogIpcCancelResultSchema = z.object({ canceled: z.literal(true) }).strict();
const eventSchema = z.discriminatedUnion('type', [
  machineCatalogIpcUnsubscribeSchema
    .extend({ type: z.literal('snapshot'), snapshot: machineCatalogIpcSnapshotSchema })
    .strict(),
  machineCatalogIpcUnsubscribeSchema
    .extend({ type: z.literal('error'), code: machineCatalogIpcErrorCodeSchema })
    .strict(),
]);
/** Both publishers and receivers use this boundary, then match the exact live
 * registration/request/lease tuple before accepting an event. */
export function parseMachineCatalogIpcEvent(value: unknown): MachineCatalogIpcEvent {
  try {
    const parsed = eventSchema.parse(value);
    if (parsed.type === 'snapshot') {
      if (parsed.machineId !== parsed.snapshot.machineId) throw new MachineCatalogIpcError();
      return { ...parsed, snapshot: parseMachineCatalogIpcSnapshot(parsed.snapshot) };
    }
    return parsed;
  } catch {
    throw new MachineCatalogIpcError('operation_failed');
  }
}
