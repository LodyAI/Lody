import type {
  LocalProjectControlErrorCode,
  LocalProjectControlRequest,
  MachineId,
  WorkspaceId,
} from '@lody/shared';

export type LocalProjectHistoryRequestType =
  | 'local-project/sync-history'
  | 'local-project/import-history'
  | 'local-project/resolve-history-conflict';

export type LocalProjectHistoryRequest = Extract<
  LocalProjectControlRequest,
  { type: LocalProjectHistoryRequestType }
>;

export type LocalProjectSetupRequestType =
  | 'local-project/get-worktree-setup'
  | 'local-project/set-worktree-setup'
  | 'local-project/get-worktree-cleanup'
  | 'local-project/set-worktree-cleanup';

export type LocalProjectSetupRequest = Extract<
  LocalProjectControlRequest,
  { type: LocalProjectSetupRequestType }
>;

export type RemoteLocalProjectControlRequest =
  | LocalProjectHistoryRequest
  | LocalProjectSetupRequest;

export type LocalProjectHistoryPrecheckOk = {
  ok: true;
  request: RemoteLocalProjectControlRequest;
  requesterUserId: string;
};

export type LocalProjectHistoryPrecheckError = {
  ok: false;
  error: LocalProjectControlErrorCode;
  message: string;
};

export type LocalProjectHistoryPrecheckResult =
  | LocalProjectHistoryPrecheckOk
  | LocalProjectHistoryPrecheckError;

const HISTORY_REQUEST_TYPES: ReadonlySet<LocalProjectHistoryRequestType> = new Set([
  'local-project/sync-history',
  'local-project/import-history',
  'local-project/resolve-history-conflict',
]);

const SETUP_REQUEST_TYPES: ReadonlySet<LocalProjectSetupRequestType> = new Set([
  'local-project/get-worktree-setup',
  'local-project/set-worktree-setup',
  'local-project/get-worktree-cleanup',
  'local-project/set-worktree-cleanup',
]);

function isRemoteLocalProjectControlRequest(
  request: LocalProjectControlRequest
): request is RemoteLocalProjectControlRequest {
  return (
    HISTORY_REQUEST_TYPES.has(request.type as LocalProjectHistoryRequestType) ||
    SETUP_REQUEST_TYPES.has(request.type as LocalProjectSetupRequestType)
  );
}

/**
 * Validate the synchronous preconditions for a remote local-project RPC
 * request. Auth happens here for machineId, workspaceId, requestedByUserId, and
 * request type. The async access-token + rootPath checks are still the
 * caller's responsibility because they depend on workspace state.
 */
export function precheckLocalProjectHistoryRequest(args: {
  request: LocalProjectControlRequest;
  expectedMachineId: MachineId;
  expectedWorkspaceId: WorkspaceId;
}): LocalProjectHistoryPrecheckResult {
  const { request, expectedMachineId, expectedWorkspaceId } = args;

  if (request.machineId !== expectedMachineId) {
    return {
      ok: false,
      error: 'machine_mismatch',
      message: `Machine mismatch: expected ${expectedMachineId}`,
    };
  }

  if (!isRemoteLocalProjectControlRequest(request)) {
    return {
      ok: false,
      error: 'invalid_request',
      message: `Unsupported remote local project control request: ${request.type}`,
    };
  }

  const requesterUserId = request.requestedByUserId?.trim();
  if (!requesterUserId) {
    return {
      ok: false,
      error: 'invalid_request',
      message: 'Remote local project control requests require requestedByUserId',
    };
  }

  if (request.workspaceId !== expectedWorkspaceId) {
    return {
      ok: false,
      error: 'workspace_not_found',
      message: `Workspace mismatch: expected ${expectedWorkspaceId}`,
    };
  }

  return {
    ok: true,
    request,
    requesterUserId,
  };
}
