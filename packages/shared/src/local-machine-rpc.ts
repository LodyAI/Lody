import {
  CodeCollabOpenDiffManifestRequestSchema,
  CodeCollabOpenDiffManifestResponseSchema,
  CodeCollabReadBlobRequestSchema,
  CodeCollabReadBlobResponseSchema,
} from './code-collab-diff';
import {
  AndroidEmulatorCommandSchema,
  AndroidEmulatorRequestSchema,
  AndroidEmulatorResponseSchema,
} from './android-emulator';
import { SessionFileRootIdSchema } from './project-path';
import { FileDownloadRequestSchema, FileDownloadResponseSchema } from './file-download';
import { ProjectLocalMemberProbeSchema } from './workspace-project';
import { MemoryProviderRequestSchema, MemoryProviderResponseSchema } from './memory-provider';
import {
  IosSimulatorCommandSchema,
  IosSimulatorRequestSchema,
  IosSimulatorResponseSchema,
} from './ios-simulator';
import { isWorkspaceMcpServerMeta, type WorkspaceMcpServerMeta } from './workspace-mcp';
import { LocalFileResolutionSchema } from './local-file-preview';
import { MachinePiExtensionsResponseSchema } from './pi-extensions';
import { z } from 'zod';
import { RpcSecretEnvelopeSchema, RpcSecretPublicKeySchema } from './rpc-secret';
import { McpAuthenticationResultSchema, McpLocalAuthenticationSchema } from './mcp-authentication';
import { SESSION_GOAL_ACTIONS } from './goal';
import {
  CodeCollabV2ErrorSchema,
  CodeCollabV2FileIndexRequestSchema,
  CodeCollabV2FileIndexSnapshotSchema,
  CodeCollabV2InitDirectoryOkSchema,
  CodeCollabV2InitDirectoryRequestSchema,
  CodeCollabV2LspUnsupportedSchema,
  CodeCollabV2OpenAllChangesDiffRequestSchema,
  CodeCollabV2OpenAllChangesDiffResponseSchema,
  CodeCollabV2OpenCurrentDiffRequestSchema,
  CodeCollabV2OpenCurrentDiffResponseSchema,
  CodeCollabV2OpenTextOkSchema,
  CodeCollabV2OpenTextRequestSchema,
  CodeCollabV2OpenTurnDiffRequestSchema,
  CodeCollabV2OpenTurnDiffResponseSchema,
  CodeCollabV2RefreshTextRequestSchema,
  CodeCollabV2RefreshTextResponseSchema,
  CodeCollabV2SaveTextRequestSchema,
  CodeCollabV2SaveTextResponseSchema,
} from './code-collab';
import { FilePreviewV3RequestSchema, FilePreviewV3ResponseSchema } from './file-preview';
import {
  MachineStatusResponseSchema,
  MachinePingResponseSchema,
  MachineAcpBinaryStatusResponseSchema,
  SessionCancelResponseSchema,
  SessionDispatchTurnResponseSchema,
  SessionEditAndResendResponseSchema,
  SessionEditAndResendSpecSchema,
  SessionForkResponseSchema,
  SessionForkSpecSchema,
  SessionIdSchema,
  AgentConfigIdSchema,
  SessionPreparationCancelSpecSchema,
  SessionPreparationSpecSchema,
  SessionPrepareCancelResponseSchema,
  SessionPrepareResponseSchema,
  SessionPreviewEndpointAcquireResponseSchema,
  SessionPreviewCreateRequestSchema,
  SessionPreviewCreateResponseSchema,
  SessionPreviewRevokeRequestSchema,
  SessionPreviewRevokeResponseSchema,
  SessionPreviewStatusRequestSchema,
  SessionPreviewStatusResponseSchema,
  SessionPreviewEndpointReleaseResponseSchema,
  PreviewTargetSchema,
  SessionSteerResponseSchema,
  SessionGoalResponseSchema,
  SessionTerminateResponseSchema,
} from './message-schemas';

export const LOCAL_MACHINE_RPC_PATH = '/machine-rpc';

