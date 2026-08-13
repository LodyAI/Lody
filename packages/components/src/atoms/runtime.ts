import { atom } from 'jotai';
import { LoroDoc } from 'loro-crdt';
import type { LoroRepo } from 'loro-repo';
import type {
  InferInputType,
  InferType,
  ClientToServer,
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  SessionCreateResponse,
  SessionCancelResponse,
  SessionChatResponse,
  SessionDispatchTurnResponse,
  SessionPreparationCancelSpec,
  SessionPreparationSpec,
  SessionPrepareCancelResponse,
  SessionPrepareResponse,
  SessionSteerResponse,
  SessionDocMeta,
  SessionTurnInputConfig,
  SessionId,
  TaskId,
  TaskDocInput,
  TaskDocState,
  MachineId,
  MachinePingResponse,
  MachineRestartResponse,
  MachineStatusResponse,
  MachineUpgradeResponse,
  MachineAcpCapabilitiesRefreshResponse,
  MachineAcpAuthenticateResponse,
  MachineAcpAuthenticationProgressMessage,
  MachineAcpBinaryStatusResponse,
  MachineAcpBinaryInstallResponse,
  MachineAcpBinaryProgressMessage,
  MachineBugReportResponse,
  SessionPreviewCreateResponse,
  SessionPreviewEndpointAcquireResponse,
  SessionPreviewEndpointReleaseResponse,
  SessionPreviewRevokeResponse,
  PreviewTarget,
  PreviewTargetApproval,
  WorkspaceId,
  LocalProjectId,
  previewVisualCommentDocSchema,
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
  CodeCollabV2SaveTextRequest,
  CodeCollabV2SaveTextResponse,
  FilePreviewV3Request,
  FilePreviewV3Response,
} from '@lody/shared';
import type { LocalProjectGitStateRpcResponse } from '@lody/loro-streams-rpc';
import type { WorkspaceWriter } from '../providers/workspace-writer';
import { sessionDocSchema } from '@lody/shared';
import { readStoredAuthToken } from '@/lib/auth-bootstrap';
import type { RoomSyncState } from '@/lib/room-sync-state';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from './workspace-context';

export type SessionDocState = InferType<typeof sessionDocSchema>;
export type SessionDocInput = InferInputType<typeof sessionDocSchema>;
export type PreviewVisualCommentDocState = InferType<typeof previewVisualCommentDocSchema>;
export type PreviewVisualCommentDocInput = InferInputType<typeof previewVisualCommentDocSchema>;

export type SessionDocUpdater =
  | Partial<SessionDocMeta>
  | Partial<SessionDocInput>
  | ((state: SessionDocMeta) => void)
  | ((state: Readonly<SessionDocMeta>) => SessionDocMeta)
  | ((state: Readonly<SessionDocInput>) => SessionDocInput);

export type SessionDocStore = {
  readonly sessionId: SessionId;
  readonly roomId: string;
  readonly doc: LoroDoc;
  readonly firstSynced: Promise<void>;
  acquireSync: () => () => void;
  getSyncState: () => RoomSyncState;
  subscribeSyncState: (listener: (state: RoomSyncState) => void) => () => void;
  getState: () => SessionDocState;
  setState: (updater: SessionDocUpdater) => void;
  subscribe: (listener: (state: SessionDocState) => void) => () => void;
  dispose: () => void;
  /**
   * Resolves when all pending local CRDT changes have been flushed to the server.
   * Returns immediately if there are no pending changes or transport is not ready.
   *
   * Pass an `AbortSignal` to make the wait cancellable: when the signal aborts,
   * the internal sync lease is released so a debounced room teardown can stop the
   * background join/SSE work instead of keeping it alive until it settles.
   */
  waitUntilSynced: (signal?: AbortSignal) => Promise<void>;
};

export type PreviewVisualCommentDocUpdater =
  | Partial<PreviewVisualCommentDocInput>
  | ((state: Readonly<PreviewVisualCommentDocInput>) => PreviewVisualCommentDocInput)
  | ((state: PreviewVisualCommentDocInput) => void);

