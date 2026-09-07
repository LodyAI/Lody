import { z } from 'zod';
import {
  StreamsClient,
  type HeadStreamOutput,
  type StreamError,
  type StreamPart,
  type TimeoutConfig,
} from '@loro-dev/streams-client';
import type {
  AgentConfigId,
  CodeCollabV2Error,
  CodeCollabV2InitDirectoryOk,
  CodeCollabV2InitDirectoryRequest,
  CodeCollabV2LspUnsupported,
  CodeCollabV2OpenAllChangesDiffRequest,
  CodeCollabV2OpenAllChangesDiffResponse,
  CodeCollabV2OpenCurrentDiffRequest,
  CodeCollabV2OpenCurrentDiffResponse,
  CodeCollabV2OpenTextOk,
  CodeCollabV2OpenTextRequest,
  CodeCollabV2OpenTurnDiffRequest,
  CodeCollabV2OpenTurnDiffResponse,
  CodeCollabV2RefreshTextRequest,
  CodeCollabV2RefreshTextResponse,
  CodeCollabV2RpcResponse,
  CodeCollabV2RpcContentEnvelope,
  CodeCollabV2SaveTextRequest,
  CodeCollabV2SaveTextResponse,
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalProjectId,
  MachineAcpBinaryInstallResponse,
  MachineAcpBinaryProgressMessage,
  MachineAcpBinaryStatusResponse,
  MachineAcpAuthenticateResponse,
  MachineAcpAuthenticationProgressMessage,
  MachineAcpCapabilitiesRefreshResponse,
  RpcSecretEnvelope,
  RpcSecretPublicKey,
  PreviewTarget,
  PreviewTargetApproval,
  MachineBugReportResponse,
  MachinePingResponse,
  MachineRestartResponse,
  MachineStatusResponse,
  MachineUpgradeResponse,
  SessionCancelResponse,
  SessionPreparationCancelSpec,
  SessionPreparationSpec,
  SessionPrepareCancelResponse,
  SessionPrepareResponse,
  SessionTerminateResponse,
  SessionDispatchTurnResponse,
  SessionEditAndResendResponse,
  SessionEditAndResendSpec,
  SessionForkResponse,
  SessionForkSpec,
  SessionId,
  SessionSteerResponse,
  SessionPreviewCreateResponse,
  SessionPreviewRevokeResponse,
  SessionTurnInputConfig,
  FilePreviewV3Request,
  FilePreviewV3Response,
} from '@lody/shared';
import {
  AgentConfigIdSchema,
  CodeCollabV2ErrorCodeSchema,
  CodeCollabV2ErrorSchema,
  CodeCollabV2RpcContentEnvelopeSchema,
  CodeCollabV2RpcResponseSchema,
  FILE_PREVIEW_PROTOCOL_VERSION,
  FilePreviewV3ErrorCodeSchema,
  FilePreviewV3ErrorSchema,
  FilePreviewV3ResponseSchema,
  deriveCodeCollabV2ContentKeyBytes,
  deriveCodeCollabV2ContentKeyId,
  LocalProjectControlRequestSchema,
  LocalProjectControlResponseSchema,
  LocalProjectGitStateSchema,
  MachineAcpBinaryInstallResponseSchema,
  MachineAcpBinaryProgressMessageSchema,
  MachineAcpBinaryStatusResponseSchema,
  MachineAcpAuthenticateResponseSchema,
  MachineAcpAuthenticationProgressMessageSchema,
  MachineAcpCapabilitiesRefreshResponseSchema,
  RpcSecretEnvelopeSchema,
  PreviewTargetSchema,
  MachineBugReportResponseSchema,
  MachinePingResponseSchema,
  MachineRestartResponseSchema,
  MachineStatusResponseSchema,
  MachineUpgradeResponseSchema,
  SessionCancelResponseSchema,
  SessionPreparationCancelSpecSchema,
  SessionPreparationSpecSchema,
  SessionPrepareCancelResponseSchema,
  SessionPrepareResponseSchema,
  SessionTerminateResponseSchema,
  SessionDispatchTurnResponseSchema,
  SessionEditAndResendResponseSchema,
  SessionEditAndResendSpecSchema,
  SessionForkResponseSchema,
  SessionForkSpecSchema,
  SessionIdSchema,
  sessionEditAndResendFailure,
  sessionForkFailure,
  SessionSteerResponseSchema,
  SessionPreviewCreateResponseSchema,
  SessionPreviewRevokeResponseSchema,
} from '@lody/shared';
import {
  encryptRpcSecret,
  getMachineAcpAuthenticationInputSecretContext,
  getMachineAcpAuthorizationCodeSecretContext,
} from './rpc-secret';
import type {
  LoroStreamsLiveModeDiagnostics,
  LoroStreamsLiveRequestMode,
  LoroStreamsLiveTransport,
} from './live-mode-policy';
import { LoroStreamsLiveModePolicy } from './live-mode-policy';

const JSON_RPC_VERSION = '2.0';
export const LORO_STREAMS_RPC_VERSION = '1';
export const LORO_STREAMS_RPC_RETENTION_SECONDS = 86400;

// Default idle watchdog for live reads. The Streams protocol has servers close
// live connections roughly every ~60s (for CDN collapsing) and always emit an
// `up_to_date` control event on connect, so a healthy live read is never silent
// for this long. Firing here means the connection stalled; we reconnect. See
// `liveIdleTimeoutMs` on `createLoroStreamsJsonStreamClient`.
export const DEFAULT_LIVE_IDLE_TIMEOUT_MS = 120_000;

// Wire-protocol error codes shared between server and clients. Treat as a
// stable contract: clients pattern-match `code` to render localized messages
// and decide retry behavior, so changes here ripple to every consumer.
export const LORO_STREAMS_RPC_ERROR_CODES = {
  rpcVersionMismatch: 'rpc_version_mismatch',
  methodUnavailable: 'method_unavailable',
  internalError: 'internal_error',
} as const;
export type LoroStreamsRpcErrorCode =
  (typeof LORO_STREAMS_RPC_ERROR_CODES)[keyof typeof LORO_STREAMS_RPC_ERROR_CODES];

export const LORO_RPC_REQUEST_STREAM_SEGMENT = 'rpc:req';
export const LORO_RPC_RESPONSE_STREAM_SEGMENT = 'rpc:res';

export const getLoroMachineRpcRequestStreamId = (workspaceId: string, machineId: string): string =>
  `${workspaceId}:${LORO_RPC_REQUEST_STREAM_SEGMENT}:${machineId}`;

export const getLoroMachineRpcResponseStreamId = (workspaceId: string, machineId: string): string =>
  `${workspaceId}:${LORO_RPC_RESPONSE_STREAM_SEGMENT}:${machineId}`;

export const getLoroWorkspaceRpcResponseStreamId = (workspaceId: string): string =>
  `${workspaceId}:${LORO_RPC_RESPONSE_STREAM_SEGMENT}`;

export const normalizeLoroGatewayBaseUrl = (baseUrl?: string | null): string => {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    throw new Error('Loro Streams gateway base URL must be provided by the platform adapter');
  }
  return trimmed.replace(/\/+$/g, '');
};

export const LoroStreamsRpcMethodSchema = z.enum([
  'machine/status',
  'machine/ping',
  'machine/restart',
  'machine/upgrade',
  'machine/acp-capabilities-refresh',
  'machine/acp-capabilities-refresh-cancel',
  'machine/acp-authenticate',
  'machine/acp-binary-status',
  'machine/acp-binary-install',
  'machine/bug-report',
  'code-collab/open-text',
  'code-collab/refresh-text',
  'code-collab/save-text',
  'code-collab/open-current-diff',
  'code-collab/open-all-changes-diff',
  'code-collab/open-turn-diff',
  'code-collab/init-directory',
  'code-collab/lsp-definition',
  'code-collab/lsp-references',
  // File Preview v3. Deliberately outside the `code-collab/` namespace: it is a
  // plain read and must never activate Code Collab on the machine.
  'file/preview',
  'session/cancel',
  'session/live-status',
  'session/steer',
  'session/terminate',
  'session/fork',
  'session/edit-and-resend',
  'session/dispatch-turn',
  'session/prepare',
  'session/prepare-cancel',
  'session/preview-create',
  'session/preview-revoke',
  'local-project/git-state',
  'local-project/control',
]);

export type LoroStreamsRpcMethod = z.infer<typeof LoroStreamsRpcMethodSchema>;
type RpcAgentConfigCliType = MachineAcpCapabilitiesRefreshResponse['cliType'];

export const LoroStreamsRpcErrorSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    data: z.unknown().optional(),
  })
  .strict();

const BaseRpcRequestSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: z.string().trim().min(1),
    method: LoroStreamsRpcMethodSchema,
    rpcVersion: z.string().trim().min(1),
    machineId: z.string().trim().min(1),
    workspaceId: z.string().trim().min(1),
    replyTo: z.string().trim().min(1),
    sentAt: z.number().finite().nonnegative(),
    expiresAt: z.number().finite().positive(),
  })
  .strict();

export const LoroMachineStatusRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('machine/status'),
  params: z.object({}).strict(),
}).strict();

export const LoroMachinePingRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('machine/ping'),
  params: z
    .object({
      requestId: z.string().trim().min(1),
    })
    .strict(),
}).strict();

export const LoroMachineRestartRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('machine/restart'),
  params: z
    .object({
      requesterUserId: z.string().trim().min(1),
      requestToken: z.string().trim().min(1),
      requestId: z.string().trim().min(1),
    })
    .strict(),
}).strict();

export const LoroMachineUpgradeRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('machine/upgrade'),
  params: z
    .object({
      requesterUserId: z.string().trim().min(1),
      requestToken: z.string().trim().min(1),
      requestId: z.string().trim().min(1),
      targetVersion: z.string().trim().min(1).optional(),
    })
    .strict(),
}).strict();

export const LoroMachineAcpCapabilitiesRefreshRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('machine/acp-capabilities-refresh'),
  params: z
    .object({
      configId: AgentConfigIdSchema,
    })
    .strict(),
}).strict();

export const LoroMachineAcpCapabilitiesRefreshCancelRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('machine/acp-capabilities-refresh-cancel'),
  params: z
    .object({
      requestId: z.string().trim().min(1),
    })
    .strict(),
}).strict();

export const LoroMachineAcpAuthenticateRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('machine/acp-authenticate'),
  params: z.discriminatedUnion('action', [
    z
      .object({
        requestId: z.string().trim().min(1).max(1024),
        action: z.literal('start'),
        configId: AgentConfigIdSchema,
      })
      .strict(),
    z
      .object({
        requestId: z.string().trim().min(1).max(1024),
        action: z.literal('cancel'),
        authenticationRequestId: z.string().trim().min(1).max(1024),
      })
      .strict(),
    z
      .object({
        requestId: z.string().trim().min(1).max(1024),
        action: z.literal('submit-code'),
        authenticationRequestId: z.string().trim().min(1).max(1024),
        authorizationCodeEnvelope: RpcSecretEnvelopeSchema,
      })
      .strict(),
    z
      .object({
        requestId: z.string().trim().min(1).max(1024),
        action: z.literal('submit-input'),
        authenticationRequestId: z.string().trim().min(1).max(1024),
        interactionId: z.string().trim().min(1).max(1024),
        authenticationInputEnvelope: RpcSecretEnvelopeSchema,
      })
      .strict(),
  ]),
}).strict();

export const LoroMachineAcpBinaryStatusRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('machine/acp-binary-status'),
  params: z
    .object({
      agentType: z.string().trim().min(1),
    })
    .strict(),
}).strict();

export const LoroMachineAcpBinaryInstallRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('machine/acp-binary-install'),
  params: z
    .object({
      agentType: z.string().trim().min(1),
    })
    .strict(),
}).strict();

export const LoroMachineBugReportRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('machine/bug-report'),
  params: z
    .object({
      description: z.string().trim().min(1),
      reporterUserId: z.string().trim().min(1),
      requestToken: z.string().trim().min(1),
    })
    .strict(),
}).strict();

export const LoroCodeCollabV2OpenTextRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('code-collab/open-text'),
  params: CodeCollabV2RpcContentEnvelopeSchema,
}).strict();

export const LoroCodeCollabV2RefreshTextRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('code-collab/refresh-text'),
  params: CodeCollabV2RpcContentEnvelopeSchema,
}).strict();

export const LoroCodeCollabV2SaveTextRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('code-collab/save-text'),
  params: CodeCollabV2RpcContentEnvelopeSchema,
}).strict();

export const LoroCodeCollabV2OpenCurrentDiffRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('code-collab/open-current-diff'),
  params: CodeCollabV2RpcContentEnvelopeSchema,
}).strict();

export const LoroCodeCollabV2OpenAllChangesDiffRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('code-collab/open-all-changes-diff'),
  params: CodeCollabV2RpcContentEnvelopeSchema,
}).strict();

export const LoroCodeCollabV2OpenTurnDiffRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('code-collab/open-turn-diff'),
  params: CodeCollabV2RpcContentEnvelopeSchema,
}).strict();

export const LoroCodeCollabV2InitDirectoryRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('code-collab/init-directory'),
  params: CodeCollabV2RpcContentEnvelopeSchema,
}).strict();

export const CodeCollabV2LspRpcParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    path: z.string().min(1),
    line: z.number().int().nonnegative().optional(),
    character: z.number().int().nonnegative().optional(),
  })
  .strict();

export const LoroCodeCollabV2LspDefinitionRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('code-collab/lsp-definition'),
  params: CodeCollabV2RpcContentEnvelopeSchema,
}).strict();

export const LoroCodeCollabV2LspReferencesRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('code-collab/lsp-references'),
  params: CodeCollabV2RpcContentEnvelopeSchema,
}).strict();

/**
 * File Preview v3 reuses the owner-session-scoped encrypted content envelope: the
 * requested path and returned bytes are user content and must not sit in the
 * clear on the Streams plane, and the envelope's owner binding is what the
 * machine authorizes against. The envelope is transport, not Code Collab state.
 */
export const LoroFilePreviewRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('file/preview'),
  params: CodeCollabV2RpcContentEnvelopeSchema,
}).strict();

