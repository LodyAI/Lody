import {
  machineSupportsAndroidEmulatorProtocol,
  AndroidEmulatorResponseSchema,
  type AndroidEmulatorCommand,
  type AndroidEmulatorResponse,
} from '@lody/shared';
import { type FileDownloadRequest, type FileDownloadResponse } from '@lody/shared';
import {
  FilePreviewV3ResponseSchema,
  MAIN_SESSION_FILE_ROOT_ID,
  MemoryProviderResponseSchema,
  ProjectProbeLocalMemberResultSchema,
  machineSupportsBugReportClientLog,
  machineSupportsMemoryProviders,
  type BugReportClientLog,
  type MemoryProviderRequest,
  type MemoryProviderResponse,
  type ProjectProbeLocalMemberResult,
} from '@lody/shared';
import { createRpcSecretRecipient } from '@lody/loro-streams-rpc';
import type { PreviewControlOperation } from '@lody/shared';
import { mintPreviewControlProof } from '@/lib/preview-control-api';
import type { LocalFilePreviewResource } from '@lody/shared/local-file-preview';
import type {
  LoroStreamsMachineRpcClient,
  LocalProjectGitStateRpcResponse,
} from '@lody/loro-streams-rpc';
import {
  McpToolListResultSchema,
  McpAuthenticationResultSchema,
  MCP_LOCAL_AUTHENTICATION_PROTOCOL_VERSION,
  MACHINE_PROTOCOL_CAPABILITIES,
  MCP_TOOL_DISCOVERY_PROTOCOL_VERSION,
  machineSupportsProtocolCapability,
  type WorkspaceMcpServerMeta,
  DEFAULT_PREVIEW_CREATE_TIMEOUT_MS,
  getServerNow,
  machineSupportsPiExtensions,
  machineSupportsSubagentCancellation,
  machineSupportsIosSimulatorProtocol,
  machineSupportsPreviewControlProtocol,
  IosSimulatorResponseSchema,
  type IosSimulatorCommand,
  type IosSimulatorResponse,
  machineSupportsSessionHistoryProtocol,
  type MachineProtocolCapabilities,
  type AgentConfigId,
  type CodeCollabRole,
  type CodeCollabV2Error,
  type CodeCollabV2FileIndexRequest,
  type CodeCollabV2FileIndexSnapshot,
  type CodeCollabV2InitDirectoryOk,
  type CodeCollabV2InitDirectoryRequest,
  type CodeCollabV2LspUnsupported,
  type CodeCollabV2OpenAllChangesDiffRequest,
  type CodeCollabV2OpenAllChangesDiffResponse,
  type CodeCollabV2OpenCurrentDiffRequest,
  type CodeCollabV2OpenCurrentDiffResponse,
  type CodeCollabV2OpenTextOk,
  type CodeCollabV2OpenTextRequest,
  type CodeCollabV2OpenTurnDiffRequest,
  type CodeCollabV2OpenTurnDiffResponse,
  type CodeCollabV2RefreshTextRequest,
  type CodeCollabV2RefreshTextResponse,
  type CodeCollabV2SaveTextRequest,
  type CodeCollabV2SaveTextResponse,
  type FilePreviewV3Request,
  type FilePreviewV3Response,
  FILE_PREVIEW_PROTOCOL_VERSION,
  filePreviewV3Error,
  type LocalMachineRpcRequest,
  type LocalMachineRpcResult,
  type LocalProjectControlRequest,
  type LocalProjectControlResponse,
  type LocalProjectId,
  type MachineBugReportResponse,
  type MachineId,
  type MachinePiExtensionsResponse,
  type SendLocalMachineRpcResult,
  type SessionCancelResponse,
  type SessionDispatchTurnResponse,
  type SessionId,
  type SessionPreviewCreateResponse,
  type SessionPreviewEndpointAcquireResponse,
  type SessionPreviewEndpointReleaseResponse,
  type SessionPreviewRevokeResponse,
  type SessionPreviewStatusResponse,
  type PreviewTarget,
  type PreviewTargetApproval,
  type SessionSteerResponse,
  type SessionGoalAction,
  type SessionGoalResponse,
  type SessionTerminateResponse,
  type SessionForkResponse,
  type SessionForkSpec,
  type SessionEditAndResendResponse,
  type SessionEditAndResendSpec,
  type SessionTurnInputConfig,
  type SessionHistoryReadResponse,
  type SessionHistoryReadQuery,
  type SessionHistoryWriteOperation,
  type SessionHistoryWriteResponse,
  type WorkspaceId,
  sessionForkFailure,
  sessionEditAndResendFailure,
} from '@lody/shared';
import { createAsyncConcurrencyGate } from '@/lib/async-concurrency-gate';
import {
  protectedFileWriteDeniedMessage,
  protectedPreviewControlDeniedMessage,
  workspaceFeatureUnavailableMessage,
} from '@/lib/workspace-feature';
import { isE2eeReadQuery } from '@lody/shared/e2ee-rpc';
import { getIpcServices } from '@/lib/electron-ipc-client';
import type { WorkspaceTargetRouter } from './workspace-target-router';

const LOCAL_MACHINE_ID_READY_TIMEOUT_MS = 2_000;
const CODE_COLLAB_DIFF_RPC_CONCURRENCY_LIMIT = 4;

type LocalMachineRpcSender = (
  message: LocalMachineRpcRequest
) => Promise<SendLocalMachineRpcResult>;

type CodeCollabRequestOptions = {
  timeoutMs?: number;
  ownerSessionId?: SessionId | string;
};

type LspRequest = {
  readonly sessionId: SessionId;
  readonly path: string;
  readonly line?: number;
  readonly character?: number;
};

export type WorkspaceMachineRpcFacadeDeps = {
  waitForContentAdmission?: () => Promise<void>;
  requestEncryptedFeature?: (
    request: LocalMachineRpcRequest
  ) => Promise<import('@lody/shared/local-machine-rpc').LocalMachineRpcResponse>;
  getSessionToken?: () => string | null;
  /** Encrypted content: remote file work uses only `requestEncryptedFeature`, when the host has it. */
  protectedContent?: boolean;
  /** Verified ledger role for display gates; the receiving machine still authorizes every request. */
  protectedCodeCollabRole?: () => CodeCollabRole;
  /** Trusted same-computer control/file surfaces only; never enables network RPC. */
  isLocalControlMachine?: (machineId: MachineId) => boolean;
  workspaceId: WorkspaceId;
  targetRouter: Pick<WorkspaceTargetRouter, 'getPlaneForMachine' | 'resolvePlaneForMachine'>;
  getMachineProtocolCapabilities: (
    machineId: MachineId
  ) => Promise<MachineProtocolCapabilities | undefined>;
  getMachineRpcClient: (machineId: MachineId) => Promise<LoroStreamsMachineRpcClient>;
};

const toCodeCollabTransportError = (error: unknown): CodeCollabV2Error => ({
  status: 'error',
  code: 'transient_io',
  message: error instanceof Error ? error.message : String(error),
  retryable: true,
});

const getPlatformLocalMachineRpcSender = (): LocalMachineRpcSender | undefined =>
  getIpcServices()?.machineRpc.send;