export type PreviewVisualCommentDocStore = {
  readonly sessionId: SessionId;
  readonly roomId: string;
  readonly doc: LoroDoc;
  readonly firstSynced: Promise<void>;
  getSyncState: () => RoomSyncState;
  subscribeSyncState: (listener: (state: RoomSyncState) => void) => () => void;
  getState: () => PreviewVisualCommentDocState;
  setState: (updater: PreviewVisualCommentDocUpdater) => void;
  subscribe: (listener: (state: PreviewVisualCommentDocState) => void) => () => void;
  dispose: () => void;
  waitUntilSynced: () => Promise<void>;
};

export type TaskDocUpdater =
  | Partial<TaskDocInput>
  | ((state: Readonly<TaskDocInput>) => TaskDocInput)
  | ((state: TaskDocInput) => void);

export type TaskDocStore = {
  readonly taskId: TaskId;
  readonly roomId: string;
  readonly doc: LoroDoc;
  readonly firstSynced: Promise<void>;
  getSyncState: () => RoomSyncState;
  subscribeSyncState: (listener: (state: RoomSyncState) => void) => () => void;
  getState: () => TaskDocState;
  setState: (updater: TaskDocUpdater) => void;
  subscribe: (listener: (state: TaskDocState) => void) => () => void;
  dispose: () => void;
  waitUntilSynced: () => Promise<void>;
};