/**
 * Methods whose params/results travel inside the encrypted owner-session
 * envelope. Every encrypt, decrypt, and error-decode site must consult this —
 * the previous `method.startsWith('code-collab/')` checks silently excluded any
 * new method that reuses the envelope.
 */
export const isOwnerScopedEncryptedRpcMethod = (method: string): boolean =>
  method.startsWith('code-collab/') || method === 'file/preview';

export const LoroSessionCancelRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('session/cancel'),
  params: z
    .object({
      sessionId: SessionIdSchema,
      turnId: z.string().trim().min(1),
    })
    .strict(),
}).strict();

export const LoroSessionLiveStatusRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('session/live-status'),
  params: z
    .object({
      sessionId: z.string().trim().min(1),
    })
    .strict(),
}).strict();

export const LoroSessionSteerRpcRequestSchema = BaseRpcRequestSchema.extend({
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
}).strict();

export const LoroSessionTerminateRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('session/terminate'),
  params: z
    .object({
      sessionId: z.string().trim().min(1),
    })
    .strict(),
}).strict();

export const LoroSessionForkRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('session/fork'),
  params: SessionForkSpecSchema,
}).strict();

export const LoroSessionEditAndResendRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('session/edit-and-resend'),
  params: SessionEditAndResendSpecSchema,
}).strict();

/**
 * Fast-path dispatch of a user turn: carries the full turn input so the
 * machine can start executing before the session-doc history CRDT syncs.
 * The session doc remains the durable source of truth; this request is an
 * accelerator and must stay idempotent by `userTurnId`. Callers keep the
 * timeout (== expiresAt window) short so a machine restart does not replay
 * stale dispatches from the request stream.
 */
export const LoroSessionDispatchTurnRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('session/dispatch-turn'),
  params: z
    .object({
      sessionId: SessionIdSchema,
      userTurnId: z.string().trim().min(1),
      userId: z.string().trim().min(1),
      timestamp: z.string().trim().min(1),
      // Opaque at the transport layer; the server normalizes it with
      // `normalizeSessionTurnInputConfig` before handing it to the CLI, the
      // same guard used for turn input configs read from CRDT history.
      inputConfig: z.record(z.string(), z.unknown()),
    })
    .strict(),
}).strict();

export const LoroSessionPrepareRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('session/prepare'),
  params: SessionPreparationSpecSchema,
}).strict();

export const LoroSessionPrepareCancelRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('session/prepare-cancel'),
  params: SessionPreparationCancelSpecSchema,
}).strict();

export const LoroSessionPreviewCreateRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('session/preview-create'),
  params: z
    .object({
      sessionId: z.string().trim().min(1),
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
    .strict(),
}).strict();

export const LoroSessionPreviewRevokeRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('session/preview-revoke'),
  params: z
    .object({
      sessionId: z.string().trim().min(1),
      requestedByUserId: z.string().trim().min(1),
      reason: z.string().trim().min(1).optional(),
    })
    .strict(),
}).strict();

export const LoroLocalProjectGitStateRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('local-project/git-state'),
  params: z
    .object({
      localProjectId: z.string().trim().min(1),
      requestedByUserId: z.string().trim().min(1),
    })
    .strict(),
}).strict();

export const LoroLocalProjectControlRpcRequestSchema = BaseRpcRequestSchema.extend({
  method: z.literal('local-project/control'),
  params: z
    .object({
      request: LocalProjectControlRequestSchema,
    })
    .strict(),
}).strict();

export const LoroStreamsRpcRequestSchema = z.discriminatedUnion('method', [
  LoroMachineStatusRpcRequestSchema,
  LoroMachinePingRpcRequestSchema,
  LoroMachineRestartRpcRequestSchema,
  LoroMachineUpgradeRpcRequestSchema,
  LoroMachineAcpCapabilitiesRefreshRpcRequestSchema,
  LoroMachineAcpCapabilitiesRefreshCancelRpcRequestSchema,
  LoroMachineAcpAuthenticateRpcRequestSchema,
  LoroMachineAcpBinaryStatusRpcRequestSchema,
  LoroMachineAcpBinaryInstallRpcRequestSchema,
  LoroMachineBugReportRpcRequestSchema,
  LoroCodeCollabV2OpenTextRpcRequestSchema,
  LoroCodeCollabV2RefreshTextRpcRequestSchema,
  LoroCodeCollabV2SaveTextRpcRequestSchema,
  LoroCodeCollabV2OpenCurrentDiffRpcRequestSchema,
  LoroCodeCollabV2OpenAllChangesDiffRpcRequestSchema,
  LoroCodeCollabV2OpenTurnDiffRpcRequestSchema,
  LoroCodeCollabV2InitDirectoryRpcRequestSchema,
  LoroCodeCollabV2LspDefinitionRpcRequestSchema,
  LoroCodeCollabV2LspReferencesRpcRequestSchema,
  LoroFilePreviewRpcRequestSchema,
  LoroSessionCancelRpcRequestSchema,
  LoroSessionLiveStatusRpcRequestSchema,
  LoroSessionSteerRpcRequestSchema,
  LoroSessionTerminateRpcRequestSchema,
  LoroSessionForkRpcRequestSchema,
  LoroSessionEditAndResendRpcRequestSchema,
  LoroSessionDispatchTurnRpcRequestSchema,
  LoroSessionPrepareRpcRequestSchema,
  LoroSessionPrepareCancelRpcRequestSchema,
  LoroSessionPreviewCreateRpcRequestSchema,
  LoroSessionPreviewRevokeRpcRequestSchema,
  LoroLocalProjectGitStateRpcRequestSchema,
  LoroLocalProjectControlRpcRequestSchema,
]);

const SessionLiveStateSchema = z.enum(['idle', 'initializing', 'running', 'waiting', 'unknown']);

export const LoroSessionLiveStatusRpcResponseSchema = z.discriminatedUnion('success', [
  z
    .object({
      type: z.literal('session/live-status_response'),
      machineId: z.string().trim().min(1),
      sessionId: z.string().trim().min(1),
      success: z.literal(true),
      state: SessionLiveStateSchema,
      observedAtMs: z.number().finite().nonnegative(),
      reason: z.string().trim().min(1).optional(),
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

export const LoroLocalProjectGitStateRpcResponseSchema = z.discriminatedUnion('success', [
  z
    .object({
      type: z.literal('local-project/git-state_response'),
      machineId: z.string().trim().min(1),
      workspaceId: z.string().trim().min(1),
      localProjectId: z.string().trim().min(1),
      success: z.literal(true),
      state: LocalProjectGitStateSchema,
      observedAtMs: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('local-project/git-state_response'),
      machineId: z.string().trim().min(1),
      workspaceId: z.string().trim().min(1),
      localProjectId: z.string().trim().min(1),
      success: z.literal(false),
      error: z.string().trim().min(1),
      message: z.string().trim().min(1).optional(),
    })
    .strict(),
]);

const BaseRpcResponseSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: z.string().trim().min(1),
    method: LoroStreamsRpcMethodSchema,
    rpcVersion: z.string().trim().min(1),
    machineId: z.string().trim().min(1),
    result: z.unknown().optional(),
    error: LoroStreamsRpcErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasResult = value.result !== undefined;
    const hasError = value.error !== undefined;
    if (hasResult === hasError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RPC response must contain exactly one of result or error',
      });
    }
  });

export const LoroStreamsRpcResponseSchema = BaseRpcResponseSchema;

export type LoroMachineStatusRpcRequest = z.infer<typeof LoroMachineStatusRpcRequestSchema>;
export type LoroMachinePingRpcRequest = z.infer<typeof LoroMachinePingRpcRequestSchema>;
export type LoroMachineRestartRpcRequest = z.infer<typeof LoroMachineRestartRpcRequestSchema>;
export type LoroMachineUpgradeRpcRequest = z.infer<typeof LoroMachineUpgradeRpcRequestSchema>;
export type LoroMachineAcpCapabilitiesRefreshRpcRequest = z.infer<
  typeof LoroMachineAcpCapabilitiesRefreshRpcRequestSchema
>;
export type LoroMachineAcpCapabilitiesRefreshCancelRpcRequest = z.infer<
  typeof LoroMachineAcpCapabilitiesRefreshCancelRpcRequestSchema
>;
export type LoroMachineAcpAuthenticateRpcRequest = z.infer<
  typeof LoroMachineAcpAuthenticateRpcRequestSchema
>;
export type LoroMachineAcpBinaryStatusRpcRequest = z.infer<
  typeof LoroMachineAcpBinaryStatusRpcRequestSchema
>;
export type LoroMachineAcpBinaryInstallRpcRequest = z.infer<
  typeof LoroMachineAcpBinaryInstallRpcRequestSchema
>;
export type LoroMachineBugReportRpcRequest = z.infer<typeof LoroMachineBugReportRpcRequestSchema>;
export type LoroCodeCollabV2OpenTextRpcRequest = z.infer<
  typeof LoroCodeCollabV2OpenTextRpcRequestSchema
>;
export type LoroCodeCollabV2RefreshTextRpcRequest = z.infer<
  typeof LoroCodeCollabV2RefreshTextRpcRequestSchema
>;
export type LoroCodeCollabV2SaveTextRpcRequest = z.infer<
  typeof LoroCodeCollabV2SaveTextRpcRequestSchema
>;
export type LoroCodeCollabV2OpenCurrentDiffRpcRequest = z.infer<
  typeof LoroCodeCollabV2OpenCurrentDiffRpcRequestSchema
>;
export type LoroCodeCollabV2OpenTurnDiffRpcRequest = z.infer<
  typeof LoroCodeCollabV2OpenTurnDiffRpcRequestSchema
>;
export type LoroCodeCollabV2InitDirectoryRpcRequest = z.infer<
  typeof LoroCodeCollabV2InitDirectoryRpcRequestSchema
>;
export type CodeCollabV2LspRpcParams = z.infer<typeof CodeCollabV2LspRpcParamsSchema>;
export type LoroCodeCollabV2LspDefinitionRpcRequest = z.infer<
  typeof LoroCodeCollabV2LspDefinitionRpcRequestSchema
>;
export type LoroCodeCollabV2LspReferencesRpcRequest = z.infer<
  typeof LoroCodeCollabV2LspReferencesRpcRequestSchema
>;
export type LoroFilePreviewRpcRequest = z.infer<typeof LoroFilePreviewRpcRequestSchema>;
export type LoroSessionCancelRpcRequest = z.infer<typeof LoroSessionCancelRpcRequestSchema>;
export type LoroSessionLiveStatusRpcRequest = z.infer<typeof LoroSessionLiveStatusRpcRequestSchema>;
export type LoroSessionTerminateRpcRequest = z.infer<typeof LoroSessionTerminateRpcRequestSchema>;
export type LoroSessionForkRpcRequest = z.infer<typeof LoroSessionForkRpcRequestSchema>;
export type LoroSessionEditAndResendRpcRequest = z.infer<
  typeof LoroSessionEditAndResendRpcRequestSchema
>;
export type LoroSessionPrepareRpcRequest = z.infer<typeof LoroSessionPrepareRpcRequestSchema>;
export type LoroSessionPrepareCancelRpcRequest = z.infer<
  typeof LoroSessionPrepareCancelRpcRequestSchema
>;
export type LoroSessionPreviewCreateRpcRequest = z.infer<
  typeof LoroSessionPreviewCreateRpcRequestSchema
>;
export type LoroSessionPreviewRevokeRpcRequest = z.infer<
  typeof LoroSessionPreviewRevokeRpcRequestSchema
>;
export type LoroLocalProjectGitStateRpcRequest = z.infer<
  typeof LoroLocalProjectGitStateRpcRequestSchema
>;
export type LoroLocalProjectControlRpcRequest = z.infer<
  typeof LoroLocalProjectControlRpcRequestSchema
>;
export type LoroStreamsRpcRequest = z.infer<typeof LoroStreamsRpcRequestSchema>;
export type LoroStreamsRpcError = z.infer<typeof LoroStreamsRpcErrorSchema>;
export type LoroStreamsRpcResponse = z.infer<typeof LoroStreamsRpcResponseSchema>;
export type LoroSessionLiveStatusRpcResponse = z.infer<
  typeof LoroSessionLiveStatusRpcResponseSchema
>;
export type LocalProjectGitStateRpcResponse = z.infer<
  typeof LoroLocalProjectGitStateRpcResponseSchema
>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const JSON_STREAM_CONTENT_TYPE = 'application/json';

export class LoroStreamsGatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'LoroStreamsGatewayError';
  }
}

export type LoroJsonStreamState = {
  nextOffset?: string;
  cursor?: string;
};

export type LoroJsonStreamBatch = {
  messages: unknown[];
  nextOffset?: string;
  cursor?: string;
  upToDate: boolean;
};

export type LoroJsonLiveBatchHandler = (batch: LoroJsonStreamBatch) => Promise<void> | void;

export type LoroJsonLiveReadOptions = {
  signal?: AbortSignal;
  /**
   * SSE-first transport policy for this live stream. When provided it picks the
   * mode for each read and is told the outcome, so a broken SSE connection
   * falls back to long-poll instead of ending the read loop with an error. See
   * `live-mode-policy.ts`.
   */
  modePolicy?: LoroStreamsLiveModePolicy;
};

export type LoroStreamsJsonStreamClient = {
  ensureJsonStream: (streamId: string, retentionSeconds?: number) => Promise<void>;
  appendJson: (streamId: string, value: unknown) => Promise<string | undefined>;
  readJsonLive: (
    streamId: string,
    state: LoroJsonStreamState,
    onBatch: LoroJsonLiveBatchHandler,
    options?: LoroJsonLiveReadOptions
  ) => Promise<void>;
};

type JsonStreamOperation = 'ensure' | 'append' | 'live';
type JsonStreamLiveMode = LoroStreamsLiveRequestMode;

type StreamErrorContext = {
  operation: string;
  method: string;
  url: string;
};

type JsonStreamClientBinding = {
  client: StreamsClient;
  context: StreamErrorContext;
};

const getStreamErrorField = (error: StreamError, field: string): unknown =>
  (error as Record<string, unknown>)[field];

