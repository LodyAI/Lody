import {
  createServerTimeFetcher,
  getSessionIdFromRoomId,
  isLoroRepoDocDeleted,
  isSessionDocRoomId,
  isTimeSynced,
  syncTime,
  type LocalSessionControlRequest,
  type LocalSessionControlResponse,
  type LodyError,
  type MachineId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { Data, Effect } from 'effect';
import {
  IpcConnectError,
  IpcProtocolError,
  IpcTimeoutError,
  makeLocalControlClientAuto,
  makeLocalProbeClientAuto,
  type LocalControlClientAutoOptions,
  type LocalProbeClientAutoOptions,
} from '@lody/shared/node/local-ipc';
import { AuthClient } from '@/lib/auth';
import { LoroDocumentManager } from '@/lib/loro/doc';
import { listWorkspacesForToken, type WorkspaceSummary } from '@/lib/workspace';
import { LODY_AUTH_SITE_URL, LODY_AUTH_URL, LODY_SERVER_URL } from '@/utils/const';
import { initCliAnalytics } from '@/lib/analytics/posthog';
import { flushTelemetry } from '@/instrument';
import { getLogger, rootLogger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { findWorkspacesBySelector, formatWorkspaceCandidate } from '@/lib/workspace-selector';
import { listAliveRoomIds } from '@/lib/loro/repo-existence';
import {
  createCloudBillingPort,
  createCloudStreamsTokenPort,
  createCloudSessionSharingPort,
} from '@/lib/cloud-cli-port';
import { getCliPlatformKind } from '@/lib/cli-platform';
import type { CloudSessionSharingPort } from '@lody/platform';

export function getCommandSessionSharingPort(): CloudSessionSharingPort | null {
  if (getCliPlatformKind() !== 'cloud') return null;
  const auth = getAuthContextOrThrow('mcp-sharing');
  if (!LODY_AUTH_URL) throw new Error('Cloud sharing is not configured');
  return createCloudSessionSharingPort({ token: auth.token, authBaseUrl: LODY_AUTH_URL });
}

export { listAliveRoomIds } from '@/lib/loro/repo-existence';

const DEFAULT_LOCAL_CONTROL_TIMEOUT_MS = 30_000;
const DAEMON_HEALTH_PROBE_TIMEOUT_MS = 2_000;
export const DAEMON_NOT_RUNNING_MESSAGE =
  'Local CLI daemon is not running. Run `npx lody start` first.';
export const DAEMON_BUSY_MESSAGE =
  'Local CLI daemon did not answer in time. It may be busy; retry the request and reuse the same operationId when present.';
export const WORKSPACE_SYNC_UNAVAILABLE_MESSAGE =
  'Workspace synchronization is temporarily unavailable. Retry the request and reuse the same operationId when present.';

export class WorkspaceSyncUnavailableError extends Data.TaggedError(
  'WorkspaceSyncUnavailableError'
)<{
  message: string;
  cause?: unknown;
}> {
  toLodyError(): LodyError {
    return {
      code: 'SYNC_UNAVAILABLE',
      message: WORKSPACE_SYNC_UNAVAILABLE_MESSAGE,
      retryable: true,
    };
  }
}

export class LocalDaemonAvailabilityError extends Data.TaggedError('LocalDaemonAvailabilityError')<{
  code: 'DAEMON_NOT_RUNNING' | 'DAEMON_BUSY' | 'DAEMON_PROTOCOL_ERROR';
  message: string;
  retryable: boolean;
  cause?: unknown;
}> {
  toLodyError(): LodyError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function classifyLocalDaemonIpcError(
  error: IpcConnectError | IpcTimeoutError | IpcProtocolError
): LocalDaemonAvailabilityError {
  if (error instanceof IpcConnectError) {
    return new LocalDaemonAvailabilityError({
      code: 'DAEMON_NOT_RUNNING',
      message: DAEMON_NOT_RUNNING_MESSAGE,
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof IpcTimeoutError) {
    return new LocalDaemonAvailabilityError({
      code: 'DAEMON_BUSY',
      message: DAEMON_BUSY_MESSAGE,
      retryable: true,
      cause: error,
    });
  }
  const retryable =
    error.status === 408 ||
    error.status === 429 ||
    (typeof error.status === 'number' && error.status >= 500);
  const safeErrorCode =
    typeof error.errorCode === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.errorCode)
      ? error.errorCode
      : undefined;
  const safeValidationMessage =
    error.errorCode === undefined &&
    typeof error.status === 'number' &&
    error.status >= 200 &&
    error.status < 300
      ? error.message
      : undefined;
  return new LocalDaemonAvailabilityError({
    code: retryable ? 'DAEMON_BUSY' : 'DAEMON_PROTOCOL_ERROR',
    message: retryable
      ? `Local CLI daemon is temporarily unavailable${
          typeof error.status === 'number' ? ` (HTTP ${error.status})` : ''
        }; retry the request and reuse the same operationId when present.`
      : safeErrorCode
        ? `Local CLI daemon request failed: ${safeErrorCode}`
        : (safeValidationMessage ??
          `Local CLI daemon request failed${
            typeof error.status === 'number' ? ` (HTTP ${error.status})` : ''
          }.`),
    retryable,
    cause: error,
  });
}

type LocalIpcDiscoveryOptions = Pick<
  LocalProbeClientAutoOptions & LocalControlClientAutoOptions,
  'runFilePath' | 'socketPath'
>;

export type CommonCommandOptions = {
  workspace?: string;
  json?: boolean;
  jsonl?: boolean;
  debug?: boolean;
  offline?: boolean;
};

export type AuthContext = {
  token: string;
  userId: string;
  userName: string;
  userEmail: string;
  machineId: MachineId;
  machineName: string;
};

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

export function normalizeCliValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function formatWorkspaceCandidates(workspaces: WorkspaceSummary[]): string {
  return workspaces.map(formatWorkspaceCandidate).join(', ');
}

export function selectWorkspaceSummary(
  workspaces: WorkspaceSummary[],
  selector?: string
): WorkspaceSummary {
  const normalizedSelector = normalizeCliValue(selector);
  if (normalizedSelector) {
    const matches = findWorkspacesBySelector(workspaces, normalizedSelector);
    if (matches.length === 0) {
      throw new Error(
        `Workspace not found: ${normalizedSelector}. Candidates: ${formatWorkspaceCandidates(workspaces)}`
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Workspace selector is ambiguous: ${normalizedSelector}. Matches: ${formatWorkspaceCandidates(matches)}. Use a workspace id or slug instead.`
      );
    }
    return matches[0]!;
  }

  if (workspaces.length === 1) {
    return workspaces[0]!;
  }

  if (workspaces.length === 0) {
    throw new Error('No accessible workspaces found for the current CLI login.');
  }

  throw new Error(
    `Multiple workspaces are available; pass --workspace. Candidates: ${formatWorkspaceCandidates(workspaces)}`
  );
}

export function getAuthContextOrThrow(loggerName: string): AuthContext {
  const authClient = new AuthClient(getLogger(loggerName));
  const authInfo = authClient.getAuthInfo();
  if (!authInfo) {
    throw new Error('Not logged in. Run `lody login` first.');
  }

  return {
    token: authInfo.token,
    userId: authInfo.user.id,
    userName: normalizeCliValue(authInfo.user.name ?? undefined) ?? authInfo.user.email,
    userEmail: authInfo.user.email,
    machineId: authInfo.machine.machineId as MachineId,
    machineName: authInfo.machine.machineName,
  };
}

export async function resolveWorkspaceOrThrow(
  auth: AuthContext,
  selector?: string
): Promise<WorkspaceSummary> {
  const workspaces = await listWorkspacesForToken(auth.token);
  const effectiveSelector =
    normalizeCliValue(selector) ?? normalizeCliValue(process.env.LODY_WORKSPACE_ID);
  return selectWorkspaceSummary(workspaces, effectiveSelector);
}

export async function withWorkspaceManager<T>(
  auth: AuthContext,
  workspace: WorkspaceSummary,
  loggerName: string,
  fn: (manager: LoroDocumentManager) => Promise<T>
): Promise<T> {
  // One-shot commands write directly into the workspace repo and rely on
  // Loro Streams to reach the cloud (and the daemon); without the remote
  // transport the write would silently strand in the local SQLite store.
  if (!LODY_AUTH_URL) {
    throw new Error('Cloud workspace commands require LODY_AUTH_URL');
  }
  const logger = getLogger(loggerName);
  const manager = await LoroDocumentManager.create(
    workspace.id as WorkspaceId,
    auth.userId,
    logger,
    {
      attachRemoteOnCreate: true,
      streamsTokens: createCloudStreamsTokenPort({
        token: auth.token,
        authBaseUrl: LODY_AUTH_URL,
        authSiteUrl: LODY_AUTH_SITE_URL,
        logger,
      }),
      cloudBilling: createCloudBillingPort({ token: auth.token }),
    }
  );

  try {
    return await fn(manager);
  } finally {
    await manager.cleanUp({ fast: true, preserveSessionStatus: true }).catch((error: unknown) => {
      getLogger(loggerName).debug(
        `Failed to clean up workspace manager for ${workspace.id}: ${formatErrorMessage(error)}`
      );
    });
  }
}

export async function ensureWorkspaceMetaSynced(
  manager: Pick<LoroDocumentManager, 'waitUntilMetaSynced'>,
  reason: string
): Promise<void> {
  const synced = await manager.waitUntilMetaSynced({ reason });
  if (!synced) {
    throw new Error(
      `Workspace metadata changes were not confirmed by Loro Streams (${reason}). Retry the command after checking network connectivity.`
    );
  }
}

function buildOfflineHint(error: unknown): WorkspaceSyncUnavailableError {
  return new WorkspaceSyncUnavailableError({
    message: `${formatErrorMessage(error)} Use --offline to read the local cache without syncing.`,
    cause: error,
  });
}

export async function syncWorkspaceMetaForRead(
  manager: Pick<LoroDocumentManager, 'syncMetaOrThrow'>,
  reason: string
): Promise<void> {
  try {
    await manager.syncMetaOrThrow({ reason });
  } catch (error) {
    throw buildOfflineHint(error);
  }
}

export async function syncDocForRead(
  manager: Pick<LoroDocumentManager, 'syncDocOrThrow'>,
  docId: string,
  reason: string
): Promise<void> {
  try {
    await manager.syncDocOrThrow(docId, { reason });
  } catch (error) {
    throw buildOfflineHint(error);
  }
}

export async function listAliveDocMetas<Meta>(
  manager: LoroDocumentManager,
  predicate: (roomId: string) => boolean
): Promise<Array<{ roomId: string; meta: Meta }>> {
  const roomIds = await listAliveRoomIds(manager, predicate);
  const results = await Promise.all(
    roomIds.map(async (roomId) => {
      const record = await manager.repo.getDocMeta(roomId);
      if (!record?.meta || isLoroRepoDocDeleted(record)) {
        return null;
      }
      return { roomId, meta: record.meta as Meta };
    })
  );

  return results.filter((result): result is { roomId: string; meta: Meta } => result !== null);
}

/**
 * Lists Session metadata with identity normalized from the authoritative room key.
 * Session metadata is patchable CRDT state and may be sparse, so its embedded id
 * must not be trusted for discovery or identity.
 */
export async function listAliveSessionMetas(
  manager: LoroDocumentManager
): Promise<Array<{ roomId: string; meta: SessionMeta }>> {
  const rows = await listAliveDocMetas<SessionMeta>(manager, isSessionDocRoomId);
  return rows.flatMap(({ roomId, meta }) => {
    const id = getSessionIdFromRoomId(roomId);
    return id === null ? [] : [{ roomId, meta: { ...meta, id } }];
  });
}

function readLocalControlTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = normalizeCliValue(env.LODY_SESSION_LOCAL_CONTROL_TIMEOUT_MS);
  if (!raw) {
    return DEFAULT_LOCAL_CONTROL_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOCAL_CONTROL_TIMEOUT_MS;
  }
  return parsed;
}

export async function ensureDaemonReachable(options: LocalIpcDiscoveryOptions = {}): Promise<void> {
  // Connectivity check only, matching the original behavior (HTTP 2xx = running).
  // A 2xx whose body fails health validation still means the daemon is serving
  // the probe (e.g. CLI/daemon version skew), so we must not report it as down.
  const outcome = await Effect.runPromise(
    Effect.either(
      makeLocalProbeClientAuto(options).health({
        timeoutMs: DAEMON_HEALTH_PROBE_TIMEOUT_MS,
      })
    )
  );
  if (outcome._tag === 'Left') {
    if (
      outcome.left instanceof IpcProtocolError &&
      typeof outcome.left.status === 'number' &&
      outcome.left.status >= 200 &&
      outcome.left.status < 300
    ) {
      return;
    }
    throw classifyLocalDaemonIpcError(outcome.left);
  }
}

export async function dispatchLocalControl(
  message: LocalSessionControlRequest,
  options: LocalIpcDiscoveryOptions = {}
): Promise<LocalSessionControlResponse[]> {
  // Send the real request once. A health preflight doubles local IPC traffic and
  // cannot distinguish a daemon that exits between the probe and the request.
  const outcome = await Effect.runPromise(
    Effect.either(
      makeLocalControlClientAuto(options).sessionControl(message, {
        timeoutMs: readLocalControlTimeoutMs(),
      })
    )
  );
  if (outcome._tag === 'Left') {
    throw classifyLocalDaemonIpcError(outcome.left);
  }
  return outcome.right;
}

export function resolveStructuredOutputMode(
  options: Pick<CommonCommandOptions, 'json' | 'jsonl'>
): 'human' | 'json' | 'jsonl' {
  if (options.json && options.jsonl) {
    throw new Error('Pass either --json or --jsonl, not both.');
  }
  if (options.json) {
    return 'json';
  }
  if (options.jsonl) {
    return 'jsonl';
  }
  return 'human';
}

export async function syncCommandTime(loggerName: string): Promise<void> {
  if (isTimeSynced()) {
    return;
  }

  const serverUrl = normalizeCliValue(LODY_SERVER_URL);
  if (!serverUrl) {
    return;
  }

  try {
    await syncTime(createServerTimeFetcher(`${serverUrl}/api/time`));
  } catch (error) {
    getLogger(loggerName).debug(
      `Failed to sync time with server ${serverUrl}: ${formatErrorMessage(error)}`
    );
  }
}

function shouldForceExitProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST !== 'true' && env.NODE_ENV !== 'test';
}

async function flushWritableStream(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed || !stream.writable) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    stream.write('', (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function exitOneShotCommand(code: number): Promise<void> {
  process.exitCode = code;
  // Flush buffered analytics before the process can terminate: one-shot commands
  // may exit immediately and the flush timer is unref'd, so events would be lost.
  await flushTelemetry();
  if (!shouldForceExitProcess()) {
    return;
  }

  try {
    await Promise.all([flushWritableStream(process.stdout), flushWritableStream(process.stderr)]);
  } finally {
    process.exit(code);
  }
}

export async function runOneShotCommand(
  loggerName: string,
  options: Pick<CommonCommandOptions, 'json' | 'jsonl' | 'debug'>,
  action: () => Promise<void>
): Promise<void> {
  if (options.debug) {
    rootLogger.setDebug(true);
  }

  // Start the analytics poster once per one-shot command (idempotent; no-op without a key).
  initCliAnalytics();

  try {
    await syncCommandTime(loggerName);
    await action();
    await exitOneShotCommand(0);
  } catch (error) {
    const commandError =
      error && typeof error === 'object'
        ? (error as { suppressCommandErrorOutput?: boolean; exitCode?: number })
        : undefined;
    const message = formatErrorMessage(error);
    if (commandError?.suppressCommandErrorOutput !== true) {
      if (options.json || options.jsonl) {
        printJson({ ok: false, error: message });
      } else {
        getLogger(loggerName).error(message);
      }
    }
    await exitOneShotCommand(commandError?.exitCode ?? 1);
  }
}