export type WorkspaceRuntime = {
  /**
   * The workspace slug used for caching the (slug, id) mapping.
   */
  readonly workspaceSlug: string;
  /**
   * The workspace id used for IndexedDB/WebSocket connections.
   */
  readonly workspaceId: WorkspaceId;
  readonly repo: LoroRepo;
  /**
   * The authored-write seam. Every durable repo mutation the renderer performs
   * goes through this instead of calling `repo.*` / `sessionStore.setState`
   * directly. Web authors directly. Electron selects per target: remote targets
   * author directly into the cloud plane, while the local target forwards an
   * intent to the CLI, which is its sole author. See
   * `providers/workspace-writer.ts`.
   */
  readonly writer: WorkspaceWriter;
  /** Resolve and register immutable session ownership before opening target rooms. */
  prepareSessionTarget: (
    sessionId: SessionId,
    machineId?: MachineId | null
  ) => Promise<'local' | 'cloud'>;
  setLocalMachineId: (machineId: MachineId | null) => void;
  setEagerSyncVisibleSessionIds: (
    sourceId: string,
    sessionIds: readonly SessionId[] | null
  ) => void;
  setAuthToken: (token: string | null) => Promise<void>;
  subscribeMachineMonitor: (
    machineId: MachineId,
    listener: (snapshot: import('@lody/shared').MachineMonitorSnapshot | null) => void
  ) => () => void;
  forceMachineMonitorSample: (machineId: MachineId) => void;
  /**
   * Publish (or clear, with null) the ephemeral `session-viewing` presence
   * entry for this app instance — the PR poller's activity signal.
   */
  publishSessionViewing: (args: { sessionId: SessionId; userId: string } | null) => void;
  ensureDocStream: (roomId: string) => Promise<void>;
  /**
   * Run `fn` while holding a ref on the session store, so cache eviction cannot
   * dispose + unload the doc mid-use. Prefer this over acquire/release pairs for
   * short-lived reads and writes; releasing only starts the warm-release timer.
   */
  withSessionStore: <T>(
    sessionId: SessionId,
    fn: (store: SessionDocStore) => Promise<T> | T
  ) => Promise<T>;
  releaseSessionStore: (sessionId: SessionId) => Promise<void>;
  acquireSessionStore: (sessionId: SessionId) => Promise<SessionDocStore>;
  releaseSessionStoreRef: (sessionId: SessionId) => void;
  withPreviewVisualCommentStore: <T>(
    sessionId: SessionId,
    fn: (store: PreviewVisualCommentDocStore) => Promise<T> | T
  ) => Promise<T>;
  releasePreviewVisualCommentStore: (sessionId: SessionId) => Promise<void>;
  acquirePreviewVisualCommentStore: (sessionId: SessionId) => Promise<PreviewVisualCommentDocStore>;
  releasePreviewVisualCommentStoreRef: (sessionId: SessionId) => void;
  withTaskStore: <T>(taskId: TaskId, fn: (store: TaskDocStore) => Promise<T> | T) => Promise<T>;
  releaseTaskStore: (taskId: TaskId) => Promise<void>;
  acquireTaskStore: (taskId: TaskId) => Promise<TaskDocStore>;
  releaseTaskStoreRef: (taskId: TaskId) => void;
  sendControl: (message: ClientToServer) => void;
  waitForSessionCreateResponse: (
    sessionId: SessionId,
    options?: { timeoutMs?: number }
  ) => Promise<SessionCreateResponse | null>;
  waitForSessionCancelResponse: (
    sessionId: SessionId,
    options?: { timeoutMs?: number }
  ) => Promise<SessionCancelResponse | null>;
  waitForSessionChatResponse: (
    sessionId: SessionId,
    userTurnId: string,
    options?: { timeoutMs?: number }
  ) => Promise<SessionChatResponse | null>;
  waitForMachineStatusResponse: (
    machineId: MachineId,
    options?: { timeoutMs?: number }
  ) => Promise<MachineStatusResponse | null>;
  waitForMachinePingResponse: (
    machineId: MachineId,
    requestId: string,
    options?: { timeoutMs?: number }
  ) => Promise<MachinePingResponse | null>;
  waitForMachineRestartResponse: (
    machineId: MachineId,
    requestId: string,
    options?: { timeoutMs?: number }
  ) => Promise<MachineRestartResponse | null>;
  waitForMachineUpgradeResponse: (
    machineId: MachineId,
    requestId: string,
    options?: { timeoutMs?: number }
  ) => Promise<MachineUpgradeResponse | null>;
  requestMachineAcpCapabilitiesRefresh: (
    request: Extract<ClientToServer, { type: 'machine/acp-capabilities-refresh' }>,
    options?: { signal?: AbortSignal }
  ) => Promise<MachineAcpCapabilitiesRefreshResponse | null>;
  waitForMachineAcpAuthenticateResponse: (
    machineId: MachineId,
    requestId: string,
    options?: { timeoutMs?: number }
  ) => Promise<MachineAcpAuthenticateResponse | null>;
  subscribeMachineAcpAuthenticationProgress: (
    machineId: MachineId,
    requestId: string,
    listener: (message: MachineAcpAuthenticationProgressMessage) => void
  ) => () => void;
  waitForMachineAcpBinaryStatusResponse: (
    machineId: MachineId,
    agentType: string,
    options?: { timeoutMs?: number }
  ) => Promise<MachineAcpBinaryStatusResponse | null>;
  waitForMachineAcpBinaryInstallResponse: (
    machineId: MachineId,
    agentType: string,
    options?: { timeoutMs?: number }
  ) => Promise<MachineAcpBinaryInstallResponse | null>;
  subscribeMachineAcpBinaryProgress: (
    machineId: MachineId,
    agentType: string,
    listener: (message: MachineAcpBinaryProgressMessage) => void
  ) => () => void;
  getMachineAcpBinaryProgress: (
    machineId: MachineId,
    agentType: string
  ) => MachineAcpBinaryProgressMessage | null;
  requestSessionCancel: (
    machineId: MachineId,
    sessionId: SessionId,
    turnId: string,
    options?: { timeoutMs?: number }
  ) => Promise<SessionCancelResponse | null>;
  requestSessionSteer: (
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
  ) => Promise<SessionSteerResponse | null>;
  requestSessionTerminate: (
    machineId: MachineId,
    sessionId: SessionId,
    options?: { timeoutMs?: number }
  ) => Promise<import('@lody/shared').SessionTerminateResponse | null>;
  requestSessionFork: (
    machineId: MachineId,
    args: import('@lody/shared').SessionForkSpec,
    options?: { timeoutMs?: number }
  ) => Promise<import('@lody/shared').SessionForkResponse | null>;
  requestSessionEditAndResend: (
    machineId: MachineId,
    args: import('@lody/shared').SessionEditAndResendSpec,
    options?: { timeoutMs?: number }
  ) => Promise<import('@lody/shared').SessionEditAndResendResponse | null>;
  requestSessionDispatchTurn: (
    machineId: MachineId,
    args: {
      sessionId: SessionId;
      userTurnId: string;
      userId: string;
      timestamp: string;
      inputConfig: SessionTurnInputConfig;
    },
    options?: { timeoutMs?: number }
  ) => Promise<SessionDispatchTurnResponse | null>;
  requestSessionPrepare: (
    machineId: MachineId,
    spec: SessionPreparationSpec,
    options?: { timeoutMs?: number }
  ) => Promise<SessionPrepareResponse | null>;
  requestSessionPrepareCancel: (
    machineId: MachineId,
    args: SessionPreparationCancelSpec,
    options?: { timeoutMs?: number }
  ) => Promise<SessionPrepareCancelResponse | null>;
  requestSessionPreviewCreate: (
    machineId: MachineId,
    sessionId: SessionId,
    requestedByUserId: string,
    target: PreviewTarget,
    approval: PreviewTargetApproval,
    options?: { replaceExisting?: boolean; timeoutMs?: number }
  ) => Promise<SessionPreviewCreateResponse | null>;
  resolveMachineTargetPlane: (
    machineId: MachineId,
    options?: { timeoutMs?: number }
  ) => Promise<'local' | 'cloud'>;
  requestSessionPreviewEndpointAcquire: (
    machineId: MachineId,
    sessionId: SessionId,
    requestedByUserId: string,
    target: PreviewTarget,
    options?: { timeoutMs?: number }
  ) => Promise<SessionPreviewEndpointAcquireResponse | null>;
  requestSessionPreviewEndpointRelease: (
    machineId: MachineId,
    sessionId: SessionId,
    endpointId: string,
    options?: { timeoutMs?: number }
  ) => Promise<SessionPreviewEndpointReleaseResponse | null>;
  /**
   * File Preview v3: read one file from the machine. Never activates Code Collab
   * there, and always resolves (transport failures come back as `status: 'error'`).
   */
  requestFilePreview: (
    machineId: MachineId,
    request: Omit<FilePreviewV3Request, 'v'>,
    options?: { timeoutMs?: number; ownerSessionId?: SessionId | string }
  ) => Promise<FilePreviewV3Response>;
  requestCodeCollabOpenText: (
    machineId: MachineId,
    request: CodeCollabV2OpenTextRequest,
    options?: { timeoutMs?: number; ownerSessionId?: SessionId | string }
  ) => Promise<CodeCollabV2OpenTextOk | CodeCollabV2Error | null>;
  requestCodeCollabRefreshText: (
    machineId: MachineId,
    request: CodeCollabV2RefreshTextRequest,
    options?: { timeoutMs?: number; ownerSessionId?: SessionId | string }
  ) => Promise<CodeCollabV2RefreshTextResponse | CodeCollabV2Error | null>;
  requestCodeCollabSaveText: (
    machineId: MachineId,
    request: CodeCollabV2SaveTextRequest,
    options?: { timeoutMs?: number; ownerSessionId?: SessionId | string }
  ) => Promise<CodeCollabV2SaveTextResponse | CodeCollabV2Error | null>;
  requestCodeCollabOpenCurrentDiff: (
    machineId: MachineId,
    request: CodeCollabV2OpenCurrentDiffRequest,
    options?: { timeoutMs?: number; ownerSessionId?: SessionId | string }
  ) => Promise<CodeCollabV2OpenCurrentDiffResponse | CodeCollabV2Error | null>;
  requestCodeCollabOpenAllChangesDiff: (
    machineId: MachineId,
    request: CodeCollabV2OpenAllChangesDiffRequest,
    options?: { timeoutMs?: number; ownerSessionId?: SessionId | string }
  ) => Promise<CodeCollabV2OpenAllChangesDiffResponse | CodeCollabV2Error | null>;
  requestCodeCollabOpenTurnDiff: (
    machineId: MachineId,
    request: CodeCollabV2OpenTurnDiffRequest,
    options?: { timeoutMs?: number; ownerSessionId?: SessionId | string }
  ) => Promise<CodeCollabV2OpenTurnDiffResponse | CodeCollabV2Error | null>;
  requestCodeCollabInitDirectory: (
    machineId: MachineId,
    request: CodeCollabV2InitDirectoryRequest,
    options?: { timeoutMs?: number; ownerSessionId?: SessionId | string }
  ) => Promise<CodeCollabV2InitDirectoryOk | CodeCollabV2Error | null>;
  requestCodeCollabLspDefinition: (
    machineId: MachineId,
    request: {
      readonly sessionId: SessionId;
      readonly path: string;
      readonly line?: number;
      readonly character?: number;
    },
    options?: { timeoutMs?: number; ownerSessionId?: SessionId | string }
  ) => Promise<CodeCollabV2LspUnsupported | CodeCollabV2Error | null>;
  requestCodeCollabLspReferences: (
    machineId: MachineId,
    request: {
      readonly sessionId: SessionId;
      readonly path: string;
      readonly line?: number;
      readonly character?: number;
    },
    options?: { timeoutMs?: number; ownerSessionId?: SessionId | string }
  ) => Promise<CodeCollabV2LspUnsupported | CodeCollabV2Error | null>;
  requestSessionPreviewRevoke: (
    machineId: MachineId,
    sessionId: SessionId,
    requestedByUserId: string,
    options?: { reason?: string; timeoutMs?: number }
  ) => Promise<SessionPreviewRevokeResponse | null>;
  requestLocalProjectGitState: (
    machineId: MachineId,
    localProjectId: LocalProjectId,
    requestedByUserId: string,
    options?: { timeoutMs?: number }
  ) => Promise<LocalProjectGitStateRpcResponse | null>;
  requestLocalProjectControl: (
    request: LocalProjectControlRequest,
    options?: { timeoutMs?: number }
  ) => Promise<LocalProjectControlResponse | null>;
  requestMachineBugReport: (
    machineId: MachineId,
    args: { description: string; reporterUserId: string; requestToken: string },
    options?: { timeoutMs?: number }
  ) => Promise<MachineBugReportResponse | null>;
  dispose: () => Promise<void>;
};