const redactUrlForError = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
};

const formatStreamErrorContext = (
  context: StreamErrorContext | undefined,
  error: StreamError
): string => {
  const parts: string[] = [];
  if (context) {
    parts.push(
      `operation=${context.operation}`,
      `method=${context.method}`,
      `url=${redactUrlForError(context.url)}`
    );
  }

  const code = getStreamErrorField(error, 'code');
  if (typeof code === 'string' && code.length > 0) {
    parts.push(`code=${code}`);
  }

  const phase = getStreamErrorField(error, 'phase');
  if (typeof phase === 'string' && phase.length > 0) {
    parts.push(`phase=${phase}`);
  }

  const timeoutMs = getStreamErrorField(error, 'timeoutMs');
  if (typeof timeoutMs === 'number') {
    parts.push(`timeoutMs=${timeoutMs}`);
  }

  const status = getStreamErrorField(error, 'status');
  if (typeof status === 'number') {
    parts.push(`status=${status}`);
  }

  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
};

const toLoroGatewayError = (
  action: string,
  streamId: string,
  error: StreamError,
  context?: StreamErrorContext
): LoroStreamsGatewayError | Error => {
  const contextSuffix = formatStreamErrorContext(context, error);
  if ('status' in error && typeof error.status === 'number') {
    const detail = 'detail' in error && typeof error.detail === 'string' ? error.detail : undefined;
    return new LoroStreamsGatewayError(
      `Failed to ${action} ${streamId}${contextSuffix}: ${error.message}`,
      error.status,
      detail
    );
  }

  return new Error(`Failed to ${action} ${streamId}${contextSuffix}: ${error.message}`);
};

const unwrapStreamResult = <T>(
  action: string,
  streamId: string,
  result:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly result: StreamError },
  context?: StreamErrorContext
): T => {
  if (result.ok) {
    return result.result;
  }

  throw toLoroGatewayError(action, streamId, result.result, context);
};