export function createWorkspaceMachineRpcFacade(deps: WorkspaceMachineRpcFacadeDeps) {
  const { workspaceId, targetRouter, getMachineRpcClient } = deps;
  const getLocalMachineRpcSender = (): LocalMachineRpcSender | undefined => {
    const sender = getPlatformLocalMachineRpcSender();
    if (!sender) return undefined;
    return async (request) => {
      await deps.waitForContentAdmission?.();
      return sender(request);
    };
  };
  const codeCollabDiffRpcGate = createAsyncConcurrencyGate(CODE_COLLAB_DIFF_RPC_CONCURRENCY_LIMIT);

  const waitForMachineRoute = async (machineId: MachineId): Promise<void> => {
    await deps.waitForContentAdmission?.();
    if (targetRouter.getPlaneForMachine(machineId) !== null) return;
    try {
      await targetRouter.resolvePlaneForMachine(machineId, {
        timeoutMs: LOCAL_MACHINE_ID_READY_TIMEOUT_MS,
      });
    } catch {
      // Keep cloud RPC as the bounded compatibility fallback while Electron
      // startup is still resolving the local machine identity.
    }
  };

  const resolveMachineTargetPlane = async (
    machineId: MachineId,
    options?: { timeoutMs?: number }
  ): Promise<'local' | 'cloud'> => {
    await deps.waitForContentAdmission?.();
    const existing = targetRouter.getPlaneForMachine(machineId);
    if (existing) return existing;
    return await targetRouter.resolvePlaneForMachine(machineId, {
      timeoutMs: options?.timeoutMs ?? LOCAL_MACHINE_ID_READY_TIMEOUT_MS,
    });
  };

  const canUseLocalMachineRpc = async (machineId: MachineId): Promise<boolean> => {
    await deps.waitForContentAdmission?.();
    if (deps.isLocalControlMachine?.(machineId)) {
      if (typeof window === 'undefined' || !window.__LODY_ELECTRON__ || !getLocalMachineRpcSender())
        throw new Error('Local Machine RPC is not available.');
      return true;
    }
    await waitForMachineRoute(machineId);
    return Boolean(
      typeof window !== 'undefined' &&
      window.__LODY_ELECTRON__ &&
      getLocalMachineRpcSender() &&
      targetRouter.getPlaneForMachine(machineId) === 'local'
    );
  };

  const sendLocalMachineRpcRequest = async (
    request: LocalMachineRpcRequest
  ): Promise<LocalMachineRpcResult | CodeCollabV2Error | null> => {
    await deps.waitForContentAdmission?.();
    const sender = getLocalMachineRpcSender();
    if (!sender) {
      return toCodeCollabTransportError(new Error('Local Machine RPC is not available.'));
    }
    const response = await sender(request);
    if (!response.ok) {
      return toCodeCollabTransportError(new Error(response.error));
    }
    return response.result;
  };

  /** Refuse before signing: a missing host port or a non-writer role cannot become a timeout. */
  const protectedRemoteRefusal = (method: string): CodeCollabV2Error | null => {
    if (!deps.protectedContent) return null;
    if (!deps.requestEncryptedFeature)
      return {
        status: 'error',
        code: 'permission_denied',
        retryable: false,
        message: workspaceFeatureUnavailableMessage('rpc'),
      };
    if (!isE2eeReadQuery(method, undefined) && deps.protectedCodeCollabRole?.() !== 'write')
      return {
        status: 'error',
        code: 'permission_denied',
        retryable: false,
        message: protectedFileWriteDeniedMessage(),
      };
    return null;
  };

  const requestCodeCollab = async <TResult>(
    machineId: MachineId,
    localRequest: LocalMachineRpcRequest,
    cloudRequest: (client: LoroStreamsMachineRpcClient) => Promise<TResult | null>
  ): Promise<TResult | CodeCollabV2Error | null> => {
    try {
      if (await canUseLocalMachineRpc(machineId)) {
        return (await sendLocalMachineRpcRequest(localRequest)) as
          | TResult
          | CodeCollabV2Error
          | null;
      }
      const refusal = protectedRemoteRefusal(localRequest.method);
      if (refusal) return refusal;
      if (deps.requestEncryptedFeature) {
        const response = await deps.requestEncryptedFeature(localRequest);
        if (!response.ok) throw new Error(response.error);
        return response.result as TResult;
      }
      return await cloudRequest(await getMachineRpcClient(machineId));
    } catch (error) {
      return toCodeCollabTransportError(error);
    }
  };

  const ownerSessionFields = (options?: CodeCollabRequestOptions) =>
    options?.ownerSessionId === undefined
      ? {}
      : { ownerSessionId: options.ownerSessionId.toString() };

  const requireSessionHistoryCapability = async (machineId: MachineId): Promise<void> => {
    if (
      !machineSupportsSessionHistoryProtocol({
        protocolCapabilities: await deps.getMachineProtocolCapabilities(machineId),
      })
    ) {
      throw new Error('This machine does not support Roost session history. Update the machine.');
    }
  };

  const requestSessionHistoryRead = async (
    machineId: MachineId,
    sessionId: SessionId,
    query: SessionHistoryReadQuery,
    options?: { timeoutMs?: number }
  ): Promise<SessionHistoryReadResponse> => {
    await requireSessionHistoryCapability(machineId);
    const plane = await resolveMachineTargetPlane(machineId);
    if (plane === 'local') {
      throw new Error('Local Roost history must use the local session control bridge.');
    }
    const response = await (
      await getMachineRpcClient(machineId)
    ).requestSessionHistoryRead({
      sessionId,
      query,
      timeoutMs: options?.timeoutMs ?? 30_000,
    });
    if (!response) throw new Error('Roost session history read request timed out.');
    return response;
  };

  const requestSessionHistoryWrite = async (
    machineId: MachineId,
    args: {
      sessionId: SessionId;
      operation: SessionHistoryWriteOperation;
      payload: Record<string, unknown>;
    },
    options?: { timeoutMs?: number }
  ): Promise<SessionHistoryWriteResponse> => {
    await requireSessionHistoryCapability(machineId);
    const plane = await resolveMachineTargetPlane(machineId);
    if (plane === 'local') {
      throw new Error('Local Roost history must use the local session control bridge.');
    }
    const response = await (
      await getMachineRpcClient(machineId)
    ).requestSessionHistoryWrite({
      ...args,
      timeoutMs: options?.timeoutMs ?? 30_000,
    });
    if (!response) throw new Error('Roost session history write request timed out.');
    return response;
  };

  /**
   * File Preview v3. Its own transport wrapper (rather than `requestCodeCollab`)
   * so a transport failure surfaces as a typed `FilePreviewV3Error` instead of a
   * Code Collab error the preview UI would have to translate.
   */
  const supportsMarkdownLinks = async (machineId: MachineId) =>
    machineSupportsProtocolCapability(
      { protocolCapabilities: await deps.getMachineProtocolCapabilities(machineId) },
      MACHINE_PROTOCOL_CAPABILITIES.markdownFileLinks
    );
  const unsupportedMarkdownLinks = () =>
    filePreviewV3Error('unsupported_protocol', {
      message: 'The agent machine does not support Markdown link resolution.',
      retryable: false,
    });

  const requestFileDownloadChunk = async (
    machineId: MachineId,
    request: FileDownloadRequest,
    ownerSessionId?: string
  ): Promise<FileDownloadResponse> => {
    const capabilities = await deps.getMachineProtocolCapabilities(machineId);
    if (
      !machineSupportsProtocolCapability(
        { protocolCapabilities: capabilities },
        MACHINE_PROTOCOL_CAPABILITIES.fileDownload
      )
    )
      return { status: 'error', code: 'unsupported_protocol' };
    // This is a remote-only path. Same-machine file actions retain local IPC.
    if ((await resolveMachineTargetPlane(machineId)) === 'local')
      return { status: 'error', code: 'unsupported_protocol' };
    const client = await getMachineRpcClient(machineId);
    return (
      (await client.requestFileDownloadChunk({ ...request, ownerSessionId })) ?? {
        status: 'error',
        code: 'transient_io',
      }
    );
  };

  const protectedPreviewUnavailable = (path: string) =>
    filePreviewV3Error('permission_denied', {
      message: workspaceFeatureUnavailableMessage('rpc'),
      path,
      retryable: false,
    });

  const requestFilePreview = async (
    machineId: MachineId,
    request: Omit<FilePreviewV3Request, 'v'>,
    options?: CodeCollabRequestOptions & { workspaceRoot?: string | null }
  ): Promise<FilePreviewV3Response | LocalFilePreviewResource> => {
    const params: FilePreviewV3Request = {
      v: FILE_PREVIEW_PROTOCOL_VERSION,
      sessionId: request.sessionId,
      path: request.path,
      ...(request.rootId === undefined ? {} : { rootId: request.rootId }),
      ...(request.resolveMarkdownLink ? { resolveMarkdownLink: true as const } : {}),
      ...(request.knownDigest === undefined ? {} : { knownDigest: request.knownDigest }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    };
    // A member root's path is relative to a directory only the machine knows;
    // the Electron fast path resolves against the main workspace root and would
    // read a different file. Such requests always go to the machine.
    const memberRoot = request.rootId !== undefined && request.rootId !== MAIN_SESSION_FILE_ROOT_ID;
    try {
      const result = await (async () => {
        const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__;
        // A member root on this machine: ask the local daemon, which resolves the
        // root from its registry and authorizes the real path. No remote channel
        // is needed, so this also works in local-only mode.
        if (memberRoot && (await canUseLocalMachineRpc(machineId))) {
          const local = await sendLocalMachineRpcRequest({
            machineId,
            workspaceId,
            method: 'file/preview',
            params,
            ...(options?.ownerSessionId === undefined
              ? {}
              : { ownerSessionId: options.ownerSessionId }),
            timeoutMs: options?.timeoutMs ?? 30_000,
          });
          const parsed = FilePreviewV3ResponseSchema.safeParse(local);
          return parsed.success ? parsed.data : null;
        }
        if (isElectron && !memberRoot) {
          const ipc = getIpcServices();
          if (!ipc) throw new Error('Local file preview is not available.');
          // Main checks persistent machine identity before touching the path. This
          // remains usable when the daemon and its routing/presence are offline.
          const local = await ipc.machineRpc.previewFile({
            machineId,
            path: request.path,
            workspaceRoot: options?.workspaceRoot ?? null,
            ...(request.resolveMarkdownLink ? { resolveMarkdownLink: true as const } : {}),
          });
          if (local !== null) return local;
          const plane = await resolveMachineTargetPlane(machineId);
          if (plane === 'local') {
            return filePreviewV3Error('permission_denied', {
              message: 'The file target does not match this desktop machine.',
              path: request.path,
            });
          }
          if (request.resolveMarkdownLink && !(await supportsMarkdownLinks(machineId)))
            return unsupportedMarkdownLinks();
          if (deps.protectedContent && !deps.requestEncryptedFeature)
            return protectedPreviewUnavailable(request.path);
          if (deps.requestEncryptedFeature) {
            const response = await deps.requestEncryptedFeature({
              machineId,
              workspaceId,
              method: 'file/preview',
              params,
              ...ownerSessionFields(options),
              timeoutMs: options?.timeoutMs ?? 30_000,
            });
            if (!response.ok) throw new Error(response.error);
            return FilePreviewV3ResponseSchema.parse(response.result);
          }
          const client = await getMachineRpcClient(machineId);
          return await client.requestFilePreview({
            ...params,
            ownerSessionId: options?.ownerSessionId,
            timeoutMs: options?.timeoutMs ?? 30_000,
          });
        }
        if (request.resolveMarkdownLink && !(await supportsMarkdownLinks(machineId)))
          return unsupportedMarkdownLinks();
        if (deps.protectedContent && !deps.requestEncryptedFeature)
          return protectedPreviewUnavailable(request.path);
        if (deps.requestEncryptedFeature) {
          const response = await deps.requestEncryptedFeature({
            machineId,
            workspaceId,
            method: 'file/preview',
            params,
            ...ownerSessionFields(options),
            timeoutMs: options?.timeoutMs ?? 30_000,
          });
          if (!response.ok) throw new Error(response.error);
          return FilePreviewV3ResponseSchema.parse(response.result);
        }
        const client = await getMachineRpcClient(machineId);
        return await client.requestFilePreview({
          ...params,
          ownerSessionId: options?.ownerSessionId,
          timeoutMs: options?.timeoutMs ?? 30_000,
        });
      })();
      if (result === null) {
        return filePreviewV3Error('transient_io', {
          message: 'File preview request timed out.',
          path: request.path,
          retryable: true,
        });
      }
      return result;
    } catch (error) {
      return filePreviewV3Error('transient_io', {
        message: error instanceof Error ? error.message : String(error),
        path: request.path,
        retryable: true,
      });
    }
  };

  const requestCodeCollabOpenText = (
    machineId: MachineId,
    request: CodeCollabV2OpenTextRequest,
    options?: CodeCollabRequestOptions
  ): Promise<CodeCollabV2OpenTextOk | CodeCollabV2Error | null> =>
    requestCodeCollab(
      machineId,
      {
        machineId,
        workspaceId,
        method: 'code-collab/open-text',
        params: request,
        ...ownerSessionFields(options),
        timeoutMs: options?.timeoutMs ?? 30_000,
      },
      async (client) =>
        await client.requestCodeCollabOpenText({
          ...request,
          ownerSessionId: options?.ownerSessionId,
          timeoutMs: options?.timeoutMs ?? 30_000,
        })
    );

  /**
   * Electron local file surfaces need an authoritative initial tree/current-diff
   * snapshot before a Flock publication has had a chance to replicate. This is
   * intentionally local-only: remote surfaces continue reading the shared Flock.
   */
  const requestLocalCodeCollabFileIndex = async (
    machineId: MachineId,
    request: CodeCollabV2FileIndexRequest,
    options?: CodeCollabRequestOptions
  ): Promise<CodeCollabV2FileIndexSnapshot | CodeCollabV2Error | null> => {
    try {
      if (!(await canUseLocalMachineRpc(machineId))) {
        return toCodeCollabTransportError(
          new Error('Local Code Collab file-index RPC is not available for this machine.')
        );
      }
      return (await sendLocalMachineRpcRequest({
        machineId,
        workspaceId,
        method: 'code-collab/get-file-index',
        params: request,
        ...ownerSessionFields(options),
        timeoutMs: options?.timeoutMs ?? 30_000,
      })) as CodeCollabV2FileIndexSnapshot | CodeCollabV2Error | null;
    } catch (error) {
      return toCodeCollabTransportError(error);
    }
  };

  const requestCodeCollabRefreshText = (
    machineId: MachineId,
    request: CodeCollabV2RefreshTextRequest,
    options?: CodeCollabRequestOptions
  ): Promise<CodeCollabV2RefreshTextResponse | CodeCollabV2Error | null> =>
    requestCodeCollab(
      machineId,
      {
        machineId,
        workspaceId,
        method: 'code-collab/refresh-text',
        params: request,
        ...ownerSessionFields(options),
        timeoutMs: options?.timeoutMs ?? 30_000,
      },
      async (client) =>
        await client.requestCodeCollabRefreshText({
          ...request,
          ownerSessionId: options?.ownerSessionId,
          timeoutMs: options?.timeoutMs ?? 30_000,
        })
    );

  const requestCodeCollabSaveText = (
    machineId: MachineId,
    request: CodeCollabV2SaveTextRequest,
    options?: CodeCollabRequestOptions
  ): Promise<CodeCollabV2SaveTextResponse | CodeCollabV2Error | null> =>
    requestCodeCollab(
      machineId,
      {
        machineId,
        workspaceId,
        method: 'code-collab/save-text',
        params: request,
        ...ownerSessionFields(options),
        timeoutMs: options?.timeoutMs ?? 30_000,
      },
      async (client) =>
        await client.requestCodeCollabSaveText({
          ...request,
          ownerSessionId: options?.ownerSessionId,
          timeoutMs: options?.timeoutMs ?? 30_000,
        })
    );

  const requestCodeCollabOpenCurrentDiff = (
    machineId: MachineId,
    request: CodeCollabV2OpenCurrentDiffRequest,
    options?: CodeCollabRequestOptions
  ): Promise<CodeCollabV2OpenCurrentDiffResponse | CodeCollabV2Error | null> =>
    codeCollabDiffRpcGate(
      async () =>
        await requestCodeCollab(
          machineId,
          {
            machineId,
            workspaceId,
            method: 'code-collab/open-current-diff',
            params: request,
            ...ownerSessionFields(options),
            timeoutMs: options?.timeoutMs ?? 30_000,
          },
          async (client) =>
            await client.requestCodeCollabOpenCurrentDiff({
              ...request,
              ownerSessionId: options?.ownerSessionId,
              timeoutMs: options?.timeoutMs ?? 30_000,
            })
        )
    );

  const requestCodeCollabOpenAllChangesDiff = (
    machineId: MachineId,
    request: CodeCollabV2OpenAllChangesDiffRequest,
    options?: CodeCollabRequestOptions
  ): Promise<CodeCollabV2OpenAllChangesDiffResponse | CodeCollabV2Error | null> =>
    requestCodeCollab(
      machineId,
      {
        machineId,
        workspaceId,
        method: 'code-collab/open-all-changes-diff',
        params: request,
        ...ownerSessionFields(options),
        timeoutMs: options?.timeoutMs ?? 30_000,
      },
      async (client) =>
        await client.requestCodeCollabOpenAllChangesDiff({
          ...request,
          ownerSessionId: options?.ownerSessionId,
          timeoutMs: options?.timeoutMs ?? 30_000,
        })
    );

  const requestCodeCollabOpenTurnDiff = (
    machineId: MachineId,
    request: CodeCollabV2OpenTurnDiffRequest,
    options?: CodeCollabRequestOptions
  ): Promise<CodeCollabV2OpenTurnDiffResponse | CodeCollabV2Error | null> =>
    codeCollabDiffRpcGate(
      async () =>
        await requestCodeCollab(
          machineId,
          {
            machineId,
            workspaceId,
            method: 'code-collab/open-turn-diff',
            params: request,
            ...ownerSessionFields(options),
            timeoutMs: options?.timeoutMs ?? 30_000,
          },
          async (client) =>
            await client.requestCodeCollabOpenTurnDiff({
              ...request,
              ownerSessionId: options?.ownerSessionId,
              timeoutMs: options?.timeoutMs ?? 30_000,
            })
        )
    );

  const requestCodeCollabInitDirectory = (
    machineId: MachineId,
    request: CodeCollabV2InitDirectoryRequest,
    options?: CodeCollabRequestOptions
  ): Promise<CodeCollabV2InitDirectoryOk | CodeCollabV2Error | null> =>
    requestCodeCollab(
      machineId,
      {
        machineId,
        workspaceId,
        method: 'code-collab/init-directory',
        params: request,
        ...ownerSessionFields(options),
        timeoutMs: options?.timeoutMs ?? 30_000,
      },
      async (client) =>
        await client.requestCodeCollabInitDirectory({
          ...request,
          ownerSessionId: options?.ownerSessionId,
          timeoutMs: options?.timeoutMs ?? 30_000,
        })
    );

  const requestCodeCollabLspDefinition = (
    machineId: MachineId,
    request: LspRequest,
    options?: CodeCollabRequestOptions
  ): Promise<CodeCollabV2LspUnsupported | CodeCollabV2Error | null> =>
    requestCodeCollab(
      machineId,
      {
        machineId,
        workspaceId,
        method: 'code-collab/lsp-definition',
        params: request,
        ...ownerSessionFields(options),
        timeoutMs: options?.timeoutMs ?? 30_000,
      },
      async (client) =>
        await client.requestCodeCollabLspDefinition({
          ...request,
          ownerSessionId: options?.ownerSessionId,
          timeoutMs: options?.timeoutMs ?? 30_000,
        })
    );

  const requestCodeCollabLspReferences = (
    machineId: MachineId,
    request: LspRequest,
    options?: CodeCollabRequestOptions
  ): Promise<CodeCollabV2LspUnsupported | CodeCollabV2Error | null> =>
    requestCodeCollab(
      machineId,
      {
        machineId,
        workspaceId,
        method: 'code-collab/lsp-references',
        params: request,
        ...ownerSessionFields(options),
        timeoutMs: options?.timeoutMs ?? 30_000,
      },
      async (client) =>
        await client.requestCodeCollabLspReferences({
          ...request,
          ownerSessionId: options?.ownerSessionId,
          timeoutMs: options?.timeoutMs ?? 30_000,
        })
    );

  const requestSessionCancel = async (
    machineId: MachineId,
    sessionId: SessionId,
    turnId: string,
    options?: {
      timeoutMs?: number;
      subagentTaskId?: string;
      cancelId?: string;
      pauseInbox?: boolean;
    }
  ): Promise<SessionCancelResponse | null> => {
    try {
      if (
        options?.subagentTaskId &&
        !machineSupportsSubagentCancellation({
          protocolCapabilities: await deps.getMachineProtocolCapabilities(machineId),
        })
      )
        throw new Error('This machine does not support individual subagent cancellation.');
      const requiredLocalControl = deps.isLocalControlMachine?.(machineId) === true;
      if (requiredLocalControl || (await canUseLocalMachineRpc(machineId))) {
        const response = await getLocalMachineRpcSender()?.({
          machineId,
          workspaceId,
          method: 'session/cancel',
          params: {
            sessionId,
            turnId,
            subagentTaskId: options?.subagentTaskId,
            ...(options?.cancelId ? { cancelId: options.cancelId } : {}),
            ...(options?.pauseInbox === undefined ? {} : { pauseInbox: options.pauseInbox }),
          },
          timeoutMs: options?.timeoutMs ?? 2_000,
        });
        if (response && !response.ok) {
          return {
            type: 'session/cancel_response',
            sessionId,
            success: false,
            error: response.error,
          };
        }
        if (response?.ok) return response.result as SessionCancelResponse;
        if (requiredLocalControl || options?.subagentTaskId)
          throw new Error('Local machine RPC is unavailable.');
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionCancel({
        sessionId,
        turnId,
        subagentTaskId: options?.subagentTaskId,
        ...(options?.cancelId ? { cancelId: options.cancelId } : {}),
        ...(options?.pauseInbox === undefined ? {} : { pauseInbox: options.pauseInbox }),
        timeoutMs: options?.timeoutMs ?? 2_000,
      });
    } catch (error) {
      return {
        type: 'session/cancel_response',
        sessionId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestSessionTerminate = async (
    machineId: MachineId,
    sessionId: SessionId,
    options?: { timeoutMs?: number }
  ): Promise<SessionTerminateResponse | null> => {
    try {
      if (await canUseLocalMachineRpc(machineId)) {
        return (await sendLocalMachineRpcRequest({
          machineId,
          workspaceId,
          method: 'session/terminate',
          params: { sessionId },
          timeoutMs: options?.timeoutMs ?? 30_000,
        })) as SessionTerminateResponse | null;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionTerminate({
        sessionId,
        timeoutMs: options?.timeoutMs ?? 30_000,
      });
    } catch (error) {
      return {
        type: 'session/terminate_response',
        sessionId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestSessionDispatchTurn = async (
    machineId: MachineId,
    args: {
      sessionId: SessionId;
      userTurnId: string;
      userId: string;
      timestamp: string;
      inputConfig: SessionTurnInputConfig;
    },
    options?: { timeoutMs?: number }
  ): Promise<SessionDispatchTurnResponse | null> => {
    try {
      const protocolCapabilities = await deps.getMachineProtocolCapabilities(machineId);
      const input = {
        ...args,
        ...(machineSupportsProtocolCapability(
          { protocolCapabilities },
          MACHINE_PROTOCOL_CAPABILITIES.operationInbox
        )
          ? { inputOrigin: 'human' as const }
          : {}),
      };
      if (await canUseLocalMachineRpc(machineId)) {
        const response = await getLocalMachineRpcSender()?.({
          machineId,
          workspaceId,
          method: 'session/dispatch-turn',
          params: input,
          timeoutMs: options?.timeoutMs ?? 15_000,
        });
        if (response && !response.ok) {
          return {
            type: 'session/dispatch-turn_response',
            sessionId: args.sessionId,
            userTurnId: args.userTurnId,
            accepted: false,
            disposition: 'error',
            error: response.error,
          };
        }
        if (response?.ok) return response.result as SessionDispatchTurnResponse;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionDispatchTurn({
        ...input,
        timeoutMs: options?.timeoutMs ?? 15_000,
      });
    } catch (error) {
      return {
        type: 'session/dispatch-turn_response',
        sessionId: args.sessionId,
        userTurnId: args.userTurnId,
        accepted: false,
        disposition: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestSessionSteer = async (
    machineId: MachineId,
    args: {
      sessionId: SessionId;
      expectedTurnId: string;
      userTurnId: string;
      userId: string;
      timestamp: string;
      inputConfig: SessionTurnInputConfig;
    },
    options?: { timeoutMs?: number }
  ): Promise<SessionSteerResponse | null> => {
    try {
      if (await canUseLocalMachineRpc(machineId)) {
        const response = await getLocalMachineRpcSender()?.({
          machineId,
          workspaceId,
          method: 'session/steer',
          params: args,
          timeoutMs: options?.timeoutMs ?? 5_000,
        });
        if (response && !response.ok) {
          return {
            type: 'session/steer_response',
            sessionId: args.sessionId,
            userTurnId: args.userTurnId,
            applied: false,
            disposition: 'error',
            error: response.error,
          };
        }
        if (response?.ok) return response.result as SessionSteerResponse;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionSteer({
        ...args,
        timeoutMs: options?.timeoutMs ?? 5_000,
      });
    } catch (error) {
      return {
        type: 'session/steer_response',
        sessionId: args.sessionId,
        userTurnId: args.userTurnId,
        applied: false,
        disposition: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestSessionGoal = async (
    machineId: MachineId,
    args: {
      sessionId: SessionId;
      action: SessionGoalAction;
      objective?: string;
      userId: string;
    },
    options?: { timeoutMs?: number }
  ): Promise<SessionGoalResponse | null> => {
    const failure = (error: string): SessionGoalResponse => ({
      type: 'session/goal_response',
      sessionId: args.sessionId,
      action: args.action,
      accepted: false,
      disposition: 'error',
      error,
    });
    try {
      if (await canUseLocalMachineRpc(machineId)) {
        const response = await getLocalMachineRpcSender()?.({
          machineId,
          workspaceId,
          method: 'session/goal',
          params: args,
          timeoutMs: options?.timeoutMs ?? 10_000,
        });
        if (response && !response.ok) {
          return failure(response.error);
        }
        if (response?.ok) return response.result as SessionGoalResponse;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionGoal({
        ...args,
        timeoutMs: options?.timeoutMs ?? 10_000,
      });
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  };

  const requestSessionFork = async (
    machineId: MachineId,
    args: SessionForkSpec,
    options?: { timeoutMs?: number }
  ): Promise<SessionForkResponse | null> => {
    try {
      if (await canUseLocalMachineRpc(machineId)) {
        const response = await getLocalMachineRpcSender()?.({
          machineId,
          workspaceId,
          method: 'session/fork',
          params: args,
          timeoutMs:
            options?.timeoutMs ?? (args.targetContext?.kind === 'new-worktree' ? 15_000 : 120_000),
        });
        if (response && !response.ok) {
          return sessionForkFailure(args, 'INTERNAL_ERROR', response.error);
        }
        if (response?.ok) return response.result as SessionForkResponse;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionFork({
        ...args,
        timeoutMs:
          options?.timeoutMs ?? (args.targetContext?.kind === 'new-worktree' ? 15_000 : 120_000),
      });
    } catch (error) {
      return sessionForkFailure(
        args,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  const requestSessionEditAndResend = async (
    machineId: MachineId,
    args: SessionEditAndResendSpec,
    options?: { timeoutMs?: number }
  ): Promise<SessionEditAndResendResponse | null> => {
    try {
      if (await canUseLocalMachineRpc(machineId)) {
        const response = await getLocalMachineRpcSender()?.({
          machineId,
          workspaceId,
          method: 'session/edit-and-resend',
          params: args,
          timeoutMs: options?.timeoutMs ?? 120_000,
        });
        if (response && !response.ok) {
          return sessionEditAndResendFailure(args, 'INTERNAL_ERROR', response.error);
        }
        if (response?.ok) return response.result as SessionEditAndResendResponse;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionEditAndResend({ ...args, timeoutMs: options?.timeoutMs ?? 120_000 });
    } catch (error) {
      return sessionEditAndResendFailure(
        args,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  const assertProtectedPreviewControl = () => {
    if (!deps.protectedContent) return;
    if (!deps.requestEncryptedFeature)
      throw new Error(workspaceFeatureUnavailableMessage('remote-preview'));
    if (deps.protectedCodeCollabRole?.() !== 'write')
      throw new Error(protectedPreviewControlDeniedMessage());
  };

  const previewProof = async (
    machineId: MachineId,
    sessionId: SessionId,
    requesterUserId: string,
    operation: PreviewControlOperation
  ) => {
    if (
      !machineSupportsPreviewControlProtocol({
        protocolCapabilities: await deps.getMachineProtocolCapabilities(machineId),
      })
    ) {
      throw new Error('Update this machine to manage remote previews.');
    }
    const status = await (
      await getMachineRpcClient(machineId)
    ).requestPreviewControl({ timeoutMs: 15_000 });
    if (!status?.success || !status.runtimeNonce)
      throw new Error(
        status?.error ?? 'The machine did not provide preview control authorization.'
      );
    return mintPreviewControlProof(
      {
        workspaceId,
        machineId,
        sessionId,
        requesterUserId,
        operation,
        runtimeNonce: status.runtimeNonce,
        requestId: crypto.randomUUID(),
      },
      deps.getSessionToken?.() ?? null
    );
  };

  const requestSessionPreviewCreate = async (
    machineId: MachineId,
    sessionId: SessionId,
    requestedByUserId: string,
    target: PreviewTarget,
    approval: PreviewTargetApproval,
    options?: { restart?: boolean; timeoutMs?: number }
  ): Promise<SessionPreviewCreateResponse | null> => {
    try {
      await waitForMachineRoute(machineId);
      if (
        deps.isLocalControlMachine?.(machineId) ||
        targetRouter.getPlaneForMachine(machineId) === 'local'
      ) {
        const response = await getLocalMachineRpcSender()?.({
          method: 'session/preview-create',
          machineId,
          workspaceId,
          params: { sessionId, requestedByUserId, target, approval, restart: options?.restart },
          timeoutMs: options?.timeoutMs ?? DEFAULT_PREVIEW_CREATE_TIMEOUT_MS,
        });
        if (!response) throw new Error('Local preview control is unavailable.');
        if (!response.ok) throw new Error(response.error);
        return response.result as SessionPreviewCreateResponse;
      }
      assertProtectedPreviewControl();
      if (deps.requestEncryptedFeature) {
        const response = await deps.requestEncryptedFeature({
          machineId,
          workspaceId,
          method: 'session/preview-create',
          params: { sessionId, requestedByUserId, target, approval, restart: options?.restart },
          timeoutMs: options?.timeoutMs ?? 30_000,
        });
        if (!response.ok) throw new Error(response.error);
        return response.result as SessionPreviewCreateResponse;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionPreviewCreate({
        sessionId,
        requestedByUserId,
        proof: await previewProof(machineId, sessionId, requestedByUserId, {
          action: 'create',
          target,
          restart: options?.restart ?? false,
        }),
        target,
        approval,
        restart: options?.restart,
        timeoutMs: options?.timeoutMs ?? DEFAULT_PREVIEW_CREATE_TIMEOUT_MS,
      });
    } catch (error) {
      return {
        type: 'session/preview-create_response',
        sessionId,
        success: false,
        error: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestSessionPreviewEndpointAcquire = async (
    machineId: MachineId,
    sessionId: SessionId,
    requestedByUserId: string,
    target: PreviewTarget,
    options?: { timeoutMs?: number }
  ): Promise<SessionPreviewEndpointAcquireResponse | null> => {
    try {
      if (!(await canUseLocalMachineRpc(machineId))) {
        return {
          type: 'session/preview-endpoint-acquire_response',
          sessionId,
          success: false,
          error: 'session_mismatch',
          message: 'Local preview endpoints are only available on this machine.',
        };
      }
      const response = await getLocalMachineRpcSender()?.({
        machineId,
        workspaceId,
        method: 'session/preview-endpoint-acquire',
        params: { sessionId, requestedByUserId, target },
        timeoutMs: options?.timeoutMs ?? 10_000,
      });
      if (!response) {
        return {
          type: 'session/preview-endpoint-acquire_response',
          sessionId,
          success: false,
          error: 'internal_error',
          message: 'Local Machine RPC is not available.',
        };
      }
      if (!response.ok) {
        return {
          type: 'session/preview-endpoint-acquire_response',
          sessionId,
          success: false,
          error: 'internal_error',
          message: response.error,
        };
      }
      return response.result as SessionPreviewEndpointAcquireResponse;
    } catch (error) {
      return {
        type: 'session/preview-endpoint-acquire_response',
        sessionId,
        success: false,
        error: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestSessionPreviewEndpointRelease = async (
    machineId: MachineId,
    sessionId: SessionId,
    endpointId: string,
    options?: { timeoutMs?: number }
  ): Promise<SessionPreviewEndpointReleaseResponse | null> => {
    try {
      if (!(await canUseLocalMachineRpc(machineId))) {
        return {
          type: 'session/preview-endpoint-release_response',
          sessionId,
          endpointId,
          success: false,
          error: 'session_mismatch',
          message: 'Local preview endpoints are only available on this machine.',
        };
      }
      const response = await getLocalMachineRpcSender()?.({
        machineId,
        workspaceId,
        method: 'session/preview-endpoint-release',
        params: { sessionId, endpointId },
        timeoutMs: options?.timeoutMs ?? 5_000,
      });
      if (!response) {
        return {
          type: 'session/preview-endpoint-release_response',
          sessionId,
          endpointId,
          success: false,
          error: 'internal_error',
          message: 'Local Machine RPC is not available.',
        };
      }
      if (!response.ok) {
        return {
          type: 'session/preview-endpoint-release_response',
          sessionId,
          endpointId,
          success: false,
          error: 'internal_error',
          message: response.error,
        };
      }
      return response.result as SessionPreviewEndpointReleaseResponse;
    } catch (error) {
      return {
        type: 'session/preview-endpoint-release_response',
        sessionId,
        endpointId,
        success: false,
        error: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestSessionPreviewStatus = async (
    machineId: MachineId,
    sessionId: SessionId,
    requestedByUserId: string,
    options?: { renewEndpointId?: string; timeoutMs?: number }
  ): Promise<SessionPreviewStatusResponse | null> => {
    try {
      await waitForMachineRoute(machineId);
      if (
        deps.isLocalControlMachine?.(machineId) ||
        targetRouter.getPlaneForMachine(machineId) === 'local'
      ) {
        const response = await getLocalMachineRpcSender()?.({
          method: 'session/preview-status',
          machineId,
          workspaceId,
          params: { sessionId, requestedByUserId, renewEndpointId: options?.renewEndpointId },
          timeoutMs: options?.timeoutMs ?? 15_000,
        });
        if (!response) throw new Error('Local preview control is unavailable.');
        if (!response.ok) throw new Error(response.error);
        return response.result as SessionPreviewStatusResponse;
      }
      assertProtectedPreviewControl();
      if (deps.requestEncryptedFeature) {
        const response = await deps.requestEncryptedFeature({
          machineId,
          workspaceId,
          method: 'session/preview-status',
          params: { sessionId, requestedByUserId, renewEndpointId: options?.renewEndpointId },
          timeoutMs: options?.timeoutMs ?? 30_000,
        });
        if (!response.ok) throw new Error(response.error);
        return response.result as SessionPreviewStatusResponse;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionPreviewStatus({
        sessionId,
        requestedByUserId,
        ...options,
        proof: await previewProof(machineId, sessionId, requestedByUserId, {
          action: 'status',
          renewEndpointId: options?.renewEndpointId,
        }),
      });
    } catch (error) {
      return {
        type: 'session/preview-status_response',
        sessionId,
        success: false,
        error: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const iosSimulatorFailure = (
    sessionId: SessionId,
    error: NonNullable<IosSimulatorResponse['error']>,
    message: string
  ): IosSimulatorResponse => ({
    type: 'ios-simulator/control_response',
    sessionId,
    success: false,
    error,
    message,
  });

  /**
   * One authenticated Machine RPC for every simulator command. The local plane
   * goes straight to this machine's daemon and never touches the cloud; the
   * remote plane signs the exact command with the preview-control proof.
   */
  const requestIosSimulatorControl = async ({
    machineId,
    sessionId,
    requestedByUserId,
    command,
    timeoutMs = 15_000,
  }: {
    machineId: MachineId;
    sessionId: SessionId;
    requestedByUserId: string;
    command: IosSimulatorCommand;
    timeoutMs?: number;
  }): Promise<IosSimulatorResponse> => {
    try {
      await waitForMachineRoute(machineId);
      if (targetRouter.getPlaneForMachine(machineId) === 'local') {
        const response = await getLocalMachineRpcSender()?.({
          method: 'ios-simulator/control',
          machineId,
          workspaceId,
          params: { sessionId, requestedByUserId, command },
          timeoutMs,
        });
        if (!response) throw new Error('Local simulator control is unavailable.');
        if (!response.ok) throw new Error(response.error);
        return IosSimulatorResponseSchema.parse(response.result);
      }
      if (
        !machineSupportsIosSimulatorProtocol({
          protocolCapabilities: await deps.getMachineProtocolCapabilities(machineId),
        })
      ) {
        return iosSimulatorFailure(
          sessionId,
          'unsupported',
          'Update Lody on this machine to preview simulators.'
        );
      }
      const responseRecipient = await createRpcSecretRecipient();
      const response = await (
        await getMachineRpcClient(machineId)
      ).requestIosSimulatorControl({
        sessionId,
        requestedByUserId,
        command,
        responseRecipient,
        proof: await previewProof(machineId, sessionId, requestedByUserId, {
          action: 'ios-simulator',
          command,
          responseKey: responseRecipient.publicKey,
        }),
        timeoutMs,
      });
      return response ?? iosSimulatorFailure(sessionId, 'failed', 'The machine did not answer.');
    } catch (error) {
      return iosSimulatorFailure(
        sessionId,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  const androidEmulatorFailure = (
    sessionId: SessionId,
    error: NonNullable<AndroidEmulatorResponse['error']>,
    message: string
  ): AndroidEmulatorResponse => ({
    type: 'android-emulator/control_response',
    sessionId,
    success: false,
    error,
    message,
  });

  /**
   * One authenticated Machine RPC for every simulator command. The local plane
   * goes straight to this machine's daemon and never touches the cloud; the
   * remote plane signs the exact command with the preview-control proof.
   */
  const requestAndroidEmulatorControl = async ({
    machineId,
    sessionId,
    requestedByUserId,
    command,
    timeoutMs = 15_000,
  }: {
    machineId: MachineId;
    sessionId: SessionId;
    requestedByUserId: string;
    command: AndroidEmulatorCommand;
    timeoutMs?: number;
  }): Promise<AndroidEmulatorResponse> => {
    try {
      await waitForMachineRoute(machineId);
      if (targetRouter.getPlaneForMachine(machineId) === 'local') {
        const response = await getLocalMachineRpcSender()?.({
          method: 'android-emulator/control',
          machineId,
          workspaceId,
          params: { sessionId, requestedByUserId, command },
          timeoutMs,
        });
        if (!response) throw new Error('Local simulator control is unavailable.');
        if (!response.ok) throw new Error(response.error);
        return AndroidEmulatorResponseSchema.parse(response.result);
      }
      if (
        !machineSupportsAndroidEmulatorProtocol({
          protocolCapabilities: await deps.getMachineProtocolCapabilities(machineId),
        })
      ) {
        return androidEmulatorFailure(
          sessionId,
          'unsupported',
          'Update Lody on this machine to preview simulators.'
        );
      }
      const responseRecipient = await createRpcSecretRecipient();
      const response = await (
        await getMachineRpcClient(machineId)
      ).requestAndroidEmulatorControl({
        sessionId,
        requestedByUserId,
        command,
        responseRecipient,
        proof: await previewProof(machineId, sessionId, requestedByUserId, {
          action: 'android-emulator',
          command,
          responseKey: responseRecipient.publicKey,
        }),
        timeoutMs,
      });
      return response ?? androidEmulatorFailure(sessionId, 'failed', 'The machine did not answer.');
    } catch (error) {
      return androidEmulatorFailure(
        sessionId,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  const requestSessionPreviewRevoke = async (
    machineId: MachineId,
    sessionId: SessionId,
    requestedByUserId: string,
    options?: { reason?: string; timeoutMs?: number }
  ): Promise<SessionPreviewRevokeResponse | null> => {
    try {
      await waitForMachineRoute(machineId);
      if (
        deps.isLocalControlMachine?.(machineId) ||
        targetRouter.getPlaneForMachine(machineId) === 'local'
      ) {
        const response = await getLocalMachineRpcSender()?.({
          method: 'session/preview-revoke',
          machineId,
          workspaceId,
          params: { sessionId, requestedByUserId, reason: options?.reason },
          timeoutMs: options?.timeoutMs ?? 15_000,
        });
        if (!response) throw new Error('Local preview control is unavailable.');
        if (!response.ok) throw new Error(response.error);
        return response.result as SessionPreviewRevokeResponse;
      }
      assertProtectedPreviewControl();
      if (deps.requestEncryptedFeature) {
        const response = await deps.requestEncryptedFeature({
          machineId,
          workspaceId,
          method: 'session/preview-revoke',
          params: { sessionId, requestedByUserId, reason: options?.reason },
          timeoutMs: options?.timeoutMs ?? 30_000,
        });
        if (!response.ok) throw new Error(response.error);
        return response.result as SessionPreviewRevokeResponse;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionPreviewRevoke({
        sessionId,
        requestedByUserId,
        proof: await previewProof(machineId, sessionId, requestedByUserId, { action: 'revoke' }),
        reason: options?.reason,
        timeoutMs: options?.timeoutMs ?? 30_000,
      });
    } catch (error) {
      return {
        type: 'session/preview-revoke_response',
        sessionId,
        success: false,
        error: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestLocalProjectGitState = async (
    machineId: MachineId,
    localProjectId: LocalProjectId,
    requestedByUserId: string,
    options?: { timeoutMs?: number }
  ): Promise<LocalProjectGitStateRpcResponse | null> => {
    try {
      await waitForMachineRoute(machineId);
      if (
        window.__LODY_ELECTRON__ &&
        getIpcServices() &&
        targetRouter.getPlaneForMachine(machineId) === 'local'
      ) {
        const state = await getIpcServices()!.localProjects.getGitState(
          workspaceId,
          localProjectId
        );
        if ('error' in state) {
          return {
            type: 'local-project/git-state_response',
            machineId,
            workspaceId,
            localProjectId,
            success: false,
            error: 'internal_error',
            message: state.error,
          };
        }
        return {
          type: 'local-project/git-state_response',
          machineId,
          workspaceId,
          localProjectId,
          success: true,
          state,
          observedAtMs: getServerNow(),
        };
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestLocalProjectGitState({
        localProjectId,
        requestedByUserId,
        timeoutMs: options?.timeoutMs ?? 30_000,
      });
    } catch (error) {
      return {
        type: 'local-project/git-state_response',
        machineId,
        workspaceId,
        localProjectId,
        success: false,
        error: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  /**
   * Read-only `.gitmodules` probe of a registered local project, used by the
   * Project group editor. The local plane answers through Local Machine RPC; a
   * remote machine through Streams. `null` is "no answer", never "no submodules".
   */
  const requestProjectProbeLocalMember = async (
    machineId: MachineId,
    localProjectId: LocalProjectId,
    requestedByUserId: string,
    options?: { timeoutMs?: number }
  ): Promise<ProjectProbeLocalMemberResult | null> => {
    try {
      if (await canUseLocalMachineRpc(machineId)) {
        const result = await sendLocalMachineRpcRequest({
          machineId,
          workspaceId,
          method: 'project/probe-local-member',
          params: { localProjectId },
          timeoutMs: options?.timeoutMs ?? 30_000,
        });
        const parsed = ProjectProbeLocalMemberResultSchema.safeParse(result);
        return parsed.success ? parsed.data : null;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestProjectProbeLocalMember({
        localProjectId,
        requestedByUserId,
        timeoutMs: options?.timeoutMs ?? 30_000,
      });
    } catch (error) {
      console.warn('Project member probe failed', error);
      return null;
    }
  };

  const requestLocalProjectControl = async (
    request: LocalProjectControlRequest,
    options?: { timeoutMs?: number }
  ): Promise<LocalProjectControlResponse | null> => {
    try {
      await waitForMachineRoute(request.machineId);
      if (
        window.__LODY_ELECTRON__ &&
        getIpcServices() &&
        targetRouter.getPlaneForMachine(request.machineId) === 'local'
      ) {
        return await getIpcServices()!.localProjects.control(request);
      }
      const response = await (
        await getMachineRpcClient(request.machineId)
      ).requestLocalProjectControl({
        request,
        timeoutMs: options?.timeoutMs ?? 120_000,
      });
      return (
        response ?? {
          ok: false,
          type: request.type,
          error: 'execution_failed',
          message: `Machine ${request.machineId} did not respond before the request timed out.`,
        }
      );
    } catch (error) {
      return {
        ok: false,
        type: request.type,
        error: 'execution_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestMemoryProvider = async (
    machineId: MachineId,
    params: MemoryProviderRequest
  ): Promise<MemoryProviderResponse> => {
    const fail = (error: string): MemoryProviderResponse => ({
      type: 'machine/memory',
      status: 'error',
      memories: [],
      error,
    });
    try {
      await targetRouter.resolvePlaneForMachine(machineId, {
        timeoutMs: LOCAL_MACHINE_ID_READY_TIMEOUT_MS,
      });
      const capabilities = await deps.getMachineProtocolCapabilities(machineId);
      if (!machineSupportsMemoryProviders({ protocolCapabilities: capabilities ?? undefined }))
        return fail('Update this machine to use memory providers.');
      const plane = targetRouter.getPlaneForMachine(machineId);
      if (plane === null) return fail('Machine RPC routing is not available.');
      if (plane === 'local') {
        const sender = getLocalMachineRpcSender();
        if (!sender) return fail('Local Machine RPC is not available.');
        const response = await sender({
          machineId,
          workspaceId,
          method: 'machine/memory',
          params,
          timeoutMs: 60_000,
        });
        return response.ok
          ? MemoryProviderResponseSchema.parse(response.result)
          : fail(response.error);
      }
      return (
        (await (await getMachineRpcClient(machineId)).requestMemoryProvider(params)) ??
        fail('Memory request timed out.')
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };

  const requestMachinePiExtensions = async (
    machineId: MachineId,
    options?: { configId?: AgentConfigId }
  ): Promise<MachinePiExtensionsResponse> => {
    const fail = (error: string): MachinePiExtensionsResponse => ({ success: false, error });
    try {
      await targetRouter.resolvePlaneForMachine(machineId, {
        timeoutMs: LOCAL_MACHINE_ID_READY_TIMEOUT_MS,
      });
      const plane = targetRouter.getPlaneForMachine(machineId);
      if (plane === null) {
        return fail('Machine RPC routing is not available.');
      }
      const protocolCapabilities = await deps.getMachineProtocolCapabilities(machineId);
      if (!machineSupportsPiExtensions({ protocolCapabilities })) {
        return fail('This machine does not support Pi extension scanning. Update the local agent.');
      }
      if (plane === 'local') {
        const sender = getLocalMachineRpcSender();
        if (!sender) {
          return fail('Local Machine RPC is not available.');
        }
        const response = await sender({
          machineId,
          workspaceId,
          method: 'machine/pi-extensions',
          params: { configId: options?.configId },
          // Above the daemon's worst case: 120 s runtime ensure + 30 s scan.
          timeoutMs: 180_000,
        });
        if (!response.ok) {
          return fail(response.error);
        }
        return response.result as MachinePiExtensionsResponse;
      }
      const result = await (
        await getMachineRpcClient(machineId)
      ).requestMachinePiExtensions({ configId: options?.configId, timeoutMs: 180_000 });
      if (result === null) {
        return fail('Pi extension scan request timed out.');
      }
      return result;
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };

  const requestMachineBugReport = async (
    machineId: MachineId,
    args: {
      description: string;
      reporterUserId: string;
      requestToken: string;
      clientLog?: BugReportClientLog;
    },
    options?: { timeoutMs?: number }
  ): Promise<MachineBugReportResponse | null> => {
    try {
      const { clientLog, ...report } = args;
      // The request schema is strict: an older daemon rejects the whole report
      // when the field is present, so the client log goes only where it is understood.
      const sendClientLog =
        clientLog !== undefined &&
        machineSupportsBugReportClientLog({
          protocolCapabilities: await deps.getMachineProtocolCapabilities(machineId),
        });
      return await (
        await getMachineRpcClient(machineId)
      ).requestMachineBugReport({
        ...report,
        ...(sendClientLog ? { clientLog } : {}),
        timeoutMs: options?.timeoutMs ?? 120_000,
      });
    } catch (error) {
      return {
        type: 'machine/bug-report_response',
        machineId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestLocalMcpTools = async (
    machineId: MachineId,
    server: WorkspaceMcpServerMeta,
    requesterUserId?: string
  ) => {
    const protocolCapabilities = await deps.getMachineProtocolCapabilities(machineId);
    if (
      !machineSupportsProtocolCapability(
        { protocolCapabilities },
        MACHINE_PROTOCOL_CAPABILITIES.mcpToolDiscovery,
        MCP_TOOL_DISCOVERY_PROTOCOL_VERSION
      ) ||
      !(await canUseLocalMachineRpc(machineId))
    ) {
      throw new Error('MCP tool discovery requires a supported local daemon.');
    }
    const result = await sendLocalMachineRpcRequest({
      machineId,
      workspaceId,
      method: 'mcp/list-tools',
      params: {
        server,
        ...(requesterUserId &&
        machineSupportsProtocolCapability(
          { protocolCapabilities },
          MACHINE_PROTOCOL_CAPABILITIES.mcpLocalAuthentication,
          MCP_LOCAL_AUTHENTICATION_PROTOCOL_VERSION
        )
          ? { requesterUserId }
          : {}),
      },
      timeoutMs: 35_000,
    });
    return McpToolListResultSchema.parse(result);
  };

  const requestLocalMcpAuthentication = async (
    machineId: MachineId,
    params: Extract<LocalMachineRpcRequest, { method: 'mcp/authentication' }>['params']
  ) => {
    const protocolCapabilities = await deps.getMachineProtocolCapabilities(machineId);
    if (
      !machineSupportsProtocolCapability(
        { protocolCapabilities },
        MACHINE_PROTOCOL_CAPABILITIES.mcpLocalAuthentication,
        MCP_LOCAL_AUTHENTICATION_PROTOCOL_VERSION
      ) ||
      !(await canUseLocalMachineRpc(machineId))
    ) {
      throw new Error('MCP authentication requires a supported local daemon.');
    }
    return McpAuthenticationResultSchema.parse(
      await sendLocalMachineRpcRequest({
        machineId,
        workspaceId,
        method: 'mcp/authentication',
        params,
        timeoutMs: 35_000,
      })
    );
  };

  return {
    requestLocalMcpTools,
    requestLocalMcpAuthentication,
    requestSessionCancel,
    requestSessionSteer,
    requestSessionGoal,
    requestSessionTerminate,
    requestSessionFork,
    requestSessionEditAndResend,
    requestSessionDispatchTurn,
    requestSessionHistoryRead,
    requestSessionHistoryWrite,
    requestFilePreview,
    requestFileDownloadChunk,
    requestLocalCodeCollabFileIndex,
    requestCodeCollabOpenText,
    requestCodeCollabRefreshText,
    requestCodeCollabSaveText,
    requestCodeCollabOpenCurrentDiff,
    requestCodeCollabOpenAllChangesDiff,
    requestCodeCollabOpenTurnDiff,
    requestCodeCollabInitDirectory,
    requestCodeCollabLspDefinition,
    requestCodeCollabLspReferences,
    requestSessionPreviewCreate,
    resolveMachineTargetPlane,
    requestSessionPreviewEndpointAcquire,
    requestSessionPreviewEndpointRelease,
    requestSessionPreviewRevoke,
    requestSessionPreviewStatus,
    requestIosSimulatorControl,
    requestAndroidEmulatorControl,
    requestLocalProjectGitState,
    requestProjectProbeLocalMember,
    requestLocalProjectControl,
    requestMachineBugReport,
    requestMemoryProvider,
    requestMachinePiExtensions,
  };
}
