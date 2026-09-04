import type {
  LoroStreamsMachineRpcClient,
  LocalProjectGitStateRpcResponse,
} from '@lody/loro-streams-rpc';
import {
  getServerNow,
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
  type SendLocalMachineRpcResult,
  type SessionCancelResponse,
  type SessionDispatchTurnResponse,
  type SessionId,
  type SessionPreparationCancelSpec,
  type SessionPreparationSpec,
  type SessionPrepareCancelResponse,
  type SessionPrepareResponse,
  type SessionPreviewCreateResponse,
  type SessionPreviewEndpointAcquireResponse,
  type SessionPreviewEndpointReleaseResponse,
  type SessionPreviewRevokeResponse,
  type PreviewTarget,
  type PreviewTargetApproval,
  type SessionSteerResponse,
  type SessionTerminateResponse,
  type SessionForkResponse,
  type SessionForkSpec,
  type SessionEditAndResendResponse,
  type SessionEditAndResendSpec,
  type SessionTurnInputConfig,
  type WorkspaceId,
  sessionForkFailure,
  sessionEditAndResendFailure,
} from '@lody/shared';
import { createAsyncConcurrencyGate } from '@/lib/async-concurrency-gate';
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
  workspaceId: WorkspaceId;
  targetRouter: Pick<WorkspaceTargetRouter, 'getPlaneForMachine' | 'resolvePlaneForMachine'>;
  getMachineRpcClient: (machineId: MachineId) => Promise<LoroStreamsMachineRpcClient>;
};

const toCodeCollabTransportError = (error: unknown): CodeCollabV2Error => ({
  status: 'error',
  code: 'transient_io',
  message: error instanceof Error ? error.message : String(error),
  retryable: true,
});

const getLocalMachineRpcSender = (): LocalMachineRpcSender | undefined =>
  getIpcServices()?.machineRpc.send;