const parseJsonPayload = (payload: StreamPart, streamId: string, context: string): unknown => {
  try {
    return payload.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON payload for ${streamId} during ${context}: ${message}`, {
      cause: error,
    });
  }
};

const parseJsonLivePayload = (
  payload: StreamPart,
  streamId: string,
  context: string
): unknown[] => {
  const parsed = parseJsonPayload(payload, streamId, context);
  return Array.isArray(parsed) ? parsed : [parsed];
};

const normalizeRetentionSeconds = (retentionSeconds?: number): number | undefined => {
  if (typeof retentionSeconds !== 'number' || retentionSeconds <= 0) {
    return undefined;
  }

  return Math.trunc(retentionSeconds);
};

const isCompatibleExistingJsonStream = (
  stream: HeadStreamOutput,
  requestedTtlSeconds?: number
): boolean => {
  if (stream.contentType !== JSON_STREAM_CONTENT_TYPE || stream.closed) {
    return false;
  }

  if (requestedTtlSeconds === undefined) {
    return stream.ttlSeconds === undefined && stream.expiresAt === undefined;
  }

  if (stream.ttlSeconds === requestedTtlSeconds) {
    return true;
  }

  // Older machine RPC streams were created without retention metadata.
  return stream.ttlSeconds === undefined && stream.expiresAt === undefined;
};

export function createLoroStreamsJsonStreamClient(options: {
  bucketId: string;
  getToken: () => Promise<string>;
  getBaseUrl?: () => string | undefined;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  liveMode?: JsonStreamLiveMode;
  /**
   * Idle watchdog for live reads. The underlying streams client (0.5.0) applies
   * `connectTimeoutMs` only to the initial SSE fetch — once the `text/event-stream`
   * body is open there is NO read timeout, so a server that holds the connection
   * open but sends nothing (silent stall) hangs the read forever. When a live read
   * yields no event (data / up_to_date / reconnect) for this many ms we abort the
   * current iteration; the caller's read loop then reconnects from the saved offset.
   * A protocol-compliant server closes ~every 60s and sends `up_to_date` on connect,
   * so the default leaves >=2x margin and never fires on a healthy connection.
   * Pass `0` to disable. Defaults to {@link DEFAULT_LIVE_IDLE_TIMEOUT_MS}.
   */
  liveIdleTimeoutMs?: number;
  timeout?: Partial<TimeoutConfig>;
  shardUrls?: {
    readonly bootstrap?: readonly string[];
    readonly catchup?: readonly string[];
    readonly largePost?: readonly string[];
    readonly other?: readonly string[];
  };
}): LoroStreamsJsonStreamClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  const getStreamUrl = (streamId: string, operation: JsonStreamOperation = 'ensure'): string => {
    const baseUrl = normalizeLoroGatewayBaseUrl(options.getBaseUrl?.() ?? options.baseUrl);
    const operationBaseUrl = selectJsonStreamOperationBaseUrl(
      baseUrl,
      streamId,
      operation,
      options.shardUrls
    );
    return new URL(
      `${operationBaseUrl}/ds/${encodeURIComponent(options.bucketId)}/${encodeURIComponent(streamId)}`
    ).toString();
  };

  const getStreamClient = (
    streamId: string,
    operation: JsonStreamOperation = 'ensure'
  ): JsonStreamClientBinding => {
    const url = getStreamUrl(streamId, operation);
    const method = operation === 'append' ? 'POST' : 'GET';
    return {
      client: new StreamsClient({
        url,
        auth: async () => await options.getToken(),
        fetch: fetchImpl as typeof fetch,
        timeout: options.timeout,
      }),
      context: {
        operation: `json.${operation}`,
        method: operation === 'ensure' ? 'PUT' : method,
        url,
      },
    };
  };

  return {
    ensureJsonStream: async (streamId: string, retentionSeconds?: number): Promise<void> => {
      const { client: streamClient, context } = getStreamClient(streamId);
      const requestedTtlSeconds = normalizeRetentionSeconds(retentionSeconds);
      const createResult = await streamClient.create({
        contentType: JSON_STREAM_CONTENT_TYPE,
        ttlSeconds: requestedTtlSeconds,
      });

      if (createResult.ok) {
        return;
      }

      if ('status' in createResult.result && createResult.result.status === 409) {
        const headResult = await streamClient.head();
        if (
          headResult.ok &&
          isCompatibleExistingJsonStream(headResult.result, requestedTtlSeconds)
        ) {
          return;
        }

        if (!headResult.ok) {
          throw toLoroGatewayError('inspect existing stream', streamId, headResult.result, {
            ...context,
            operation: 'json.ensure.head',
            method: 'HEAD',
          });
        }
      }

      throw toLoroGatewayError('ensure stream', streamId, createResult.result, context);
    },

    appendJson: async (streamId: string, value: unknown): Promise<string | undefined> => {
      const { client: streamClient, context } = getStreamClient(streamId, 'append');
      const result = unwrapStreamResult(
        'append to stream',
        streamId,
        await streamClient.append({
          part: {
            contentType: JSON_STREAM_CONTENT_TYPE,
            body: JSON.stringify(value),
          },
        }),
        context
      );

      return result.nextOffset;
    },

    readJsonLive: async (
      streamId: string,
      state: LoroJsonStreamState,
      onBatch: LoroJsonLiveBatchHandler,
      liveOptions?: LoroJsonLiveReadOptions
    ): Promise<void> => {
      const { client: streamClient, context } = getStreamClient(streamId, 'live');

      const modePolicy = liveOptions?.modePolicy;
      const requestedMode = modePolicy?.selectRequestMode() ?? options.liveMode ?? 'sse';
      // Reported back to the policy so it can distinguish "SSE worked" from
      // "SSE failed" and from "the server downgraded us to long-poll".
      let observedTransport: LoroStreamsLiveTransport | undefined;
      let deliveredBatch = false;
      let readError: unknown;

      // Guard the live read with an idle watchdog (see `liveIdleTimeoutMs`). We
      // abort with a plain AbortError so the streams client treats it as a clean
      // "done" and this function returns normally; the caller's `while (!stopped)`
      // read loop then reconnects from `state.nextOffset`. The watchdog is linked
      // to the caller's stop signal so a real stop still propagates.
      const watchdog = createLiveIdleWatchdog(
        options.liveIdleTimeoutMs ?? DEFAULT_LIVE_IDLE_TIMEOUT_MS,
        liveOptions?.signal
      );
      try {
        for await (const event of streamClient.live({
          offset: state.nextOffset ?? 'now',
          mode: requestedMode,
          signal: watchdog.signal,
        })) {
          watchdog.reset();
          observedTransport = event.mode;
          switch (event.type) {
            case 'data':
              deliveredBatch = true;
              state.nextOffset = event.nextOffset;
              state.cursor = event.cursor;
              await onBatch({
                messages: parseJsonLivePayload(event.payload, streamId, 'live read'),
                nextOffset: event.nextOffset,
                cursor: event.cursor,
                upToDate: false,
              });
              break;
            case 'up_to_date': {
              deliveredBatch = true;
              state.nextOffset = event.nextOffset;
              state.cursor = event.cursor;
              await onBatch({
                messages: [],
                nextOffset: event.nextOffset,
                cursor: event.cursor,
                upToDate: true,
              });
              break;
            }
            case 'eof': {
              deliveredBatch = true;
              state.nextOffset = event.nextOffset;
              state.cursor = undefined;
              await onBatch({
                messages: [],
                nextOffset: event.nextOffset,
                cursor: undefined,
                upToDate: true,
              });
              return;
            }
            case 'reconnecting':
            case 'reconnected':
              break;
            case 'error':
              throw toLoroGatewayError('read live updates from', streamId, event.error, context);
          }
        }
      } catch (error) {
        readError = error;
        throw error;
      } finally {
        watchdog.dispose();
        // A read the caller cut short (stop, or a policy-driven transport
        // switch) says nothing about transport health, so it is not scored.
        if (modePolicy && liveOptions?.signal?.aborted !== true) {
          modePolicy.noteReadOutcome({
            requestedMode,
            observedTransport,
            deliveredBatch,
            error: readError,
          });
        }
      }
    },
  };
}

type LiveIdleWatchdog = {
  /** Signal to pass to the underlying live read; aborts on stop or idle timeout. */
  readonly signal: AbortSignal;
  /** Call on every received event to restart the idle timer. */
  reset(): void;
  /** Clear the timer and detach the parent-signal listener. */
  dispose(): void;
};

/**
 * Idle watchdog for a single `readJsonLive` iteration. Aborts the live read (with
 * a plain AbortError, so the streams client returns a clean "done") when no event
 * arrives within `timeoutMs`, or immediately when `parentSignal` aborts. Pass a
 * non-positive `timeoutMs` to disable the idle timer while still linking the stop
 * signal.
 */
function createLiveIdleWatchdog(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined
): LiveIdleWatchdog {
  const controller = new AbortController();
  const armed = Number.isFinite(timeoutMs) && timeoutMs > 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onParentAbort = (): void => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const reset = (): void => {
    if (!armed || controller.signal.aborted) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // Unref where available so the timer never keeps a Node process alive.
    timer = setTimeout(() => controller.abort(), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const dispose = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    parentSignal?.removeEventListener('abort', onParentAbort);
  };

  reset();
  return { signal: controller.signal, reset, dispose };
}

function selectJsonStreamOperationBaseUrl(
  baseUrl: string,
  streamId: string,
  operation: 'ensure' | 'append' | 'live',
  shardUrls?: {
    readonly bootstrap?: readonly string[];
    readonly catchup?: readonly string[];
    readonly largePost?: readonly string[];
    readonly other?: readonly string[];
  }
): string {
  const shardCandidates =
    operation === 'append'
      ? (shardUrls?.largePost ?? shardUrls?.other)
      : operation === 'live'
        ? (shardUrls?.catchup ?? shardUrls?.bootstrap ?? shardUrls?.other)
        : shardUrls?.other;
  // Stable per-stream shard selection (not random) so a given request/response
  // stream always targets the same host. A fixed URL lets the browser reuse the
  // warm connection and, crucially, keep the cross-origin CORS preflight cached
  // instead of re-preflighting a freshly-picked write shard on every append.
  const shardBaseUrl = selectStableShardUrl(shardCandidates, streamId);
  if (!shardBaseUrl) return baseUrl;

  try {
    const selected = new URL(shardBaseUrl);
    const next = new URL(baseUrl);
    next.protocol = selected.protocol;
    next.host = selected.host;
    return next.toString().replace(/\/$/, '');
  } catch {
    return baseUrl;
  }
}

function selectStableShardUrl(
  candidates: readonly string[] | undefined,
  streamId: string
): string | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  let hash = 2166136261;
  for (let index = 0; index < streamId.length; index += 1) {
    hash ^= streamId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return candidates[(hash >>> 0) % candidates.length];
}

export type LoggerLike = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type LoroStreamsMachineRpcTrace = (event: string, details: Record<string, unknown>) => void;

const delay = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const CODE_COLLAB_V2_RPC_PAYLOAD_AAD_LABEL = 'lody-code-collab-v2-machine-rpc-payload-v1';

const getSubtleCryptoOrThrow = (): SubtleCrypto => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto is required for remote Code Collab RPC payload envelopes.');
  }
  return subtle;
};

const getCryptoOrThrow = (): Crypto => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error(
      'WebCrypto random source is required for remote Code Collab RPC payload envelopes.'
    );
  }
  return globalThis.crypto;
};

const importCodeCollabV2ContentKey = async (ownerSessionId: string): Promise<CryptoKey> => {
  return await getSubtleCryptoOrThrow().importKey(
    'raw',
    copyToArrayBuffer(deriveCodeCollabV2ContentKeyBytes(ownerSessionId)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
};

const codeCollabV2PayloadAdditionalData = (
  ownerSessionId: string,
  keyId: string,
  keyVersion: number
): Uint8Array =>
  new TextEncoder().encode(
    `${CODE_COLLAB_V2_RPC_PAYLOAD_AAD_LABEL}\0${ownerSessionId}\0${keyId}\0${keyVersion}`
  );

export const encryptCodeCollabV2RpcPayload = async (
  ownerSessionId: string,
  payload: unknown
): Promise<CodeCollabV2RpcContentEnvelope> => {
  const normalizedOwnerSessionId = ownerSessionId.trim();
  if (!normalizedOwnerSessionId) {
    throw new Error('Code Collab owner session id is required for RPC payload encryption.');
  }

  const keyId = deriveCodeCollabV2ContentKeyId(normalizedOwnerSessionId);
  const iv = new Uint8Array(12);
  getCryptoOrThrow().getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await getSubtleCryptoOrThrow().encrypt(
      {
        name: 'AES-GCM',
        iv: copyToArrayBuffer(iv),
        additionalData: copyToArrayBuffer(
          codeCollabV2PayloadAdditionalData(normalizedOwnerSessionId, keyId, 1)
        ),
      },
      await importCodeCollabV2ContentKey(normalizedOwnerSessionId),
      copyToArrayBuffer(plaintext)
    )
  );

  return {
    type: 'code-collab-v2-content-envelope',
    keyVersion: 1,
    algorithm: 'AES-256-GCM',
    ownerSessionId: normalizedOwnerSessionId,
    keyId,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext),
  };
};

export const decryptCodeCollabV2RpcPayload = async (
  envelope: CodeCollabV2RpcContentEnvelope,
  expectedOwnerSessionId?: string
): Promise<unknown> => {
  const parsed = CodeCollabV2RpcContentEnvelopeSchema.parse(envelope);
  const normalizedOwnerSessionId = parsed.ownerSessionId.trim();
  if (expectedOwnerSessionId && normalizedOwnerSessionId !== expectedOwnerSessionId.trim()) {
    throw new Error('Code Collab RPC payload owner session mismatch.');
  }
  if (parsed.keyId !== deriveCodeCollabV2ContentKeyId(normalizedOwnerSessionId)) {
    throw new Error('Code Collab RPC payload key id mismatch.');
  }

  const iv = base64UrlToBytes(parsed.iv);
  const ciphertext = base64UrlToBytes(parsed.ciphertext);
  const plaintext = await getSubtleCryptoOrThrow().decrypt(
    {
      name: 'AES-GCM',
      iv: copyToArrayBuffer(iv),
      additionalData: copyToArrayBuffer(
        codeCollabV2PayloadAdditionalData(normalizedOwnerSessionId, parsed.keyId, parsed.keyVersion)
      ),
    },
    await importCodeCollabV2ContentKey(normalizedOwnerSessionId),
    copyToArrayBuffer(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
};

const copyToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000));
    binary += String.fromCharCode(...chunk);
  }
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlToBytes = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary =
    typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export type LoroMachineRpcResult =
  | MachineStatusResponse
  | MachinePingResponse
  | MachineRestartResponse
  | MachineUpgradeResponse
  | CodeCollabV2RpcResponse
  | CodeCollabV2Error
  | FilePreviewV3Response
  | MachineAcpCapabilitiesRefreshResponse
  | MachineAcpAuthenticateResponse
  | MachineAcpAuthenticationProgressMessage
  | MachineAcpBinaryStatusResponse
  | MachineAcpBinaryInstallResponse
  | MachineAcpBinaryProgressMessage
  | MachineBugReportResponse
  | SessionCancelResponse
  | LoroSessionLiveStatusRpcResponse
  | SessionSteerResponse
  | SessionTerminateResponse
  | SessionForkResponse
  | SessionEditAndResendResponse
  | SessionDispatchTurnResponse
  | SessionPrepareResponse
  | SessionPrepareCancelResponse
  | SessionPreviewCreateResponse
  | SessionPreviewRevokeResponse
  | LocalProjectGitStateRpcResponse
  | LocalProjectControlResponse;

const toLegacyRpcErrorResponse = (
  method: LoroStreamsRpcMethod,
  machineId: string,
  error: LoroStreamsRpcError,
  refreshContext?: {
    configId: AgentConfigId;
    cliType: RpcAgentConfigCliType;
    agentType: string;
  },
  pingContext?: { requestId: string },
  lifecycleContext?: { requestId: string; targetVersion?: string },
  binaryContext?: { agentType: string; requestId?: string },
  cancelContext?: { sessionId: string },
  forkContext?: { sourceSessionId: string; targetSessionId: string },
  editAndResendContext?: { sessionId: string; replacementUserTurnId: string },
  steerContext?: { sessionId: string; userTurnId: string },
  previewContext?: { sessionId: string },
  localProjectContext?: {
    workspaceId?: string;
    localProjectId?: string;
    type?: LocalProjectControlRequest['type'];
  },
  dispatchContext?: { sessionId: string; userTurnId: string },
  preparationContext?: { preparationId: string; sessionId: string }
): LoroMachineRpcResult => {
  if (method === 'machine/status') {
    return {
      type: 'machine/status_response',
      machineId: machineId as MachineStatusResponse['machineId'],
      success: false,
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'machine/ping') {
    return {
      type: 'machine/ping_response',
      machineId: machineId as MachinePingResponse['machineId'],
      requestId: pingContext?.requestId ?? '',
      success: false,
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'machine/restart') {
    return {
      type: 'machine/restart_response',
      machineId: machineId as MachineRestartResponse['machineId'],
      requestId: lifecycleContext?.requestId ?? '',
      success: false,
      accepted: false,
      disposition: 'error',
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'machine/upgrade') {
    return {
      type: 'machine/upgrade_response',
      machineId: machineId as MachineUpgradeResponse['machineId'],
      requestId: lifecycleContext?.requestId ?? '',
      success: false,
      accepted: false,
      disposition: 'error',
      targetVersion: lifecycleContext?.targetVersion,
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'machine/acp-capabilities-refresh') {
    return {
      type: 'machine/acp-capabilities-refresh_response',
      machineId: machineId as MachineAcpCapabilitiesRefreshResponse['machineId'],
      configId: refreshContext?.configId ?? ('' as AgentConfigId),
      cliType: refreshContext?.cliType ?? 'builtin',
      agentType: refreshContext?.agentType ?? 'unknown',
      success: false,
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'machine/acp-authenticate') {
    return {
      type: 'machine/acp-authenticate_response',
      machineId: machineId as MachineAcpAuthenticateResponse['machineId'],
      requestId: binaryContext?.requestId ?? '',
      agentType: binaryContext?.agentType ?? 'unknown',
      success: false,
      disposition: 'error',
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'machine/acp-binary-status') {
    return {
      type: 'machine/acp-binary-status_response',
      machineId: machineId as MachineAcpBinaryStatusResponse['machineId'],
      agentType: binaryContext?.agentType ?? 'unknown',
      success: false,
      status: 'not-installed',
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'machine/acp-binary-install') {
    return {
      type: 'machine/acp-binary-install_response',
      machineId: machineId as MachineAcpBinaryInstallResponse['machineId'],
      agentType: binaryContext?.agentType ?? 'unknown',
      success: false,
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'machine/bug-report') {
    return {
      type: 'machine/bug-report_response',
      machineId: machineId as MachineBugReportResponse['machineId'],
      success: false,
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'session/cancel' || method === 'session/terminate') {
    return {
      type: method === 'session/cancel' ? 'session/cancel_response' : 'session/terminate_response',
      sessionId: (cancelContext?.sessionId ?? '') as SessionCancelResponse['sessionId'],
      success: false,
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'session/live-status') {
    return {
      type: 'session/live-status_response',
      machineId,
      sessionId: cancelContext?.sessionId ?? '',
      success: false,
      state: 'unknown',
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'session/fork') {
    return sessionForkFailure(
      {
        sourceSessionId: (forkContext?.sourceSessionId ??
          '') as SessionForkResponse['sourceSessionId'],
        targetSessionId: (forkContext?.targetSessionId ??
          '') as SessionForkResponse['targetSessionId'],
      },
      'INTERNAL_ERROR',
      `${error.code}: ${error.message}`
    );
  }

  if (method === 'session/edit-and-resend') {
    return sessionEditAndResendFailure(
      {
        sessionId: (editAndResendContext?.sessionId ??
          '') as SessionEditAndResendResponse['sessionId'],
        replacementUserTurnId: editAndResendContext?.replacementUserTurnId ?? '',
      },
      'INTERNAL_ERROR',
      `${error.code}: ${error.message}`
    );
  }

  if (method === 'session/steer') {
    return {
      type: 'session/steer_response',
      sessionId: (steerContext?.sessionId ?? '') as SessionSteerResponse['sessionId'],
      userTurnId: steerContext?.userTurnId ?? '',
      applied: false,
      disposition: 'error',
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'session/dispatch-turn') {
    return {
      type: 'session/dispatch-turn_response',
      sessionId: (dispatchContext?.sessionId ?? '') as SessionDispatchTurnResponse['sessionId'],
      userTurnId: dispatchContext?.userTurnId ?? '',
      accepted: false,
      disposition: 'error',
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'session/prepare') {
    return {
      type: 'session/prepare_response',
      preparationId: preparationContext?.preparationId ?? '',
      sessionId: (preparationContext?.sessionId ?? '') as SessionPrepareResponse['sessionId'],
      accepted: false,
      disposition: 'error',
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'session/prepare-cancel') {
    return {
      type: 'session/prepare-cancel_response',
      preparationId: preparationContext?.preparationId ?? '',
      sessionId: (preparationContext?.sessionId ?? '') as SessionPrepareCancelResponse['sessionId'],
      cancelled: false,
      disposition: 'error',
      error: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'file/preview') {
    const parsedData = FilePreviewV3ErrorSchema.safeParse(error.data);
    if (parsedData.success) {
      return {
        ...parsedData.data,
        message: parsedData.data.message ?? error.message,
      };
    }
    const parsedCode = FilePreviewV3ErrorCodeSchema.safeParse(error.code);
    return {
      status: 'error',
      v: FILE_PREVIEW_PROTOCOL_VERSION,
      code: parsedCode.success ? parsedCode.data : 'transient_io',
      message: error.message,
      retryable: error.code === 'request_failed' || error.code === 'machine_rpc_unavailable',
    };
  }

  if (method.startsWith('code-collab/')) {
    const parsedData = CodeCollabV2ErrorSchema.safeParse(error.data);
    if (parsedData.success) {
      return {
        ...parsedData.data,
        message: parsedData.data.message ?? error.message,
      };
    }
    const parsed = CodeCollabV2ErrorCodeSchema.safeParse(error.code);
    return {
      status: 'error',
      code: parsed.success ? parsed.data : 'transient_io',
      message: error.message,
      retryable: error.code === 'request_failed' || error.code === 'machine_rpc_unavailable',
    };
  }

  if (method === 'session/preview-create') {
    return {
      type: 'session/preview-create_response',
      sessionId: (previewContext?.sessionId ?? '') as SessionPreviewCreateResponse['sessionId'],
      success: false,
      error: 'internal_error',
      message: `${error.code}: ${error.message}`,
    };
  }

  if (method === 'local-project/git-state') {
    return {
      type: 'local-project/git-state_response',
      machineId,
      workspaceId: localProjectContext?.workspaceId ?? '',
      localProjectId: (localProjectContext?.localProjectId ?? '') as LocalProjectId,
      success: false,
      error: error.code,
      message: error.message,
    };
  }

  if (method === 'local-project/control') {
    return {
      ok: false,
      type: localProjectContext?.type ?? 'local-project/list',
      error: 'execution_failed',
      message: `${error.code}: ${error.message}`,
      data: error.data,
    };
  }

  return {
    type: 'session/preview-revoke_response',
    sessionId: (previewContext?.sessionId ?? '') as SessionPreviewRevokeResponse['sessionId'],
    success: false,
    error: 'internal_error',
    message: `${error.code}: ${error.message}`,
  };
};

const parseRpcSuccessResult = async (
  response: LoroStreamsRpcResponse,
  expectedCodeCollabOwnerSessionId?: string
): Promise<LoroMachineRpcResult | null> => {
  if (response.result === undefined) {
    return null;
  }
  const progress = MachineAcpBinaryProgressMessageSchema.safeParse(response.result);
  if (progress.success) {
    return progress.data as MachineAcpBinaryProgressMessage;
  }
  const authenticationProgress = MachineAcpAuthenticationProgressMessageSchema.safeParse(
    response.result
  );
  if (authenticationProgress.success) {
    return authenticationProgress.data as MachineAcpAuthenticationProgressMessage;
  }
  if (response.method === 'machine/status') {
    const parsed = MachineStatusResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as MachineStatusResponse) : null;
  }
  if (response.method === 'machine/ping') {
    const parsed = MachinePingResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as MachinePingResponse) : null;
  }
  if (response.method === 'machine/restart') {
    const parsed = MachineRestartResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as MachineRestartResponse) : null;
  }
  if (response.method === 'machine/upgrade') {
    const parsed = MachineUpgradeResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as MachineUpgradeResponse) : null;
  }
  if (response.method === 'machine/acp-capabilities-refresh') {
    const parsed = MachineAcpCapabilitiesRefreshResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as MachineAcpCapabilitiesRefreshResponse) : null;
  }
  if (response.method === 'machine/acp-authenticate') {
    const parsed = MachineAcpAuthenticateResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as MachineAcpAuthenticateResponse) : null;
  }
  if (response.method === 'machine/acp-binary-status') {
    const parsed = MachineAcpBinaryStatusResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as MachineAcpBinaryStatusResponse) : null;
  }
  if (response.method === 'machine/acp-binary-install') {
    const parsed = MachineAcpBinaryInstallResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as MachineAcpBinaryInstallResponse) : null;
  }
  if (response.method === 'machine/bug-report') {
    const parsed = MachineBugReportResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as MachineBugReportResponse) : null;
  }
  if (response.method === 'session/cancel') {
    const parsed = SessionCancelResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as SessionCancelResponse) : null;
  }
  if (response.method === 'session/live-status') {
    const parsed = LoroSessionLiveStatusRpcResponseSchema.safeParse(response.result);
    return parsed.success ? parsed.data : null;
  }
  if (response.method === 'session/steer') {
    const parsed = SessionSteerResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as SessionSteerResponse) : null;
  }
  if (response.method === 'session/terminate') {
    const parsed = SessionTerminateResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as SessionTerminateResponse) : null;
  }
  if (response.method === 'session/fork') {
    const parsed = SessionForkResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as SessionForkResponse) : null;
  }
  if (response.method === 'session/edit-and-resend') {
    const parsed = SessionEditAndResendResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as SessionEditAndResendResponse) : null;
  }
  if (response.method === 'session/dispatch-turn') {
    const parsed = SessionDispatchTurnResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as SessionDispatchTurnResponse) : null;
  }
  if (response.method === 'session/prepare') {
    const parsed = SessionPrepareResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as SessionPrepareResponse) : null;
  }
  if (response.method === 'session/prepare-cancel') {
    const parsed = SessionPrepareCancelResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as SessionPrepareCancelResponse) : null;
  }
  if (isOwnerScopedEncryptedRpcMethod(response.method)) {
    const envelope = CodeCollabV2RpcContentEnvelopeSchema.safeParse(response.result);
    if (!envelope.success) {
      return null;
    }
    const decrypted = await decryptCodeCollabV2RpcPayload(
      envelope.data,
      expectedCodeCollabOwnerSessionId
    );
    if (response.method === 'file/preview') {
      const previewParsed = FilePreviewV3ResponseSchema.safeParse(decrypted);
      return previewParsed.success ? previewParsed.data : null;
    }
    const parsed = CodeCollabV2RpcResponseSchema.safeParse(decrypted);
    return parsed.success ? parsed.data : null;
  }
  if (response.method === 'session/preview-create') {
    const parsed = SessionPreviewCreateResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as SessionPreviewCreateResponse) : null;
  }
  if (response.method === 'local-project/git-state') {
    const parsed = LoroLocalProjectGitStateRpcResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as LocalProjectGitStateRpcResponse) : null;
  }
  if (response.method === 'local-project/control') {
    const parsed = LocalProjectControlResponseSchema.safeParse(response.result);
    return parsed.success ? (parsed.data as LocalProjectControlResponse) : null;
  }
  const parsed = SessionPreviewRevokeResponseSchema.safeParse(response.result);
  return parsed.success ? (parsed.data as SessionPreviewRevokeResponse) : null;
};

export type LoroStreamsRpcPendingRegistration = {
  ownerId?: string;
  machineId: string;
  method: LoroStreamsRpcMethod;
  timeoutMs: number;
  refreshContext?: {
    configId: AgentConfigId;
    cliType: RpcAgentConfigCliType;
    agentType: string;
  };
  pingContext?: { requestId: string };
  lifecycleContext?: { requestId: string; targetVersion?: string };
  binaryContext?: { agentType: string; requestId?: string };
  cancelContext?: { sessionId: string };
  forkContext?: { sourceSessionId: string; targetSessionId: string };
  editAndResendContext?: { sessionId: string; replacementUserTurnId: string };
  steerContext?: { sessionId: string; userTurnId: string };
  previewContext?: { sessionId: string };
  localProjectContext?: {
    workspaceId?: string;
    localProjectId?: string;
    type?: LocalProjectControlRequest['type'];
  };
  dispatchContext?: { sessionId: string; userTurnId: string };
  preparationContext?: { preparationId: string; sessionId: string };
  codeCollabOwnerSessionId?: string;
  onAcpBinaryProgress?: (message: MachineAcpBinaryProgressMessage) => void;
  onAcpAuthenticationProgress?: (message: MachineAcpAuthenticationProgressMessage) => void;
  startedAtMs: number;
};

export type LoroStreamsRpcPendingRequest = LoroStreamsRpcPendingRegistration & {
  appendFinishedAtMs?: number;
  resolve: (value: LoroMachineRpcResult | null) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export class LoroStreamsRpcResponseDispatcher {
  readonly responseStreamId: string;
  private readonly responseState: LoroJsonStreamState = { nextOffset: '-1' };
  private readonly pending = new Map<string, LoroStreamsRpcPendingRequest>();
  private readonly stopController = new AbortController();
  private readonly liveModePolicy: LoroStreamsLiveModePolicy | undefined;
  /** Aborts only the current live read so a transport switch takes effect now. */
  private currentReadController: AbortController | null = null;
  private lastReportedTransport: LoroStreamsLiveTransport | undefined;
  private startedPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly options: {
      workspaceId: string;
      streamClient: LoroStreamsJsonStreamClient;
      responseStreamId?: string;
      logger?: LoggerLike;
      retentionSeconds?: number;
      logLabel?: string;
      trace?: LoroStreamsMachineRpcTrace;
      /**
       * SSE-first live transport with a bounded long-poll fallback. Omit to
       * keep the stream client's static `liveMode`.
       */
      liveModePolicy?: LoroStreamsLiveModePolicy;
    }
  ) {
    this.responseStreamId =
      options.responseStreamId ??
      `${getLoroWorkspaceRpcResponseStreamId(options.workspaceId)}:${crypto.randomUUID()}`;
    this.liveModePolicy = options.liveModePolicy;
    this.lastReportedTransport = options.liveModePolicy?.getDiagnostics().transport;
  }

  /** Selected live transport and why, for diagnostics. */
  getLiveModeDiagnostics(): LoroStreamsLiveModeDiagnostics | null {
    return this.liveModePolicy?.getDiagnostics() ?? null;
  }

  getResponseStreamId(): string {
    return this.responseStreamId;
  }

  async start(): Promise<void> {
    if (this.startedPromise) {
      return await this.startedPromise;
    }

    this.startedPromise = (async () => {
      // Response streams are per-client and are created lazily by the response
      // loop or by the server-side append fallback if the first response wins.
      void this.runResponseLoop();
    })();

    return await this.startedPromise;
  }

  registerPending(
    requestId: string,
    registration: LoroStreamsRpcPendingRegistration
  ): Promise<LoroMachineRpcResult | null> {
    return new Promise<LoroMachineRpcResult | null>((resolve) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pending.get(requestId);
        this.pending.delete(requestId);
        const elapsedMs = Date.now() - registration.startedAtMs;
        this.options.trace?.('machine rpc transport response timeout', {
          workspaceId: this.options.workspaceId,
          machineId: registration.machineId,
          method: registration.method,
          rpcRequestId: requestId,
          timeoutMs: registration.timeoutMs,
          elapsedMs,
          responseAfterAppendMs:
            pending?.appendFinishedAtMs === undefined
              ? undefined
              : Date.now() - pending.appendFinishedAtMs,
          responseStreamId: this.responseStreamId,
        });
        // A timed-out call with no response is the only signal that an SSE
        // connection is open but not delivering appends; the transport-level
        // read looks perfectly healthy in that failure.
        this.noteLiveModeResponseTimeout();
        resolve(null);
      }, registration.timeoutMs);
      this.pending.set(requestId, {
        ...registration,
        resolve,
        timeoutId,
      });
    });
  }

  markAppendFinished(requestId: string, appendFinishedAtMs: number = Date.now()): void {
    const pending = this.pending.get(requestId);
    if (pending) {
      pending.appendFinishedAtMs = appendFinishedAtMs;
    }
  }

  takePending(requestId: string): LoroStreamsRpcPendingRequest | null {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return null;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(requestId);
    return pending;
  }

  cancelPendingForOwner(ownerId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.ownerId !== ownerId) {
        continue;
      }
      clearTimeout(pending.timeoutId);
      pending.resolve(null);
      this.pending.delete(requestId);
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.stopController.abort();
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId);
      pending.resolve(null);
      this.pending.delete(requestId);
    }
  }

  private noteLiveModeResponseTimeout(): void {
    if (!this.liveModePolicy) {
      return;
    }
    this.liveModePolicy.noteResponseTimeout();
    if (!this.reportLiveModeChange()) {
      return;
    }
    // Cut the current read short so the fallback transport applies immediately
    // instead of after the next server-side close. Offsets live in
    // `responseState` and pending calls in `pending`, so neither is disturbed.
    this.currentReadController?.abort();
  }

  /** Logs/traces a transport switch. Returns whether the transport changed. */
  private reportLiveModeChange(): boolean {
    const diagnostics = this.liveModePolicy?.getDiagnostics();
    if (!diagnostics || diagnostics.transport === this.lastReportedTransport) {
      return false;
    }
    this.lastReportedTransport = diagnostics.transport;
    const label = this.options.logLabel ?? this.options.workspaceId;
    this.options.trace?.('machine rpc live transport changed', {
      workspaceId: this.options.workspaceId,
      responseStreamId: this.responseStreamId,
      ...diagnostics,
    });
    this.options.logger?.warn?.(
      `[rpc-client:${label}] live transport -> ${diagnostics.transport} (${diagnostics.reason})`
    );
    return true;
  }

  private async runResponseLoop(): Promise<void> {
    while (!this.stopped) {
      // One controller per read iteration: `stop()` ends the loop, while a
      // transport switch only aborts the read in flight.
      const readController = new AbortController();
      const onStop = (): void => readController.abort();
      this.stopController.signal.addEventListener('abort', onStop, { once: true });
      this.currentReadController = readController;
      try {
        await this.options.streamClient.readJsonLive(
          this.responseStreamId,
          this.responseState,
          async (batch) => {
            this.responseState.nextOffset = batch.nextOffset ?? this.responseState.nextOffset;
            this.responseState.cursor = batch.cursor;

            for (const raw of batch.messages) {
              await this.handleRawResponse(raw);
            }
          },
          { signal: readController.signal, modePolicy: this.liveModePolicy }
        );
      } catch (error) {
        if (this.stopped) {
          return;
        }

        if (error instanceof LoroStreamsGatewayError) {
          if (error.status === 404) {
            await this.options.streamClient.ensureJsonStream(
              this.responseStreamId,
              this.options.retentionSeconds ?? LORO_STREAMS_RPC_RETENTION_SECONDS
            );
            this.responseState.nextOffset = '-1';
            this.responseState.cursor = undefined;
            continue;
          }
          if (error.status === 410) {
            this.responseState.nextOffset = '-1';
            this.responseState.cursor = undefined;
            continue;
          }
        }

        const message = error instanceof Error ? error.message : String(error);
        this.options.logger?.warn?.(
          `[rpc-client:${this.options.logLabel ?? this.options.workspaceId}] response loop error: ${message}`
        );
        await delay(1000);
      } finally {
        this.stopController.signal.removeEventListener('abort', onStop);
        this.currentReadController = null;
        this.reportLiveModeChange();
      }
    }
  }

  private async handleRawResponse(raw: unknown): Promise<void> {
    const parsed = LoroStreamsRpcResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.options.logger?.warn?.(
        `[rpc-client:${this.options.logLabel ?? this.options.workspaceId}] ignored invalid RPC response`
      );
      return;
    }

    const pending = this.pending.get(parsed.data.id);
    if (!pending) {
      return;
    }

    // The live stream is delivering responses; clear the starvation counter.
    this.liveModePolicy?.noteResponseReceived();

    const receivedAtMs = Date.now();
    this.options.trace?.('machine rpc transport response received', {
      workspaceId: this.options.workspaceId,
      machineId: parsed.data.machineId,
      method: parsed.data.method,
      rpcRequestId: parsed.data.id,
      elapsedMs: receivedAtMs - pending.startedAtMs,
      responseAfterAppendMs:
        pending.appendFinishedAtMs === undefined
          ? undefined
          : receivedAtMs - pending.appendFinishedAtMs,
      responseStreamId: this.responseStreamId,
    });

    if (!parsed.data.error) {
      const progress = MachineAcpBinaryProgressMessageSchema.safeParse(parsed.data.result);
      if (progress.success) {
        pending.onAcpBinaryProgress?.(progress.data as MachineAcpBinaryProgressMessage);
        return;
      }
      const authenticationProgress = MachineAcpAuthenticationProgressMessageSchema.safeParse(
        parsed.data.result
      );
      if (authenticationProgress.success) {
        pending.onAcpAuthenticationProgress?.(
          authenticationProgress.data as MachineAcpAuthenticationProgressMessage
        );
        return;
      }
    }

    const finalPending = this.takePending(parsed.data.id);
    if (!finalPending) {
      return;
    }

    if (parsed.data.error) {
      let error = parsed.data.error;
      const encryptedErrorData = CodeCollabV2RpcContentEnvelopeSchema.safeParse(error.data);
      if (
        finalPending.codeCollabOwnerSessionId !== undefined &&
        isOwnerScopedEncryptedRpcMethod(parsed.data.method) &&
        encryptedErrorData.success
      ) {
        try {
          error = {
            ...error,
            data: await decryptCodeCollabV2RpcPayload(
              encryptedErrorData.data,
              finalPending.codeCollabOwnerSessionId
            ),
          };
        } catch {
          error = {
            code: 'invalid_result',
            message: 'Invalid encrypted RPC error payload',
          };
        }
      }
      finalPending.resolve(
        toLegacyRpcErrorResponse(
          parsed.data.method,
          parsed.data.machineId,
          error,
          finalPending.refreshContext,
          finalPending.pingContext,
          finalPending.lifecycleContext,
          finalPending.binaryContext,
          finalPending.cancelContext,
          finalPending.forkContext,
          finalPending.editAndResendContext,
          finalPending.steerContext,
          finalPending.previewContext,
          finalPending.localProjectContext,
          finalPending.dispatchContext,
          finalPending.preparationContext
        )
      );
      return;
    }

    let result: LoroMachineRpcResult | null = null;
    try {
      result = await parseRpcSuccessResult(parsed.data, finalPending.codeCollabOwnerSessionId);
    } catch {
      result = null;
    }
    if (!result) {
      finalPending.resolve(
        toLegacyRpcErrorResponse(
          parsed.data.method,
          parsed.data.machineId,
          {
            code: 'invalid_result',
            message: 'Invalid RPC response payload',
          },
          finalPending.refreshContext,
          finalPending.pingContext,
          finalPending.lifecycleContext,
          finalPending.binaryContext,
          finalPending.cancelContext,
          finalPending.forkContext,
          finalPending.editAndResendContext,
          finalPending.steerContext,
          finalPending.previewContext,
          finalPending.localProjectContext,
          finalPending.dispatchContext,
          finalPending.preparationContext
        )
      );
      return;
    }

    finalPending.resolve(result);
  }
}

export class LoroStreamsMachineRpcClient {
  private readonly requestStreamId: string;
  private readonly responseDispatcher: LoroStreamsRpcResponseDispatcher;
  private readonly ownsResponseDispatcher: boolean;
  private readonly pendingOwnerId = crypto.randomUUID();
  private stopped = false;
  private readonly acpAuthorizationCodePublicKeys = new Map<string, RpcSecretPublicKey>();

  constructor(
    private readonly options: {
      workspaceId: string;
      machineId: string;
      streamClient: LoroStreamsJsonStreamClient;
      responseDispatcher?: LoroStreamsRpcResponseDispatcher;
      logger?: LoggerLike;
      now?: () => number;
      rpcVersion?: string;
      retentionSeconds?: number;
      trace?: LoroStreamsMachineRpcTrace;
    }
  ) {
    this.requestStreamId = getLoroMachineRpcRequestStreamId(options.workspaceId, options.machineId);
    this.responseDispatcher =
      options.responseDispatcher ??
      new LoroStreamsRpcResponseDispatcher({
        workspaceId: options.workspaceId,
        streamClient: options.streamClient,
        responseStreamId: `${getLoroMachineRpcResponseStreamId(
          options.workspaceId,
          options.machineId
        )}:${crypto.randomUUID()}`,
        logger: options.logger,
        retentionSeconds: options.retentionSeconds,
        logLabel: options.machineId,
        trace: options.trace,
      });
    this.ownsResponseDispatcher = options.responseDispatcher === undefined;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    await this.responseDispatcher.start();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.acpAuthorizationCodePublicKeys.clear();
    if (this.ownsResponseDispatcher) {
      this.responseDispatcher.stop();
      return;
    }
    this.responseDispatcher.cancelPendingForOwner(this.pendingOwnerId);
  }

  async requestMachineStatus(options?: {
    timeoutMs?: number;
  }): Promise<MachineStatusResponse | null> {
    return (await this.sendRequest({
      method: 'machine/status',
      timeoutMs: options?.timeoutMs ?? 30_000,
      params: {},
    })) as MachineStatusResponse | null;
  }

  async requestMachinePing(options: {
    requestId: string;
    timeoutMs?: number;
  }): Promise<MachinePingResponse | null> {
    return (await this.sendRequest({
      method: 'machine/ping',
      timeoutMs: options.timeoutMs ?? 30_000,
      params: {
        requestId: options.requestId,
      },
    })) as MachinePingResponse | null;
  }

  async requestMachineRestart(options: {
    requesterUserId: string;
    requestToken: string;
    requestId: string;
    timeoutMs?: number;
  }): Promise<MachineRestartResponse | null> {
    return (await this.sendRequest({
      method: 'machine/restart',
      timeoutMs: options.timeoutMs ?? 30_000,
      params: {
        requesterUserId: options.requesterUserId,
        requestToken: options.requestToken,
        requestId: options.requestId,
      },
    })) as MachineRestartResponse | null;
  }

  async requestMachineUpgrade(options: {
    requesterUserId: string;
    requestToken: string;
    requestId: string;
    targetVersion?: string;
    timeoutMs?: number;
  }): Promise<MachineUpgradeResponse | null> {
    return (await this.sendRequest({
      method: 'machine/upgrade',
      timeoutMs: options.timeoutMs ?? 30_000,
      params: {
        requesterUserId: options.requesterUserId,
        requestToken: options.requestToken,
        requestId: options.requestId,
        targetVersion: options.targetVersion,
      },
    })) as MachineUpgradeResponse | null;
  }

  async requestMachineAcpCapabilitiesRefresh(options: {
    configId: AgentConfigId;
    onProgress?: (message: MachineAcpBinaryProgressMessage) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<MachineAcpCapabilitiesRefreshResponse | null> {
    return (await this.sendRequest({
      method: 'machine/acp-capabilities-refresh',
      timeoutMs: options.timeoutMs ?? 120_000,
      onAcpBinaryProgress: options.onProgress,
      signal: options.signal,
      params: {
        configId: options.configId,
      },
    })) as MachineAcpCapabilitiesRefreshResponse | null;
  }

  async requestMachineAcpAuthenticate(
    options: {
      requestId: string;
      onProgress?: (message: MachineAcpAuthenticationProgressMessage) => void;
      timeoutMs?: number;
    } & (
      | { action: 'start'; configId: AgentConfigId }
      | { action: 'cancel'; authenticationRequestId: string }
      | {
          action: 'submit-code';
          authenticationRequestId: string;
          authorizationCode: string;
        }
      | {
          action: 'submit-input';
          authenticationRequestId: string;
          interactionId: string;
          authenticationInput: string;
        }
    )
  ): Promise<MachineAcpAuthenticateResponse | null> {
    const authenticationRequestId =
      options.action === 'start' ? undefined : options.authenticationRequestId;
    let authorizationCodeEnvelope: RpcSecretEnvelope | undefined;
    let authenticationInputEnvelope: RpcSecretEnvelope | undefined;
    if (options.action === 'submit-code') {
      if (
        !authenticationRequestId ||
        !options.authorizationCode?.trim() ||
        options.authorizationCode.length > 4096
      ) {
        throw new Error('Submitting an authorization code requires an authentication request.');
      }
      const publicKey = this.acpAuthorizationCodePublicKeys.get(authenticationRequestId);
      if (!publicKey) {
        throw new Error('The target machine did not provide an authorization-code encryption key.');
      }
      authorizationCodeEnvelope = await encryptRpcSecret(
        publicKey,
        options.authorizationCode,
        getMachineAcpAuthorizationCodeSecretContext({
          workspaceId: this.options.workspaceId,
          machineId: this.options.machineId,
          authenticationRequestId,
        })
      );
    }
    if (options.action === 'submit-input') {
      if (
        !authenticationRequestId ||
        !options.interactionId ||
        !options.authenticationInput ||
        options.authenticationInput.length > 65_536
      ) {
        throw new Error('Submitting authentication input requires an active interaction.');
      }
      const publicKey = this.acpAuthorizationCodePublicKeys.get(authenticationRequestId);
      if (!publicKey) {
        throw new Error('The target machine did not provide an authentication-input key.');
      }
      authenticationInputEnvelope = await encryptRpcSecret(
        publicKey,
        options.authenticationInput,
        getMachineAcpAuthenticationInputSecretContext({
          workspaceId: this.options.workspaceId,
          machineId: this.options.machineId,
          authenticationRequestId,
          interactionId: options.interactionId,
        })
      );
    }

    const onProgress = (progress: MachineAcpAuthenticationProgressMessage): void => {
      const inputPublicKey =
        progress.authenticationInputPublicKey ?? progress.authorizationCodePublicKey;
      if (inputPublicKey) {
        this.acpAuthorizationCodePublicKeys.set(progress.requestId, inputPublicKey);
      }
      options.onProgress?.(progress);
    };

    try {
      const params = (() => {
        switch (options.action) {
          case 'start':
            return {
              requestId: options.requestId,
              action: options.action,
              configId: options.configId,
            } as const;
          case 'cancel':
            return {
              requestId: options.requestId,
              action: options.action,
              authenticationRequestId: options.authenticationRequestId,
            } as const;
          case 'submit-code':
            if (!authorizationCodeEnvelope) {
              throw new Error('Authorization-code encryption did not produce an envelope.');
            }
            return {
              requestId: options.requestId,
              action: options.action,
              authenticationRequestId: options.authenticationRequestId,
              authorizationCodeEnvelope,
            } as const;
          case 'submit-input':
            if (!authenticationInputEnvelope) {
              throw new Error('Authentication-input encryption did not produce an envelope.');
            }
            return {
              requestId: options.requestId,
              action: options.action,
              authenticationRequestId: options.authenticationRequestId,
              interactionId: options.interactionId,
              authenticationInputEnvelope,
            } as const;
          default:
            throw new Error('Unsupported ACP authentication action.');
        }
      })();
      return (await this.sendRequest({
        method: 'machine/acp-authenticate',
        timeoutMs: options.timeoutMs ?? 300_000,
        onAcpAuthenticationProgress: onProgress,
        params,
      })) as MachineAcpAuthenticateResponse | null;
    } finally {
      if (options.action === 'start') {
        this.acpAuthorizationCodePublicKeys.delete(options.requestId);
      } else if (options.action === 'cancel') {
        this.acpAuthorizationCodePublicKeys.delete(options.authenticationRequestId);
      }
    }
  }

  async requestMachineAcpBinaryStatus(options: {
    agentType: string;
    timeoutMs?: number;
  }): Promise<MachineAcpBinaryStatusResponse | null> {
    return (await this.sendRequest({
      method: 'machine/acp-binary-status',
      timeoutMs: options.timeoutMs ?? 30_000,
      params: {
        agentType: options.agentType,
      },
    })) as MachineAcpBinaryStatusResponse | null;
  }

  async requestMachineAcpBinaryInstall(options: {
    agentType: string;
    onProgress?: (message: MachineAcpBinaryProgressMessage) => void;
    timeoutMs?: number;
  }): Promise<MachineAcpBinaryInstallResponse | null> {
    return (await this.sendRequest({
      method: 'machine/acp-binary-install',
      timeoutMs: options.timeoutMs ?? 300_000,
      onAcpBinaryProgress: options.onProgress,
      params: {
        agentType: options.agentType,
      },
    })) as MachineAcpBinaryInstallResponse | null;
  }

  async requestMachineBugReport(options: {
    description: string;
    reporterUserId: string;
    requestToken: string;
    timeoutMs?: number;
  }): Promise<MachineBugReportResponse | null> {
    return (await this.sendRequest({
      method: 'machine/bug-report',
      timeoutMs: options.timeoutMs ?? 120_000,
      params: {
        description: options.description,
        reporterUserId: options.reporterUserId,
        requestToken: options.requestToken,
      },
    })) as MachineBugReportResponse | null;
  }

  async requestSessionCancel(options: {
    sessionId: SessionId;
    turnId: string;
    timeoutMs?: number;
  }): Promise<SessionCancelResponse | null> {
    const result = await this.sendRequest({
      method: 'session/cancel',
      timeoutMs: options.timeoutMs ?? 2_000,
      params: {
        sessionId: options.sessionId,
        turnId: options.turnId,
      },
    });
    return result as SessionCancelResponse | null;
  }

  async requestSessionLiveStatus(options: {
    sessionId: string;
    timeoutMs?: number;
  }): Promise<LoroSessionLiveStatusRpcResponse | null> {
    return (await this.sendRequest({
      method: 'session/live-status',
      timeoutMs: options.timeoutMs ?? 10_000,
      params: { sessionId: options.sessionId },
    })) as LoroSessionLiveStatusRpcResponse | null;
  }

  async requestSessionSteer(options: {
    sessionId: string;
    expectedTurnId: string;
    userTurnId: string;
    userId: string;
    timestamp: string;
    inputConfig: SessionTurnInputConfig;
    timeoutMs?: number;
  }): Promise<SessionSteerResponse | null> {
    return (await this.sendRequest({
      method: 'session/steer',
      timeoutMs: options.timeoutMs ?? 5_000,
      params: {
        sessionId: options.sessionId,
        expectedTurnId: options.expectedTurnId,
        userTurnId: options.userTurnId,
        userId: options.userId,
        timestamp: options.timestamp,
        inputConfig: options.inputConfig,
      },
    })) as SessionSteerResponse | null;
  }

  async requestSessionTerminate(options: {
    sessionId: string;
    timeoutMs?: number;
  }): Promise<SessionTerminateResponse | null> {
    const result = await this.sendRequest({
      method: 'session/terminate',
      timeoutMs: options.timeoutMs ?? 30_000,
      params: { sessionId: options.sessionId },
    });
    return result as SessionTerminateResponse | null;
  }

  async requestSessionFork(
    options: SessionForkSpec & { timeoutMs?: number }
  ): Promise<SessionForkResponse | null> {
    return (await this.sendRequest({
      method: 'session/fork',
      timeoutMs: options.timeoutMs ?? 120_000,
      params: {
        sourceSessionId: options.sourceSessionId,
        sourceTurnId: options.sourceTurnId,
        targetSessionId: options.targetSessionId,
        requestedByUserId: options.requestedByUserId,
        targetContext: options.targetContext,
        targetPlacement: options.targetPlacement,
      },
    })) as SessionForkResponse | null;
  }

  async requestSessionEditAndResend(
    options: SessionEditAndResendSpec & { timeoutMs?: number }
  ): Promise<SessionEditAndResendResponse | null> {
    return (await this.sendRequest({
      method: 'session/edit-and-resend',
      timeoutMs: options.timeoutMs ?? 120_000,
      params: {
        sessionId: options.sessionId,
        expectedUserTurnId: options.expectedUserTurnId,
        replacementUserTurnId: options.replacementUserTurnId,
        requestedByUserId: options.requestedByUserId,
        timestamp: options.timestamp,
        inputConfig: options.inputConfig,
      },
    })) as SessionEditAndResendResponse | null;
  }

  /**
   * Fast-path push of a user turn to the machine. The short default timeout
   * doubles as the request `expiresAt`, bounding how long a machine restart
   * can replay this dispatch from the request stream. `null` means no ACK
   * arrived in time — the caller falls back to the CRDT dispatch path.
   */
  async requestSessionDispatchTurn(options: {
    sessionId: SessionId;
    userTurnId: string;
    userId: string;
    timestamp: string;
    inputConfig: SessionTurnInputConfig;
    timeoutMs?: number;
  }): Promise<SessionDispatchTurnResponse | null> {
    return (await this.sendRequest({
      method: 'session/dispatch-turn',
      timeoutMs: options.timeoutMs ?? 15_000,
      params: {
        sessionId: options.sessionId,
        userTurnId: options.userTurnId,
        userId: options.userId,
        timestamp: options.timestamp,
        inputConfig: options.inputConfig,
      },
    })) as SessionDispatchTurnResponse | null;
  }

  async requestSessionPrepare(
    options: SessionPreparationSpec & { timeoutMs?: number }
  ): Promise<SessionPrepareResponse | null> {
    return (await this.sendRequest({
      method: 'session/prepare',
      timeoutMs: options.timeoutMs ?? 5_000,
      params: {
        preparationId: options.preparationId,
        sessionId: options.sessionId,
        requestedByUserId: options.requestedByUserId,
        agentConfigId: options.agentConfigId,
        cliType: options.cliType,
        agentType: options.agentType,
        project: options.project,
      },
    })) as SessionPrepareResponse | null;
  }

  async requestSessionPrepareCancel(
    options: SessionPreparationCancelSpec & { timeoutMs?: number }
  ): Promise<SessionPrepareCancelResponse | null> {
    return (await this.sendRequest({
      method: 'session/prepare-cancel',
      timeoutMs: options.timeoutMs ?? 5_000,
      params: {
        preparationId: options.preparationId,
        sessionId: options.sessionId,
        requestedByUserId: options.requestedByUserId,
      },
    })) as SessionPrepareCancelResponse | null;
  }

  async requestCodeCollabOpenText(
    options: CodeCollabV2OpenTextRequest & { ownerSessionId?: string; timeoutMs?: number }
  ): Promise<CodeCollabV2OpenTextOk | CodeCollabV2Error | null> {
    return (await this.sendRequest({
      method: 'code-collab/open-text',
      timeoutMs: options.timeoutMs ?? 30_000,
      ownerSessionId: options.ownerSessionId ?? options.sessionId,
      params: {
        sessionId: options.sessionId,
        path: options.path,
      },
    })) as CodeCollabV2OpenTextOk | CodeCollabV2Error | null;
  }

  /**
   * File Preview v3. One call covers first read and revalidation, and never
   * activates Code Collab on the machine.
   */
  async requestFilePreview(
    options: Omit<FilePreviewV3Request, 'v'> & { ownerSessionId?: string; timeoutMs?: number }
  ): Promise<FilePreviewV3Response | null> {
    return (await this.sendRequest({
      method: 'file/preview',
      timeoutMs: options.timeoutMs ?? 30_000,
      ownerSessionId: options.ownerSessionId ?? options.sessionId,
      params: {
        v: FILE_PREVIEW_PROTOCOL_VERSION,
        sessionId: options.sessionId,
        path: options.path,
        ...(options.knownDigest === undefined ? {} : { knownDigest: options.knownDigest }),
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      },
    })) as FilePreviewV3Response | null;
  }

  async requestCodeCollabRefreshText(
    options: CodeCollabV2RefreshTextRequest & { ownerSessionId?: string; timeoutMs?: number }
  ): Promise<CodeCollabV2RefreshTextResponse | CodeCollabV2Error | null> {
    return (await this.sendRequest({
      method: 'code-collab/refresh-text',
      timeoutMs: options.timeoutMs ?? 30_000,
      ownerSessionId: options.ownerSessionId ?? options.sessionId,
      params: {
        sessionId: options.sessionId,
        path: options.path,
        digest: options.digest,
      },
    })) as CodeCollabV2RefreshTextResponse | CodeCollabV2Error | null;
  }

  async requestCodeCollabSaveText(
    options: CodeCollabV2SaveTextRequest & { ownerSessionId?: string; timeoutMs?: number }
  ): Promise<CodeCollabV2SaveTextResponse | CodeCollabV2Error | null> {
    return (await this.sendRequest({
      method: 'code-collab/save-text',
      timeoutMs: options.timeoutMs ?? 30_000,
      ownerSessionId: options.ownerSessionId ?? options.sessionId,
      params: {
        sessionId: options.sessionId,
        requestedByUserId: options.requestedByUserId,
        path: options.path,
        baseDigest: options.baseDigest,
        text: options.text,
        ...(options.format === undefined ? {} : { format: options.format }),
      },
    })) as CodeCollabV2SaveTextResponse | CodeCollabV2Error | null;
  }

  async requestCodeCollabOpenCurrentDiff(
    options: CodeCollabV2OpenCurrentDiffRequest & { ownerSessionId?: string; timeoutMs?: number }
  ): Promise<CodeCollabV2OpenCurrentDiffResponse | CodeCollabV2Error | null> {
    return (await this.sendRequest({
      method: 'code-collab/open-current-diff',
      timeoutMs: options.timeoutMs ?? 30_000,
      ownerSessionId: options.ownerSessionId ?? options.sessionId,
      params: {
        sessionId: options.sessionId,
        path: options.path,
      },
    })) as CodeCollabV2OpenCurrentDiffResponse | CodeCollabV2Error | null;
  }

  async requestCodeCollabOpenAllChangesDiff(
    options: CodeCollabV2OpenAllChangesDiffRequest & { ownerSessionId?: string; timeoutMs?: number }
  ): Promise<CodeCollabV2OpenAllChangesDiffResponse | CodeCollabV2Error | null> {
    return (await this.sendRequest({
      method: 'code-collab/open-all-changes-diff',
      timeoutMs: options.timeoutMs ?? 30_000,
      ownerSessionId: options.ownerSessionId ?? options.sessionId,
      params: {
        sessionId: options.sessionId,
        ...(options.focusPath === undefined ? {} : { focusPath: options.focusPath }),
      },
    })) as CodeCollabV2OpenAllChangesDiffResponse | CodeCollabV2Error | null;
  }

  async requestCodeCollabOpenTurnDiff(
    options: CodeCollabV2OpenTurnDiffRequest & { ownerSessionId?: string; timeoutMs?: number }
  ): Promise<CodeCollabV2OpenTurnDiffResponse | CodeCollabV2Error | null> {
    return (await this.sendRequest({
      method: 'code-collab/open-turn-diff',
      timeoutMs: options.timeoutMs ?? 30_000,
      ownerSessionId: options.ownerSessionId ?? options.sessionId,
      params: {
        sessionId: options.sessionId,
        turnId: options.turnId,
        path: options.path,
      },
    })) as CodeCollabV2OpenTurnDiffResponse | CodeCollabV2Error | null;
  }

  async requestCodeCollabInitDirectory(
    options: CodeCollabV2InitDirectoryRequest & { ownerSessionId?: string; timeoutMs?: number }
  ): Promise<CodeCollabV2InitDirectoryOk | CodeCollabV2Error | null> {
    return (await this.sendRequest({
      method: 'code-collab/init-directory',
      timeoutMs: options.timeoutMs ?? 30_000,
      ownerSessionId: options.ownerSessionId ?? options.sessionId,
      params: {
        sessionId: options.sessionId,
        path: options.path,
      },
    })) as CodeCollabV2InitDirectoryOk | CodeCollabV2Error | null;
  }

  async requestCodeCollabLspDefinition(options: {
    sessionId: string;
    path: string;
    line?: number;
    character?: number;
    ownerSessionId?: string;
    timeoutMs?: number;
  }): Promise<CodeCollabV2LspUnsupported | CodeCollabV2Error | null> {
    return (await this.sendRequest({
      method: 'code-collab/lsp-definition',
      timeoutMs: options.timeoutMs ?? 30_000,
      ownerSessionId: options.ownerSessionId ?? options.sessionId,
      params: {
        sessionId: options.sessionId,
        path: options.path,
        ...(options.line === undefined ? {} : { line: options.line }),
        ...(options.character === undefined ? {} : { character: options.character }),
      },
    })) as CodeCollabV2LspUnsupported | CodeCollabV2Error | null;
  }

  async requestCodeCollabLspReferences(options: {
    sessionId: string;
    path: string;
    line?: number;
    character?: number;
    ownerSessionId?: string;
    timeoutMs?: number;
  }): Promise<CodeCollabV2LspUnsupported | CodeCollabV2Error | null> {
    return (await this.sendRequest({
      method: 'code-collab/lsp-references',
      timeoutMs: options.timeoutMs ?? 30_000,
      ownerSessionId: options.ownerSessionId ?? options.sessionId,
      params: {
        sessionId: options.sessionId,
        path: options.path,
        ...(options.line === undefined ? {} : { line: options.line }),
        ...(options.character === undefined ? {} : { character: options.character }),
      },
    })) as CodeCollabV2LspUnsupported | CodeCollabV2Error | null;
  }

  async requestSessionPreviewCreate(options: {
    sessionId: string;
    requestedByUserId: string;
    target: PreviewTarget;
    approval: PreviewTargetApproval;
    replaceExisting?: boolean;
    timeoutMs?: number;
  }): Promise<SessionPreviewCreateResponse | null> {
    return (await this.sendRequest({
      method: 'session/preview-create',
      timeoutMs: options.timeoutMs ?? 30_000,
      params: {
        sessionId: options.sessionId,
        requestedByUserId: options.requestedByUserId,
        target: options.target,
        approval: options.approval,
        replaceExisting: options.replaceExisting,
      },
    })) as SessionPreviewCreateResponse | null;
  }

  async requestSessionPreviewRevoke(options: {
    sessionId: string;
    requestedByUserId: string;
    reason?: string;
    timeoutMs?: number;
  }): Promise<SessionPreviewRevokeResponse | null> {
    return (await this.sendRequest({
      method: 'session/preview-revoke',
      timeoutMs: options.timeoutMs ?? 30_000,
      params: {
        sessionId: options.sessionId,
        requestedByUserId: options.requestedByUserId,
        reason: options.reason,
      },
    })) as SessionPreviewRevokeResponse | null;
  }

  async requestLocalProjectGitState(options: {
    localProjectId: LocalProjectId;
    requestedByUserId: string;
    timeoutMs?: number;
  }): Promise<LocalProjectGitStateRpcResponse | null> {
    return (await this.sendRequest({
      method: 'local-project/git-state',
      timeoutMs: options.timeoutMs ?? 30_000,
      params: {
        localProjectId: options.localProjectId,
        requestedByUserId: options.requestedByUserId,
      },
    })) as LocalProjectGitStateRpcResponse | null;
  }

  async requestLocalProjectControl(options: {
    request: LocalProjectControlRequest;
    timeoutMs?: number;
  }): Promise<LocalProjectControlResponse | null> {
    return (await this.sendRequest({
      method: 'local-project/control',
      timeoutMs: options.timeoutMs ?? 120_000,
      params: {
        request: options.request,
      },
    })) as LocalProjectControlResponse | null;
  }

  private async appendMachineAcpCapabilitiesRefreshCancel(requestId: string): Promise<void> {
    const now = Math.round(this.options.now?.() ?? Date.now());
    const request: LoroStreamsRpcRequest = {
      jsonrpc: JSON_RPC_VERSION,
      id: crypto.randomUUID(),
      method: 'machine/acp-capabilities-refresh-cancel',
      rpcVersion: this.options.rpcVersion ?? LORO_STREAMS_RPC_VERSION,
      machineId: this.options.machineId,
      workspaceId: this.options.workspaceId,
      replyTo: this.responseDispatcher.getResponseStreamId(),
      sentAt: now,
      expiresAt: now + 30_000,
      params: { requestId },
    };
    await this.options.streamClient.appendJson(this.requestStreamId, request);
  }

  private async sendRequest(
    args:
      | {
          method: 'machine/status';
          timeoutMs: number;
          params: {};
        }
      | {
          method: 'machine/ping';
          timeoutMs: number;
          params: {
            requestId: string;
          };
        }
      | {
          method: 'machine/restart';
          timeoutMs: number;
          params: {
            requesterUserId: string;
            requestToken: string;
            requestId: string;
          };
        }
      | {
          method: 'machine/upgrade';
          timeoutMs: number;
          params: {
            requesterUserId: string;
            requestToken: string;
            requestId: string;
            targetVersion?: string;
          };
        }
      | {
          method: 'machine/acp-capabilities-refresh';
          timeoutMs: number;
          onAcpBinaryProgress?: (message: MachineAcpBinaryProgressMessage) => void;
          signal?: AbortSignal;
          params: {
            configId: AgentConfigId;
          };
        }
      | {
          method: 'machine/acp-authenticate';
          timeoutMs: number;
          onAcpAuthenticationProgress?: (message: MachineAcpAuthenticationProgressMessage) => void;
          params:
            | { requestId: string; action: 'start'; configId: AgentConfigId }
            | { requestId: string; action: 'cancel'; authenticationRequestId: string }
            | {
                requestId: string;
                action: 'submit-code';
                authenticationRequestId: string;
                authorizationCodeEnvelope: RpcSecretEnvelope;
              }
            | {
                requestId: string;
                action: 'submit-input';
                authenticationRequestId: string;
                interactionId: string;
                authenticationInputEnvelope: RpcSecretEnvelope;
              };
        }
      | {
          method: 'machine/acp-binary-status';
          timeoutMs: number;
          params: {
            agentType: string;
          };
        }
      | {
          method: 'machine/acp-binary-install';
          timeoutMs: number;
          onAcpBinaryProgress?: (message: MachineAcpBinaryProgressMessage) => void;
          params: {
            agentType: string;
          };
        }
      | {
          method: 'machine/bug-report';
          timeoutMs: number;
          params: {
            description: string;
            reporterUserId: string;
            requestToken: string;
          };
        }
      | {
          method: 'session/cancel';
          timeoutMs: number;
          params: {
            sessionId: SessionId;
            turnId: string;
          };
        }
      | {
          method: 'session/live-status';
          timeoutMs: number;
          params: {
            sessionId: string;
          };
        }
      | {
          method: 'session/steer';
          timeoutMs: number;
          params: {
            sessionId: string;
            expectedTurnId: string;
            userTurnId: string;
            userId: string;
            timestamp: string;
            inputConfig: SessionTurnInputConfig;
          };
        }
      | {
          method: 'session/terminate';
          timeoutMs: number;
          params: {
            sessionId: string;
          };
        }
      | {
          method: 'session/fork';
          timeoutMs: number;
          params: SessionForkSpec;
        }
      | {
          method: 'session/edit-and-resend';
          timeoutMs: number;
          params: SessionEditAndResendSpec;
        }
      | {
          method: 'session/dispatch-turn';
          timeoutMs: number;
          params: {
            sessionId: SessionId;
            userTurnId: string;
            userId: string;
            timestamp: string;
            inputConfig: SessionTurnInputConfig;
          };
        }
      | {
          method: 'session/prepare';
          timeoutMs: number;
          params: SessionPreparationSpec;
        }
      | {
          method: 'session/prepare-cancel';
          timeoutMs: number;
          params: SessionPreparationCancelSpec;
        }
      | {
          method: 'code-collab/open-text';
          timeoutMs: number;
          ownerSessionId: string;
          params: CodeCollabV2OpenTextRequest;
        }
      | {
          method: 'code-collab/refresh-text';
          timeoutMs: number;
          ownerSessionId: string;
          params: CodeCollabV2RefreshTextRequest;
        }
      | {
          method: 'code-collab/save-text';
          timeoutMs: number;
          ownerSessionId: string;
          params: CodeCollabV2SaveTextRequest;
        }
      | {
          method: 'code-collab/open-current-diff';
          timeoutMs: number;
          ownerSessionId: string;
          params: CodeCollabV2OpenCurrentDiffRequest;
        }
      | {
          method: 'code-collab/open-all-changes-diff';
          timeoutMs: number;
          ownerSessionId: string;
          params: CodeCollabV2OpenAllChangesDiffRequest;
        }
      | {
          method: 'code-collab/open-turn-diff';
          timeoutMs: number;
          ownerSessionId: string;
          params: CodeCollabV2OpenTurnDiffRequest;
        }
      | {
          method: 'code-collab/init-directory';
          timeoutMs: number;
          ownerSessionId: string;
          params: CodeCollabV2InitDirectoryRequest;
        }
      | {
          method: 'code-collab/lsp-definition' | 'code-collab/lsp-references';
          timeoutMs: number;
          ownerSessionId: string;
          params: {
            sessionId: string;
            path: string;
            line?: number;
            character?: number;
          };
        }
      | {
          method: 'file/preview';
          timeoutMs: number;
          ownerSessionId: string;
          params: FilePreviewV3Request;
        }
      | {
          method: 'session/preview-create';
          timeoutMs: number;
          params: {
            sessionId: string;
            requestedByUserId: string;
            target: PreviewTarget;
            approval: PreviewTargetApproval;
            replaceExisting?: boolean;
          };
        }
      | {
          method: 'session/preview-revoke';
          timeoutMs: number;
          params: {
            sessionId: string;
            requestedByUserId: string;
            reason?: string;
          };
        }
      | {
          method: 'local-project/git-state';
          timeoutMs: number;
          params: {
            localProjectId: LocalProjectId;
            requestedByUserId: string;
          };
        }
      | {
          method: 'local-project/control';
          timeoutMs: number;
          params: {
            request: LocalProjectControlRequest;
          };
        }
  ): Promise<LoroMachineRpcResult | null> {
    if (this.stopped) return null;
    await this.start();
    if (this.stopped) return null;

    const abortSignal =
      args.method === 'machine/acp-capabilities-refresh' ? args.signal : undefined;
    if (abortSignal?.aborted) return null;

    const requestId = crypto.randomUUID();
    const timeoutMs = Math.max(0, args.timeoutMs);
    const now = Math.round(this.options.now?.() ?? Date.now());
    const startedAtMs = Date.now();
    const traceContext = this.machineRpcTraceContext(args, requestId, startedAtMs);
    const codeCollabOwnerSessionId =
      args.method === 'code-collab/open-text' ||
      args.method === 'code-collab/refresh-text' ||
      args.method === 'code-collab/save-text' ||
      args.method === 'code-collab/open-current-diff' ||
      args.method === 'code-collab/open-all-changes-diff' ||
      args.method === 'code-collab/open-turn-diff' ||
      args.method === 'code-collab/init-directory' ||
      args.method === 'code-collab/lsp-definition' ||
      args.method === 'code-collab/lsp-references' ||
      args.method === 'file/preview'
        ? args.ownerSessionId
        : undefined;
    this.options.trace?.('machine rpc transport request start', traceContext);
    const promise = this.responseDispatcher.registerPending(requestId, {
      ownerId: this.pendingOwnerId,
      machineId: this.options.machineId,
      method: args.method,
      timeoutMs,
      refreshContext:
        args.method === 'machine/acp-capabilities-refresh'
          ? {
              configId: args.params.configId,
              cliType: 'builtin',
              agentType: 'unknown',
            }
          : undefined,
      pingContext:
        args.method === 'machine/ping' ? { requestId: args.params.requestId } : undefined,
      lifecycleContext:
        args.method === 'machine/upgrade'
          ? { requestId: args.params.requestId, targetVersion: args.params.targetVersion }
          : args.method === 'machine/restart'
            ? { requestId: args.params.requestId }
            : undefined,
      binaryContext:
        args.method === 'machine/acp-authenticate'
          ? { agentType: 'unknown', requestId: args.params.requestId }
          : args.method === 'machine/acp-binary-status' ||
              args.method === 'machine/acp-binary-install'
            ? { agentType: args.params.agentType }
            : undefined,
      cancelContext:
        args.method === 'session/cancel' ||
        args.method === 'session/live-status' ||
        args.method === 'session/terminate'
          ? { sessionId: args.params.sessionId }
          : undefined,
      forkContext:
        args.method === 'session/fork'
          ? {
              sourceSessionId: args.params.sourceSessionId,
              targetSessionId: args.params.targetSessionId,
            }
          : undefined,
      editAndResendContext:
        args.method === 'session/edit-and-resend'
          ? {
              sessionId: args.params.sessionId,
              replacementUserTurnId: args.params.replacementUserTurnId,
            }
          : undefined,
      steerContext:
        args.method === 'session/steer'
          ? { sessionId: args.params.sessionId, userTurnId: args.params.userTurnId }
          : undefined,
      dispatchContext:
        args.method === 'session/dispatch-turn'
          ? { sessionId: args.params.sessionId, userTurnId: args.params.userTurnId }
          : undefined,
      preparationContext:
        args.method === 'session/prepare' || args.method === 'session/prepare-cancel'
          ? {
              preparationId: args.params.preparationId,
              sessionId: args.params.sessionId,
            }
          : undefined,
      previewContext:
        args.method === 'session/preview-create' || args.method === 'session/preview-revoke'
          ? { sessionId: args.params.sessionId }
          : undefined,
      localProjectContext:
        args.method === 'local-project/git-state'
          ? { workspaceId: this.options.workspaceId, localProjectId: args.params.localProjectId }
          : args.method === 'local-project/control'
            ? { type: args.params.request.type }
            : undefined,
      codeCollabOwnerSessionId,
      onAcpBinaryProgress:
        args.method === 'machine/acp-capabilities-refresh' ||
        args.method === 'machine/acp-binary-install'
          ? args.onAcpBinaryProgress
          : undefined,
      onAcpAuthenticationProgress:
        args.method === 'machine/acp-authenticate' ? args.onAcpAuthenticationProgress : undefined,
      startedAtMs,
    });

    let requestAppended = false;
    let cancellationRequested = false;
    let cancellationAppended = false;
    const appendCancellation = (): void => {
      if (cancellationAppended) return;
      cancellationAppended = true;
      void this.appendMachineAcpCapabilitiesRefreshCancel(requestId).catch(() => undefined);
    };
    const handleAbort = (): void => {
      const pending = this.responseDispatcher.takePending(requestId);
      if (!pending) return;
      cancellationRequested = true;
      pending.resolve(null);
      if (requestAppended) {
        appendCancellation();
      }
    };
    abortSignal?.addEventListener('abort', handleAbort, { once: true });
    if (abortSignal?.aborted) {
      handleAbort();
    }

    try {
      if (cancellationRequested) {
        return await promise;
      }
      const envelope = {
        jsonrpc: JSON_RPC_VERSION,
        id: requestId,
        rpcVersion: this.options.rpcVersion ?? LORO_STREAMS_RPC_VERSION,
        machineId: this.options.machineId,
        workspaceId: this.options.workspaceId,
        replyTo: this.responseDispatcher.getResponseStreamId(),
        sentAt: now,
        expiresAt: now + timeoutMs,
      } as const;
      // Discriminated-union narrowing happens per case so the literal `method`/`params`
      // pair stays type-safe against future method additions.
      let request: LoroStreamsRpcRequest;
      switch (args.method) {
        case 'machine/status':
          request = { ...envelope, method: args.method, params: {} };
          break;
        case 'machine/ping':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'machine/restart':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'machine/upgrade':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'machine/acp-capabilities-refresh':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'machine/acp-authenticate':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'machine/acp-binary-status':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'machine/acp-binary-install':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'machine/bug-report':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'session/cancel':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'session/live-status':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'session/steer':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'session/terminate':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'session/fork':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'session/edit-and-resend':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'session/dispatch-turn':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'session/prepare':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'session/prepare-cancel':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'code-collab/open-text':
          request = {
            ...envelope,
            method: args.method,
            params: await encryptCodeCollabV2RpcPayload(args.ownerSessionId, args.params),
          };
          break;
        case 'code-collab/refresh-text':
          request = {
            ...envelope,
            method: args.method,
            params: await encryptCodeCollabV2RpcPayload(args.ownerSessionId, args.params),
          };
          break;
        case 'code-collab/save-text':
          request = {
            ...envelope,
            method: args.method,
            params: await encryptCodeCollabV2RpcPayload(args.ownerSessionId, args.params),
          };
          break;
        case 'code-collab/open-current-diff':
          request = {
            ...envelope,
            method: args.method,
            params: await encryptCodeCollabV2RpcPayload(args.ownerSessionId, args.params),
          };
          break;
        case 'code-collab/open-all-changes-diff':
          request = {
            ...envelope,
            method: args.method,
            params: await encryptCodeCollabV2RpcPayload(args.ownerSessionId, args.params),
          };
          break;
        case 'code-collab/open-turn-diff':
          request = {
            ...envelope,
            method: args.method,
            params: await encryptCodeCollabV2RpcPayload(args.ownerSessionId, args.params),
          };
          break;
        case 'code-collab/init-directory':
          request = {
            ...envelope,
            method: args.method,
            params: await encryptCodeCollabV2RpcPayload(args.ownerSessionId, args.params),
          };
          break;
        case 'code-collab/lsp-definition':
          request = {
            ...envelope,
            method: args.method,
            params: await encryptCodeCollabV2RpcPayload(args.ownerSessionId, args.params),
          };
          break;
        case 'code-collab/lsp-references':
          request = {
            ...envelope,
            method: args.method,
            params: await encryptCodeCollabV2RpcPayload(args.ownerSessionId, args.params),
          };
          break;
        case 'file/preview':
          request = {
            ...envelope,
            method: args.method,
            params: await encryptCodeCollabV2RpcPayload(args.ownerSessionId, args.params),
          };
          break;
        case 'session/preview-create':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'session/preview-revoke':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'local-project/git-state':
          request = { ...envelope, method: args.method, params: args.params };
          break;
        case 'local-project/control':
          request = { ...envelope, method: args.method, params: args.params };
          break;
      }

      const appendStartedAtMs = Date.now();
      this.options.trace?.('machine rpc transport append start', {
        ...traceContext,
        elapsedMs: appendStartedAtMs - startedAtMs,
        requestStreamId: this.requestStreamId,
        responseStreamId: this.responseDispatcher.getResponseStreamId(),
      });
      const appendPromise = (async () => {
        await this.options.streamClient.appendJson(this.requestStreamId, request);
        requestAppended = true;
        this.responseDispatcher.markAppendFinished(requestId);
        if (cancellationRequested) {
          appendCancellation();
        }
        this.options.trace?.('machine rpc transport append finished', {
          ...traceContext,
          durationMs: Date.now() - appendStartedAtMs,
          elapsedMs: Date.now() - startedAtMs,
          requestStreamId: this.requestStreamId,
          responseStreamId: this.responseDispatcher.getResponseStreamId(),
        });
      })();
      const firstSettled = await Promise.race([
        appendPromise.then(() => ({ type: 'append' as const })),
        promise.then((result) => ({ type: 'response' as const, result })),
      ]);
      if (firstSettled.type === 'response') {
        if (firstSettled.result === null && args.method === 'machine/acp-capabilities-refresh') {
          cancellationRequested = true;
          if (requestAppended) {
            appendCancellation();
          }
        }
        void appendPromise.catch((error: unknown) => {
          this.options.trace?.('machine rpc transport late append failed', {
            ...traceContext,
            elapsedMs: Date.now() - startedAtMs,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        return firstSettled.result;
      }

      const result = await promise;
      if (
        result === null &&
        requestAppended &&
        args.method === 'machine/acp-capabilities-refresh'
      ) {
        cancellationRequested = true;
        appendCancellation();
      }
      return result;
    } catch (error) {
      const pending = this.responseDispatcher.takePending(requestId);
      if (!pending) {
        return null;
      }

      const isMissingRequestStream =
        error instanceof LoroStreamsGatewayError && error.status === 404;
      const message = isMissingRequestStream
        ? 'Machine RPC request stream is missing; the CLI is not accepting RPC requests.'
        : error instanceof Error
          ? error.message
          : String(error);
      this.options.trace?.('machine rpc transport request failed', {
        ...traceContext,
        elapsedMs: Date.now() - startedAtMs,
        message,
      });
      const errorResponse = toLegacyRpcErrorResponse(
        args.method,
        this.options.machineId,
        {
          code: isMissingRequestStream ? 'machine_rpc_unavailable' : 'request_failed',
          message,
        },
        pending.refreshContext,
        pending.pingContext,
        pending.lifecycleContext,
        pending.binaryContext,
        pending.cancelContext,
        pending.forkContext,
        pending.editAndResendContext,
        pending.steerContext,
        pending.previewContext,
        pending.localProjectContext,
        pending.dispatchContext,
        pending.preparationContext
      );
      pending.resolve(errorResponse);
      return errorResponse;
    } finally {
      abortSignal?.removeEventListener('abort', handleAbort);
    }
  }

  private machineRpcTraceContext(
    args: {
      readonly method: LoroStreamsRpcMethod;
      readonly timeoutMs: number;
      readonly params: unknown;
    },
    rpcRequestId: string,
    startedAtMs: number
  ): Record<string, unknown> {
    return {
      workspaceId: this.options.workspaceId,
      machineId: this.options.machineId,
      method: args.method,
      rpcRequestId,
      timeoutMs: args.timeoutMs,
      startedAtMs,
      responseStreamId: this.responseDispatcher.getResponseStreamId(),
    };
  }
}