const BaseLocalMachineRpcRequestSchema = z
  .object({
    machineId: z.string().trim().min(1),
    workspaceId: z.string().trim().min(1),
    ownerSessionId: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const SessionActiveInvocationContextResultSchema = z.discriminatedUnion('active', [
  z
    .object({
      type: z.literal('session/active-invocation-context'),
      sessionId: SessionIdSchema,
      active: z.literal(false),
    })
    .strict(),
  z
    .object({
      type: z.literal('session/active-invocation-context'),
      sessionId: SessionIdSchema,
      active: z.literal(true),
      requesterUserId: z.string().trim().min(1),
      sourceTurnId: z.string().trim().min(1),
      inputConfig: z.record(z.string(), z.unknown()),
      notificationOriginTurnIds: z.array(z.string().min(1)).optional(),
      notificationProvenancePending: z.boolean().optional(),
      // Daemon-hosted tools use the frozen sender without rereading input history.
      // The legacy socket handler omits this field for older strict readers.
      sender: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('user') }).strict(),
          z.object({ kind: z.literal('agent'), sessionId: SessionIdSchema }).strict(),
        ])
        .optional(),
    })
    .strict(),
]);
export type SessionActiveInvocationContextResult = z.infer<
  typeof SessionActiveInvocationContextResultSchema
>;

export const McpToolListResultSchema = z
  .object({
    type: z.literal('mcp/tools'),
    tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
  })
  .strict();
export type McpToolListResult = z.infer<typeof McpToolListResultSchema>;

export const SessionToolResultSchema = z
  .object({
    type: z.literal('session/tool-result'),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()),
    isError: z.boolean().optional(),
  })
  .strict();

export const SorbetProviderIdSchema = z.string().min(1).max(1024);
export const SorbetCredentialTypeSchema = z.string().min(1).max(1024);
export const SORBET_CREDENTIALS_MAX_COUNT = 1000;
const SorbetCredentialSchema = z
  .object({
    providerId: SorbetProviderIdSchema,
    type: SorbetCredentialTypeSchema,
  })
  .strict();
export const SorbetCredentialsResultSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('sorbet/credentials-list'),
      credentials: z.array(SorbetCredentialSchema).max(SORBET_CREDENTIALS_MAX_COUNT),
    })
    .strict(),
  z.object({ type: z.literal('sorbet/credentials-logout') }).strict(),
]);

export type SorbetCredentialsResult = z.infer<typeof SorbetCredentialsResultSchema>;

/**
 * A custom Provider Sorbet hosts on the Client's behalf. Its identity, protocol and model
 * list can come from Lody; Sorbet assigns and owns `id` and can discover models.
 */
export const SorbetCustomProviderProtocolSchema = z.enum([
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
]);
export const SORBET_CUSTOM_PROVIDER_MODELS_MAX_COUNT = 200;
const SorbetCustomProviderModelSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const SorbetCustomProviderInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    protocol: SorbetCustomProviderProtocolSchema,
    baseUrl: z.string().trim().min(1).max(2048),
    models: z.array(SorbetCustomProviderModelSchema).max(SORBET_CUSTOM_PROVIDER_MODELS_MAX_COUNT),
  })
  .strict();
export const SorbetCustomProviderSchema = SorbetCustomProviderInputSchema.extend({
  id: SorbetProviderIdSchema,
}).strict();

export const SorbetProvidersResultSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('sorbet/providers-list'),
      providers: z.array(SorbetCustomProviderSchema).max(SORBET_CREDENTIALS_MAX_COUNT),
    })
    .strict(),
  z
    .object({ type: z.literal('sorbet/providers-create'), provider: SorbetCustomProviderSchema })
    .strict(),
  z.object({ type: z.literal('sorbet/providers-delete') }).strict(),
]);

export type SorbetCustomProviderInput = z.infer<typeof SorbetCustomProviderInputSchema>;
export type SorbetCustomProvider = z.infer<typeof SorbetCustomProviderSchema>;
export type SorbetProvidersResult = z.infer<typeof SorbetProvidersResultSchema>;