export function createWorkspaceMachineRpcFacade(deps: WorkspaceMachineRpcFacadeDeps) {
  const { workspaceId, targetRouter, getMachineRpcClient } = deps;
  const codeCollabDiffRpcGate = createAsyncConcurrencyGate(CODE_COLLAB_DIFF_RPC_CONCURRENCY_LIMIT);

  const waitForMachineRoute = async (machineId: MachineId): Promise<void> => {
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

  const canUseLocalMachineRpc = async (machineId: MachineId): Promise<boolean> => {
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
      return await cloudRequest(await getMachineRpcClient(machineId));
    } catch (error) {
      return toCodeCollabTransportError(error);
    }
  };

  const ownerSessionFields = (options?: CodeCollabRequestOptions) =>
    options?.ownerSessionId === undefined
      ? {}
      : { ownerSessionId: options.ownerSessionId.toString() };

  /**
   * File Preview v3. Its own transport wrapper (rather than `requestCodeCollab`)
   * so a transport failure surfaces as a typed `FilePreviewV3Error` instead of a
   * Code Collab error the preview UI would have to translate.
   */
  const requestFilePreview = async (
    machineId: MachineId,
    request: Omit<FilePreviewV3Request, 'v'>,
    options?: CodeCollabRequestOptions
  ): Promise<FilePreviewV3Response> => {
    const params: FilePreviewV3Request = {
      v: FILE_PREVIEW_PROTOCOL_VERSION,
      sessionId: request.sessionId,
      path: request.path,
      ...(request.knownDigest === undefined ? {} : { knownDigest: request.knownDigest }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    };
    try {
      const result = await (async () => {
        const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__;
        if (isElectron) {
          // A local Electron file preview must never fall through to the
          // Streams RPC plane. Until the target router identifies the machine,
          // returning a retryable error is safer than sending a local path to
          // the server; once identified, remote machines still use Streams.
          await targetRouter.resolvePlaneForMachine(machineId, {
            timeoutMs: LOCAL_MACHINE_ID_READY_TIMEOUT_MS,
          });
          const plane = targetRouter.getPlaneForMachine(machineId);
          if (plane === null) {
            throw new Error('Local Machine RPC routing is not available.');
          }
          if (plane === 'cloud') {
            const client = await getMachineRpcClient(machineId);
            return await client.requestFilePreview({
              ...params,
              ownerSessionId: options?.ownerSessionId,
              timeoutMs: options?.timeoutMs ?? 30_000,
            });
          }

          const sender = getLocalMachineRpcSender();
          if (!sender) throw new Error('Local Machine RPC is not available.');
          const response = await sender({
            machineId,
            workspaceId,
            method: 'file/preview-local',
            params,
            ...ownerSessionFields(options),
            timeoutMs: options?.timeoutMs ?? 30_000,
          });
          if (!response.ok) throw new Error(response.error);
          return response.result as FilePreviewV3Response | null;
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
    options?: { timeoutMs?: number }
  ): Promise<SessionCancelResponse | null> => {
    try {
      if (await canUseLocalMachineRpc(machineId)) {
        const response = await getLocalMachineRpcSender()?.({
          machineId,
          workspaceId,
          method: 'session/cancel',
          params: { sessionId, turnId },
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
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionCancel({
        sessionId,
        turnId,
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
      if (await canUseLocalMachineRpc(machineId)) {
        const response = await getLocalMachineRpcSender()?.({
          machineId,
          workspaceId,
          method: 'session/dispatch-turn',
          params: args,
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
        ...args,
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

  const requestSessionPrepare = async (
    machineId: MachineId,
    spec: SessionPreparationSpec,
    options?: { timeoutMs?: number }
  ): Promise<SessionPrepareResponse | null> => {
    try {
      if (await canUseLocalMachineRpc(machineId)) {
        const response = await getLocalMachineRpcSender()?.({
          machineId,
          workspaceId,
          method: 'session/prepare',
          params: spec,
          timeoutMs: options?.timeoutMs ?? 5_000,
        });
        if (response && !response.ok) {
          return {
            type: 'session/prepare_response',
            preparationId: spec.preparationId,
            sessionId: spec.sessionId,
            accepted: false,
            disposition: 'error',
            error: response.error,
          };
        }
        if (response?.ok) return response.result as SessionPrepareResponse;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionPrepare({
        ...spec,
        timeoutMs: options?.timeoutMs ?? 5_000,
      });
    } catch (error) {
      return {
        type: 'session/prepare_response',
        preparationId: spec.preparationId,
        sessionId: spec.sessionId,
        accepted: false,
        disposition: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestSessionPrepareCancel = async (
    machineId: MachineId,
    args: SessionPreparationCancelSpec,
    options?: { timeoutMs?: number }
  ): Promise<SessionPrepareCancelResponse | null> => {
    try {
      if (await canUseLocalMachineRpc(machineId)) {
        const response = await getLocalMachineRpcSender()?.({
          machineId,
          workspaceId,
          method: 'session/prepare-cancel',
          params: args,
          timeoutMs: options?.timeoutMs ?? 5_000,
        });
        if (response && !response.ok) {
          return {
            type: 'session/prepare-cancel_response',
            preparationId: args.preparationId,
            sessionId: args.sessionId,
            cancelled: false,
            disposition: 'error',
            error: response.error,
          };
        }
        if (response?.ok) return response.result as SessionPrepareCancelResponse;
      }
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionPrepareCancel({
        ...args,
        timeoutMs: options?.timeoutMs ?? 5_000,
      });
    } catch (error) {
      return {
        type: 'session/prepare-cancel_response',
        preparationId: args.preparationId,
        sessionId: args.sessionId,
        cancelled: false,
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

  const requestSessionPreviewCreate = async (
    machineId: MachineId,
    sessionId: SessionId,
    requestedByUserId: string,
    target: PreviewTarget,
    approval: PreviewTargetApproval,
    options: {
      requestId: string;
      requestToken: string;
      replaceExisting?: boolean;
      timeoutMs?: number;
    }
  ): Promise<SessionPreviewCreateResponse | null> => {
    try {
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionPreviewCreate({
        sessionId,
        requestedByUserId,
        requestId: options.requestId,
        requestToken: options.requestToken,
        target,
        approval,
        replaceExisting: options?.replaceExisting,
        timeoutMs: options?.timeoutMs ?? 30_000,
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

  const resolveMachineTargetPlane = async (
    machineId: MachineId,
    options?: { timeoutMs?: number }
  ): Promise<'local' | 'cloud'> => {
    const existing = targetRouter.getPlaneForMachine(machineId);
    if (existing) return existing;
    return await targetRouter.resolvePlaneForMachine(machineId, {
      timeoutMs: options?.timeoutMs ?? LOCAL_MACHINE_ID_READY_TIMEOUT_MS,
    });
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

  const requestSessionPreviewRevoke = async (
    machineId: MachineId,
    sessionId: SessionId,
    requestedByUserId: string,
    options?: { reason?: string; timeoutMs?: number }
  ): Promise<SessionPreviewRevokeResponse | null> => {
    try {
      return await (
        await getMachineRpcClient(machineId)
      ).requestSessionPreviewRevoke({
        sessionId,
        requestedByUserId,
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

  const requestMachineBugReport = async (
    machineId: MachineId,
    args: { description: string; reporterUserId: string; requestToken: string },
    options?: { timeoutMs?: number }
  ): Promise<MachineBugReportResponse | null> => {
    try {
      return await (
        await getMachineRpcClient(machineId)
      ).requestMachineBugReport({
        ...args,
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

  return {
    requestSessionCancel,
    requestSessionSteer,
    requestSessionTerminate,
    requestSessionFork,
    requestSessionEditAndResend,
    requestSessionDispatchTurn,
    requestSessionPrepare,
    requestSessionPrepareCancel,
    requestFilePreview,
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
    requestLocalProjectGitState,
    requestLocalProjectControl,
    requestMachineBugReport,
  };
}