export const runtimeAtom = atom<WorkspaceRuntime | null>(null);

export type ActiveWorkspaceRuntimeState =
  | { status: 'ready'; runtime: WorkspaceRuntime }
  | {
      status: 'pending' | 'stale';
      runtime: null;
      rawRuntime: WorkspaceRuntime | null;
      reason: 'missing-runtime' | 'workspace-slug-mismatch' | 'workspace-id-mismatch';
    };

export function resolveActiveWorkspaceRuntimeState({
  runtime,
  workspaceId,
  workspaceSlug,
}: {
  runtime: WorkspaceRuntime | null;
  workspaceId: WorkspaceId | null;
  workspaceSlug: string | null;
}): ActiveWorkspaceRuntimeState {
  if (!runtime) {
    return { status: 'pending', runtime: null, rawRuntime: null, reason: 'missing-runtime' };
  }
  // The route slug is the earliest reliable workspace identity. Rejected:
  // treating `currentWorkspaceIdAtom` as authoritative here blocks offline-first
  // startup because it can briefly hold the previous server id during route switches.
  if (workspaceSlug && runtime.workspaceSlug !== workspaceSlug) {
    return {
      status: 'stale',
      runtime: null,
      rawRuntime: runtime,
      reason: 'workspace-slug-mismatch',
    };
  }
  if (workspaceSlug) {
    return { status: 'ready', runtime };
  }
  if (workspaceId && runtime.workspaceId !== workspaceId) {
    return {
      status: 'stale',
      runtime: null,
      rawRuntime: runtime,
      reason: 'workspace-id-mismatch',
    };
  }
  return { status: 'ready', runtime };
}

export const activeWorkspaceRuntimeStateAtom = atom((get) =>
  resolveActiveWorkspaceRuntimeState({
    runtime: get(runtimeAtom),
    workspaceId: get(currentWorkspaceIdAtom),
    workspaceSlug: get(currentWorkspaceSlugAtom),
  })
);

export const activeWorkspaceRuntimeAtom = atom((get) => {
  const state = get(activeWorkspaceRuntimeStateAtom);
  return state.status === 'ready' ? state.runtime : null;
});

export const authTokenAtom = atom<string | null>(readStoredAuthToken());