export const E2eeAcpInteractionParamsSchema = z.union([
  z
    .object({
      action: z.literal('start'),
      kind: z.literal('probe'),
      configId: AgentConfigIdSchema,
      force: z.boolean().optional(),
      responseKey: RpcSecretPublicKeySchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('start'),
      kind: z.literal('authenticate'),
      configId: AgentConfigIdSchema,
      methodId: z.string().trim().min(1).max(1024).optional(),
      responseKey: RpcSecretPublicKeySchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('activate'),
      interactionRequestId: z.string().regex(/^[0-9a-f]{32}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal('poll'),
      interactionRequestId: z.string().regex(/^[0-9a-f]{32}$/),
      progressAck: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('submit'),
      interactionRequestId: z.string().regex(/^[0-9a-f]{32}$/),
      interactionId: z.string().trim().min(1).max(1024),
      inputEnvelope: RpcSecretEnvelopeSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('cancel'),
      interactionRequestId: z.string().regex(/^[0-9a-f]{32}$/),
    })
    .strict(),
]);

export const E2eeAcpInteractionResultSchema = z
  .object({
    type: z.literal('machine/acp-interaction'),
    interactionRequestId: z.string().regex(/^[0-9a-f]{32}$/),
    state: z.enum(['running', 'completed', 'cancelled', 'expired']),
    inputPublicKey: RpcSecretPublicKeySchema.optional(),
    responseEnvelope: RpcSecretEnvelopeSchema.optional(),
  })
  .strict();

export const LocalMachineRpcRequestSchema = z.discriminatedUnion('method', [
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('machine/acp-interaction'),
    params: E2eeAcpInteractionParamsSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('sorbet/credentials-list'),
    params: z.object({ configId: AgentConfigIdSchema }).strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('sorbet/credentials-logout'),
    params: z
      .object({ configId: AgentConfigIdSchema, providerId: SorbetProviderIdSchema })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('sorbet/providers-list'),
    params: z.object({ configId: AgentConfigIdSchema }).strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('sorbet/providers-create'),
    params: z
      .object({ configId: AgentConfigIdSchema, provider: SorbetCustomProviderInputSchema })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('sorbet/providers-delete'),
    params: z
      .object({ configId: AgentConfigIdSchema, providerId: SorbetProviderIdSchema })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('machine/status'),
    params: z.object({ includeDisk: z.literal(true).optional() }).strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('machine/ping'),
    params: z.object({ requestId: z.string().trim().min(1) }).strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('machine/acp-binary-status'),
    params: z.object({ agentType: z.string().trim().min(1) }).strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/live-status'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
        includeActivity: z.literal(true).optional(),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('file/download-chunk'),
    params: FileDownloadRequestSchema,
  }).strict(),

  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('project/probe-local-member'),
    params: z.object({ localProjectId: z.string().trim().min(1) }).strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('ios-simulator/agent-control'),
    params: z.object({ sessionId: SessionIdSchema, command: IosSimulatorCommandSchema }).strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('ios-simulator/control'),
    params: IosSimulatorRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('android-emulator/agent-control'),
    params: z
      .object({ sessionId: SessionIdSchema, command: AndroidEmulatorCommandSchema })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('android-emulator/control'),
    params: AndroidEmulatorRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('mcp/list-tools'),
    params: z
      .object({
        server: z.custom<WorkspaceMcpServerMeta>(isWorkspaceMcpServerMeta),
        requesterUserId: z.string().min(1).optional(),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('mcp/authentication'),
    params: z
      .object({
        server: z.custom<WorkspaceMcpServerMeta>(isWorkspaceMcpServerMeta),
        requesterUserId: z.string().min(1),
        action: z.enum(['status', 'configure', 'authorize', 'cancel', 'signout']),
        authentication: McpLocalAuthenticationSchema.optional(),
        attemptId: z.string().max(128).optional(),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/call-tool'),
    params: z
      .object({
        sessionId: SessionIdSchema,
        name: z.string().min(1).max(100),
        arguments: z
          .record(z.string(), z.json())
          .refine(
            (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024,
            'Session tool arguments exceed 256 KiB'
          ),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/get-active-invocation-context'),
    params: z
      .object({
        sessionId: SessionIdSchema,
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/get-file-index'),
    params: CodeCollabV2FileIndexRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/open-text'),
    params: CodeCollabV2OpenTextRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/refresh-text'),
    params: CodeCollabV2RefreshTextRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/save-text'),
    params: CodeCollabV2SaveTextRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/open-diff-manifest'),
    params: CodeCollabOpenDiffManifestRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/read-blob'),
    params: CodeCollabReadBlobRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/open-current-diff'),
    params: CodeCollabV2OpenCurrentDiffRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/open-all-changes-diff'),
    params: CodeCollabV2OpenAllChangesDiffRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/open-turn-diff'),
    params: CodeCollabV2OpenTurnDiffRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/init-directory'),
    params: CodeCollabV2InitDirectoryRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/lsp-definition'),
    params: z
      .object({
        rootId: SessionFileRootIdSchema.optional(),
        sessionId: z.string().trim().min(1),
        path: z.string().min(1),
        line: z.number().int().nonnegative().optional(),
        character: z.number().int().nonnegative().optional(),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/lsp-references'),
    params: z
      .object({
        rootId: SessionFileRootIdSchema.optional(),
        sessionId: z.string().trim().min(1),
        path: z.string().min(1),
        line: z.number().int().nonnegative().optional(),
        character: z.number().int().nonnegative().optional(),
      })
      .strict(),
  }).strict(),
  // File Preview v3 over the same-machine IPC path. Params travel in the clear
  // here because the socket never leaves the machine.
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('file/preview'),
    params: FilePreviewV3RequestSchema,
  }).strict(),
  // Electron's same-machine preview route. This method deliberately has no
  // Loro Streams counterpart: the desktop user may inspect any local file,
  // while remote requests retain File Preview v3's restricted-root policy.
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('file/resolve-local'),
    params: FilePreviewV3RequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/cancel'),
    params: z
      .object({
        sessionId: SessionIdSchema,
        turnId: z.string().trim().min(1),
        cancelId: z.string().uuid().optional(),
        pauseInbox: z.boolean().optional(),
        subagentTaskId: z.string().trim().min(1).optional(),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/fork'),
    params: SessionForkSpecSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/edit-and-resend'),
    params: SessionEditAndResendSpecSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/dispatch-turn'),
    params: z
      .object({
        sessionId: SessionIdSchema,
        userTurnId: z.string().trim().min(1),
        userId: z.string().trim().min(1),
        timestamp: z.string().trim().min(1),
        inputOrigin: z.enum(['human', 'agent']).optional(),
        // Opaque at the transport layer; the CLI normalizes it with
        // `normalizeSessionTurnInputConfig` before offering the turn, the same
        // guard the Loro Streams Machine RPC server applies.
        inputConfig: z.record(z.string(), z.unknown()),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/prepare'),
    params: SessionPreparationSpecSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/prepare-cancel'),
    params: SessionPreparationCancelSpecSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/steer'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
        expectedTurnId: z.string().trim().min(1),
        userTurnId: z.string().trim().min(1),
        userId: z.string().trim().min(1),
        timestamp: z.string().trim().min(1),
        inputConfig: z.record(z.string(), z.unknown()),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/goal'),
    params: z
      .object({
        sessionId: SessionIdSchema,
        action: z.enum(SESSION_GOAL_ACTIONS),
        objective: z.string().trim().min(1).optional(),
        userId: z.string().trim().min(1),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/preview-create'),
    params: SessionPreviewCreateRequestSchema.omit({
      type: true,
      machineId: true,
      workspaceId: true,
    }),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/preview-revoke'),
    params: SessionPreviewRevokeRequestSchema.omit({
      type: true,
      machineId: true,
      workspaceId: true,
    }),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/preview-status'),
    params: SessionPreviewStatusRequestSchema.omit({
      type: true,
      machineId: true,
      workspaceId: true,
    }),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/preview-endpoint-acquire'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
        requestedByUserId: z.string().trim().min(1),
        target: PreviewTargetSchema,
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/preview-endpoint-release'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
        endpointId: z.string().trim().min(1),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/terminate'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('machine/memory'),
    params: MemoryProviderRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('machine/pi-extensions'),
    params: z
      .object({
        configId: AgentConfigIdSchema.optional(),
      })
      .strict(),
  }).strict(),
]);

export type LocalMachineRpcRequest = z.infer<typeof LocalMachineRpcRequestSchema>;
export type LocalMachineRpcRequestValidated = LocalMachineRpcRequest;

export const ProjectProbeLocalMemberResultSchema = ProjectLocalMemberProbeSchema.extend({
  type: z.literal('project/probe-local-member'),
}).strict();

export type ProjectProbeLocalMemberResult = z.infer<typeof ProjectProbeLocalMemberResultSchema>;

const SessionLiveStateSchema = z.enum(['idle', 'initializing', 'running', 'waiting', 'unknown']);

/**
 * What a busy Session is doing, read on demand by its owning daemon and never
 * published on presence. Sent only when the request asked with `includeActivity`.
 */
export const SessionLiveActivitySchema = z
  .object({
    turnStartedAt: z.number().finite().nonnegative().optional(),
    lastOutputAt: z.number().finite().nonnegative().optional(),
    currentAction: z.string().max(200).optional(),
    queuedInputs: z.number().int().nonnegative(),
  })
  .strict();
export type SessionLiveActivity = z.infer<typeof SessionLiveActivitySchema>;

/**
 * Best-effort withdrawal of a queued input that has not started. `withdrawn`
 * means the input was still pending and is now canceled; a dispatch racing the
 * withdrawal may still run it, which callers observe in the target history.
 */
export const SessionWithdrawInputResponseSchema = z
  .object({
    type: z.literal('session/withdraw-input_response'),
    sessionId: z.string().trim().min(1),
    userTurnId: z.string().trim().min(1),
    outcome: z.enum([
      'withdrawn',
      'already_withdrawn',
      'already_started',
      'not_found',
      'not_owner',
      'error',
    ]),
    error: z.string().optional(),
  })
  .strict();
export type SessionWithdrawInputResponse = z.infer<typeof SessionWithdrawInputResponseSchema>;

export const SessionLiveStatusResponseSchema = z.discriminatedUnion('success', [
  z
    .object({
      type: z.literal('session/live-status_response'),
      machineId: z.string().trim().min(1),
      sessionId: z.string().trim().min(1),
      success: z.literal(true),
      state: SessionLiveStateSchema,
      observedAtMs: z.number().finite().nonnegative(),
      reason: z.string().trim().min(1).optional(),
      activity: SessionLiveActivitySchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session/live-status_response'),
      machineId: z.string().trim().min(1),
      sessionId: z.string().trim().min(1),
      success: z.literal(false),
      state: z.literal('unknown'),
      error: z.string().trim().min(1),
    })
    .strict(),
]);

export const LocalMachineRpcResultSchema = z.union([
  E2eeAcpInteractionResultSchema,
  SorbetProvidersResultSchema,
  MachineStatusResponseSchema,
  MachinePingResponseSchema,
  MachineAcpBinaryStatusResponseSchema,
  SessionLiveStatusResponseSchema,
  FileDownloadResponseSchema,
  ProjectProbeLocalMemberResultSchema,
  MemoryProviderResponseSchema,
  IosSimulatorResponseSchema,
  AndroidEmulatorResponseSchema,
  McpToolListResultSchema,
  McpAuthenticationResultSchema,
  SorbetCredentialsResultSchema,
  SessionToolResultSchema,
  SessionActiveInvocationContextResultSchema,
  CodeCollabV2FileIndexSnapshotSchema,
  CodeCollabV2OpenTextOkSchema,
  CodeCollabV2RefreshTextResponseSchema,
  CodeCollabV2SaveTextResponseSchema,
  CodeCollabOpenDiffManifestResponseSchema,
  CodeCollabReadBlobResponseSchema,
  CodeCollabV2OpenCurrentDiffResponseSchema,
  CodeCollabV2OpenAllChangesDiffResponseSchema,
  CodeCollabV2OpenTurnDiffResponseSchema,
  CodeCollabV2InitDirectoryOkSchema,
  CodeCollabV2LspUnsupportedSchema,
  CodeCollabV2ErrorSchema,
  FilePreviewV3ResponseSchema,
  LocalFileResolutionSchema,
  SessionCancelResponseSchema,
  SessionDispatchTurnResponseSchema,
  SessionEditAndResendResponseSchema,
  SessionForkResponseSchema,
  SessionPrepareResponseSchema,
  SessionPrepareCancelResponseSchema,
  SessionPreviewEndpointAcquireResponseSchema,
  SessionPreviewEndpointReleaseResponseSchema,
  SessionSteerResponseSchema,
  SessionPreviewCreateResponseSchema,
  SessionPreviewRevokeResponseSchema,
  SessionPreviewStatusResponseSchema,
  SessionGoalResponseSchema,
  SessionTerminateResponseSchema,
  MachinePiExtensionsResponseSchema,
]);
export type SorbetCredentialsListRequest = Extract<
  LocalMachineRpcRequest,
  { method: 'sorbet/credentials-list' }
>;
export type SorbetCredentialsLogoutRequest = Extract<
  LocalMachineRpcRequest,
  { method: 'sorbet/credentials-logout' }
>;
export type SorbetCredentialsListResult = Extract<
  SorbetCredentialsResult,
  { type: 'sorbet/credentials-list' }
>;
export type SorbetCredentialsLogoutResult = Extract<
  SorbetCredentialsResult,
  { type: 'sorbet/credentials-logout' }
>;

export type LocalMachineRpcResult = z.infer<typeof LocalMachineRpcResultSchema>;

export const LocalMachineRpcResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      result: LocalMachineRpcResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().trim().min(1),
      code: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/)
        .optional(),
      data: z.unknown().optional(),
    })
    .strict(),
]);
export type LocalMachineRpcResponse = z.infer<typeof LocalMachineRpcResponseSchema>;

export function safeParseLocalMachineRpcRequest(
  raw: string
):
  | { readonly success: true; readonly data: LocalMachineRpcRequestValidated }
  | { readonly success: false; readonly error: z.ZodError } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = LocalMachineRpcRequestSchema.safeParse(parsed);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return { success: true, data: result.data };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof z.ZodError
          ? error
          : new z.ZodError([
              {
                code: z.ZodIssueCode.custom,
                path: [],
                message: 'Invalid JSON',
              },
            ]),
    };
  }
}

export { FilePreviewV3ErrorSchema } from './file-preview';
