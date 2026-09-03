import { type ChildProcess } from 'child_process';
import path from 'path';
import * as fs from 'fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import type { SessionInfo } from '@agentclientprotocol/sdk';

import { spawnAcpProcess } from '@/agent/acp-runner';
import { withAcpSessionStartSlot } from '@/agent/acp-session-start-gate';
import { getLoginShellEnv } from '@/agent/login-shell-env';
import {
  mergeACPProcessEnv,
  mergeLoginShellEnv,
  resolveACPProcessLaunchAsync,
  withDefaultAcpPathEntries,
  type ResolvedACPProcessLaunch,
} from '@/agent/setting';
import { createStdinWritableStream, createStdoutReadableStream } from '@/utils/stream';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';
import {
  type AcpSessionNotification,
  parseSessionNotification,
  type ACPSessionId,
  getLocalProjectHistoryProviderKey,
  type LocalProjectHistoryProvider,
} from '@lody/shared';
import { LODY_EXTENSION_METHODS } from 'acp-extension-core';
import { MAX_LOCAL_PROJECT_HISTORY_CATALOG_SESSIONS } from '@lody/history-import';

const ACP_OPERATION_TIMEOUT_MS = 120_000;
const ACP_PROCESS_EXIT_TIMEOUT_MS = 3_000;

function waitForChildProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(child.exitCode !== null);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function signalChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    process.kill(-child.pid, signal);
    return;
  }
  child.kill(signal);
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  try {
    signalChildProcess(child, 'SIGTERM');
  } catch {
    return;
  }

  if (await waitForChildProcessExit(child, ACP_PROCESS_EXIT_TIMEOUT_MS)) {
    return;
  }

  try {
    signalChildProcess(child, 'SIGKILL');
  } catch {
    return;
  }
  await waitForChildProcessExit(child, ACP_PROCESS_EXIT_TIMEOUT_MS);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${ACP_OPERATION_TIMEOUT_MS}ms`)),
          ACP_OPERATION_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

class AcpReplayCollectorClient implements acp.Client {
  readonly notifications: AcpSessionNotification[] = [];

  async requestPermission(): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.notifications.push(parseSessionNotification(params));
  }
}

type HistoryAcpConnection = {
  agentProcess: ChildProcess;
  connection: acp.ClientSideConnection;
  collector: AcpReplayCollectorClient;
  initResponse: acp.InitializeResponse;
};

function getProviderLabel(provider: LocalProjectHistoryProvider): string {
  return getLocalProjectHistoryProviderKey(provider);
}

type ResolvedHistoryACPProcessLaunch = Omit<ResolvedACPProcessLaunch, 'env'> & {
  env: NodeJS.ProcessEnv;
};

export async function resolveHistoryACPProcessLaunch(args: {
  provider: LocalProjectHistoryProvider;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedHistoryACPProcessLaunch> {
  const launch = await resolveACPProcessLaunchAsync(args.provider);
  return {
    ...launch,
    env: mergeACPProcessEnv(launch, args.env ?? process.env),
  };
}

async function createHistoryAcpConnection(args: {
  provider: LocalProjectHistoryProvider;
  workdir: string;
  logger: Logger;
}): Promise<HistoryAcpConnection> {
  const launch = await resolveHistoryACPProcessLaunch({ provider: args.provider });
  // Same ENOENT trap as startLocalAcpAgent: a GUI/daemon launch inherits a
  // minimal PATH, so overlay the login-shell env (+ default fallback dirs) before
  // spawning the history-sync agent binary.
  const loginShellEnv = await getLoginShellEnv();
  const env = withDefaultAcpPathEntries(
    mergeLoginShellEnv(launch.env, loginShellEnv),
    args.provider.agentType
  );
  return await withAcpSessionStartSlot(
    {
      label: `${getProviderLabel(args.provider)}-history-sync`,
      logger: args.logger,
    },
    async () => {
      const agentProcess = spawnAcpProcess({
        cliType: args.provider.cliType,
        agentType: args.provider.agentType,
        workdir: args.workdir,
        env,
        command: launch.command,
        args: launch.args,
      });

      agentProcess.stderr?.setEncoding('utf8');
      agentProcess.stderr?.on('data', (chunk: string) => {
        if (!chunk) return;
        args.logger.debug(
          `[${getProviderLabel(args.provider)}-history-sync] ACP stderr: ${chunk.slice(0, 1200)}`
        );
      });

      if (!agentProcess.stdout || !agentProcess.stdin) {
        await terminateChildProcess(agentProcess);
        throw new Error(
          `${getProviderLabel(args.provider)} ACP process did not expose stdio streams`
        );
      }

      const output = createStdoutReadableStream(agentProcess.stdout);
      const input = createStdinWritableStream(agentProcess.stdin);
      const stream: Stream = ndJsonStream(input, output);
      const collector = new AcpReplayCollectorClient();
      const connection = new acp.ClientSideConnection(() => collector, stream);

      try {
        const initResponse = await withTimeout(
          connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              terminal: false,
              fs: {
                readTextFile: false,
                writeTextFile: false,
              },
            },
          }),
          `${getProviderLabel(args.provider)} ACP initialize`
        );
        return { agentProcess, connection, collector, initResponse };
      } catch (error) {
        await terminateChildProcess(agentProcess);
        throw error;
      }
    }
  );
}

async function resolveCatalogQueryPaths(rootPath: string): Promise<string[]> {
  const resolved = path.resolve(rootPath);
  let real: string | null = null;
  try {
    real = await fs.realpath(resolved);
  } catch {
    real = null;
  }

  const paths = [resolved];
  if (real && real !== resolved) {
    paths.push(real);
  }
  return paths;
}

export type HistorySessionCatalogResult = {
  sessions: SessionInfo[];
  queryPaths: string[];
};

export type HistorySessionCatalogPage = {
  sessions: SessionInfo[];
  nextCursor?: string | null;
};

type HistoryReplayConnection = Pick<acp.ClientSideConnection, 'loadSession' | 'request'>;

function getLodyReadSessionHistoryMethod(initResponse: acp.InitializeResponse): string | null {
  const meta = initResponse.agentCapabilities?._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const lody = (meta as Record<string, unknown>).lody;
  if (!lody || typeof lody !== 'object' || Array.isArray(lody)) return null;
  const capability = (lody as Record<string, unknown>).sessionHistory;
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return null;
  const record = capability as Record<string, unknown>;
  return record.version === 1 ? LODY_EXTENSION_METHODS.sessionHistoryRead : null;
}

export async function requestHistorySessionReplay(args: {
  provider: LocalProjectHistoryProvider;
  acpSessionId: ACPSessionId;
  cwd: string;
  connection: HistoryReplayConnection;
  initResponse: acp.InitializeResponse;
}): Promise<void> {
  if (args.provider.cliType === 'builtin' && args.provider.agentType === 'codex') {
    const method = getLodyReadSessionHistoryMethod(args.initResponse);
    if (!method) {
      throw new Error(
        `${getProviderLabel(args.provider)} ACP agent does not advertise ` +
          'agentCapabilities._meta.lody.sessionHistory version 1'
      );
    }
    await withTimeout(
      args.connection.request(method, {
        sessionId: args.acpSessionId as unknown as acp.SessionId,
      }),
      `${getProviderLabel(args.provider)} ACP session history read (${args.acpSessionId})`
    );
    return;
  }

  if (!args.initResponse.agentCapabilities?.loadSession) {
    throw new Error(`${getProviderLabel(args.provider)} ACP agent does not advertise loadSession`);
  }
  await withTimeout(
    args.connection.loadSession({
      sessionId: args.acpSessionId as unknown as acp.SessionId,
      cwd: args.cwd,
      mcpServers: [],
    }),
    `${getProviderLabel(args.provider)} ACP loadSession (${args.acpSessionId})`
  );
}

export async function listPaginatedHistorySessions(
  cwd: string,
  listPage: (params: { cwd: string; cursor?: string | null }) => Promise<HistorySessionCatalogPage>,
  options: {
    maxSessions?: number;
    requiredSessionIds?: ReadonlySet<string>;
  } = {}
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
  const requiredSessionIds = options.requiredSessionIds ?? new Set<string>();
  const foundRequiredSessionIds = new Set<string>();
  let cursor: string | null | undefined;
  while (sessions.length < maxSessions || foundRequiredSessionIds.size < requiredSessionIds.size) {
    const response = await listPage({ cwd, cursor });
    sessions.push(...response.sessions);
    for (const session of response.sessions) {
      if (requiredSessionIds.has(session.sessionId)) {
        foundRequiredSessionIds.add(session.sessionId);
      }
    }
    cursor = response.nextCursor;
    if (!cursor) break;
  }
  if (!Number.isFinite(maxSessions)) {
    return sessions;
  }
  return sessions.filter(
    (session, index) => index < maxSessions || requiredSessionIds.has(session.sessionId)
  );
}

export function dedupeHistorySessionsById(sessions: SessionInfo[]): SessionInfo[] {
  const bySessionId = new Map<string, SessionInfo>();
  for (const session of sessions) {
    bySessionId.set(session.sessionId, session);
  }
  return [...bySessionId.values()];
}

export async function listHistorySessionsForLocalProject(args: {
  provider: LocalProjectHistoryProvider;
  rootPath: string;
  logger: Logger;
  requiredSessionIds?: readonly string[];
}): Promise<HistorySessionCatalogResult> {
  const queryPaths = await resolveCatalogQueryPaths(args.rootPath);
  const bySessionId = new Map<string, SessionInfo>();
  const maxSessionsPerPath =
    args.provider.cliType === 'builtin' && args.provider.agentType === 'codex'
      ? MAX_LOCAL_PROJECT_HISTORY_CATALOG_SESSIONS
      : undefined;
  const requiredSessionIds = new Set(args.requiredSessionIds);

  for (const cwd of queryPaths) {
    const { agentProcess, connection, initResponse } = await createHistoryAcpConnection({
      provider: args.provider,
      workdir: cwd,
      logger: args.logger,
    });
    try {
      if (!initResponse.agentCapabilities?.sessionCapabilities?.list) {
        throw new Error(
          `${getProviderLabel(args.provider)} ACP agent does not advertise sessionCapabilities.list`
        );
      }
      const sessions = await listPaginatedHistorySessions(
        cwd,
        async ({ cursor }) =>
          withTimeout(
            connection.listSessions({ cwd, cursor }),
            `${getProviderLabel(args.provider)} ACP listSessions (${cwd})`
          ),
        { maxSessions: maxSessionsPerPath, requiredSessionIds }
      );
      for (const session of sessions) {
        bySessionId.set(session.sessionId, session);
      }
    } finally {
      await terminateChildProcess(agentProcess);
    }
  }

  return {
    sessions: [...bySessionId.values()],
    queryPaths,
  };
}

export async function loadHistorySessionReplay(args: {
  provider: LocalProjectHistoryProvider;
  rootPath: string;
  acpSessionId: ACPSessionId;
  logger: Logger;
}): Promise<AcpSessionNotification[]> {
  const cwd = path.resolve(args.rootPath);
  const { agentProcess, connection, collector, initResponse } = await createHistoryAcpConnection({
    provider: args.provider,
    workdir: cwd,
    logger: args.logger,
  });

  try {
    await requestHistorySessionReplay({
      provider: args.provider,
      acpSessionId: args.acpSessionId,
      cwd,
      connection,
      initResponse,
    });
    return collector.notifications;
  } catch (error) {
    const message = `Failed to load ${getProviderLabel(args.provider)} session ${
      args.acpSessionId
    }: ${formatErrorMessage(error)}`;
    throw new Error(message, { cause: error });
  } finally {
    await terminateChildProcess(agentProcess);
  }
}
