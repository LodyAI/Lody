import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { v4 as uuidV4 } from 'uuid';
import {
  createLoroStreamsJsonStreamClient,
  LORO_STREAMS_RPC_RETENTION_SECONDS,
  LORO_STREAMS_RPC_VERSION,
  LoroStreamsMachineRpcClient,
} from '@lody/loro-streams-rpc';
import {
  getLocalProjectGitStateAtRootPath,
  normalizeLocalProjectRootPath,
  resolveLocalProjectBranchAtRootPath,
  selectLocalProjectBranchSelector,
} from '@lody/shared/node/local-project';
import {
  type ACPSessionConfig,
  getLoroStreamsShardUrls,
  LORO_STREAMS_BUCKET_ID,
  type MessageContent,
  MachineStatusResponseSchema,
  SessionCancelResponseSchema,
  SessionStatusFactory,
  buildMachineArchiveSessionCommand,
  buildMachineDeleteSessionCommand,
  type BillingQuotaAdmission,
  countBillableSessionTurns,
  deleteMachineFlockRowFromFlock,
  evaluateBillingQuota,
  evaluateSessionCreateQuota,
  formatSessionQuotaRejection,
  FREE_SESSION_TURN_LIMIT,
  isBillingQuotaExempt,
  getAcpCapabilityCacheKey,
  getBuiltinDefaultModeId,
  getMachineFlockAcpCapabilities,
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  getMachineRoomId,
  machineFlockKeys,
  machineDeleteCommandToQueueItem,
  readMachineFlockRowsFromFlock,
  resolveActiveAssistantTurnId,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isMachineDocRoomId,
  isSessionDocRoomId,
  hasAgentRunConfigSelection,
  resolveAgentRunConfigSelection,
  resolveBaseBranchPreference,
  resolveProjectGitHubRepo,
  type AgentRunConfigSelection,
  type AcpCapabilityCacheEntry,
  type AcpConfigOptionSummary,
  type AgentConfigMeta,
  type AgentRoleId,
  type LocalProjectGitState,
  type LocalProjectId,
  type MachineLegacyMetaFields,
  type MachineId,
  type MachineMeta,
  type ProjectRef,
  type SessionDocMeta,
  type SessionHistory,
  type SessionHistoryInput,
  type SessionQuotaKind,
  type SessionTurnInputConfig,
  type SessionId,
  type SessionMeta,
  type TaskId,
  type WorkspaceId,
  shouldQueueMachineDeleteSession,
  writeMachineFlockRowToFlock,
  type MachineFlockKey,
  type MachineFlockRow,
} from '@lody/shared';
import { prepareCliStreamsGatewayBaseUrl } from '@/lib/loro/streams-access';
import { AuthClient } from '@/lib/auth';
import {
  dispatchLocalControl,
  ensureWorkspaceMetaSynced,
  listAliveDocMetas,
  listAliveSessionMetas,
  listAliveRoomIds,
  LocalDaemonAvailabilityError,
  normalizeCliValue,
  printJson,
  resolveStructuredOutputMode as resolveOutputMode,
  selectWorkspaceSummary,
  syncDocForRead,
  syncCommandTime,
  syncWorkspaceMetaForRead,
  type AuthContext,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { LoroDocumentManager, type SessionDocument } from '@/lib/loro/doc';
import { renderTerminalTable } from '@/lib/terminal-table';
import {
  canRequestMachineForCliToken,
  canUseMachineForCliToken,
  type WorkspaceBillingEntitlement,
  listWorkspaceGitHubRepositoriesForCliToken,
  listWorkspacesForToken,
  type MachineAccessCheckResult,
  type WorkspaceSummary,
} from '@/lib/workspace';
import { readMachineLocalProjects } from '@/lib/local-project-meta';
import { linkTaskSessionFromCli } from '@/lib/task-doc';
import { listMergedAgentConfigs } from '@/lib/agent-config-machine-flock';
import { getLogger, rootLogger } from '@/utils/logger';
import { parseEnvAssignments } from './agent-config';
import { formatErrorMessage } from '@/utils/format-error';
import {
  SessionTurnWaitError,
  type SessionTurnOutputEvent,
  type StructuredSessionOutputMode,
  waitForTurnCompletion,
} from './session-output';
import { flushTelemetry } from '@/instrument';
import { captureSessionCommandEvent } from './analytics-events';
import { LODY_AUTH_SITE_URL, LODY_AUTH_URL } from '@/utils/const';
import { createCloudBillingPort, createCloudStreamsTokenPort } from '@/lib/cloud-cli-port';
import { getCliHttpFetch } from '@/utils/http-transport';

type CommonOptions = CommonCommandOptions;

export type DelegatedSessionRequester = {
  userId: string;
};

type ResolvedSessionRequester = {
  userId: string;
  isDelegated: boolean;
};

export const DEFAULT_SESSION_LIST_LIMIT = 50;
export const MAX_MCP_SESSION_LIST_LIMIT = 200;
export const DEFAULT_SESSION_HISTORY_LIMIT = 50;
export const MAX_MCP_SESSION_HISTORY_LIMIT = 200;

type PromptOptions = {
  prompt?: string;
  promptFile?: string;
};

export type CreateOptions = CommonOptions &
  PromptOptions & {
    title?: string;
    machine?: string;
    agent?: string;
    agentConfig?: string;
    currentSessionId?: SessionId;
    defaultMachineId?: MachineId;
    requesterUserId?: string;
    /** Trusted human requester supplied by a delegated internal caller. */
    delegatedRequester?: DelegatedSessionRequester;
    sessionOwnerUserId?: string;
    parent?: string;
    useCurrentSessionAsParent?: boolean;
    repo?: string;
    localProject?: string;
    worktree?: boolean;
    branch?: string;
    mode?: string;
    model?: string;
    configOption?: string[];
    env?: string[];
    wait?: boolean;
    timeout?: number;
    /** Stable ids preallocated by durable orchestration recovery. */
    sessionId?: SessionId;
    userTurnId?: string;
    /** Lody-originated execution-chain depth for the initial input. */
    chainDepth?: number;
    /** Agent Role provenance frozen when the create Operation is accepted. */
    agentRoleId?: string;
    agentRoleRevision?: number;
    /**
     * Task this session belongs to. Inherited from the invoking session when it
     * is itself working on a task, so an agent spawning helpers keeps the whole
     * fan-out attached to the same task.
     */
    taskId?: string;
    /** Provenance for the task link; automation starts are runs, spawns inherit. */
    taskLinkOrigin?: 'run' | 'agent-spawn';
    /** Durable batch Operations intentionally bypass cooperative session quotas. */
    bypassSessionQuota?: boolean;
    /**
     * Trusted internal marker for a create whose caller already completed the
     * request-level workspace Meta read before accepting durable target ids.
     * Materialization/replay must not add a second remote read barrier.
     */
    workspaceMetaPrewriteSatisfied?: boolean;
  };

export type ChatOptions = CommonOptions &
  PromptOptions & {
    mode?: string;
    model?: string;
    configOption?: string[];
    wait?: boolean;
    timeout?: number;
  };

export async function ensureSessionCreateWorkspaceMetaFresh(args: {
  manager: Pick<LoroDocumentManager, 'syncMetaOrThrow'>;
  workspaceId: WorkspaceId;
  prewriteSatisfied: boolean;
}): Promise<void> {
  if (args.prewriteSatisfied) return;
  await syncWorkspaceMetaForRead(args.manager, `session.create:${args.workspaceId}:prewrite`);
}

type ListOptions = CommonOptions & {
  archived?: boolean;
  all?: boolean;
  limit?: number;
  openedBy?: string;
  openedByCurrent?: boolean;
};

type RenameOptions = CommonOptions & {
  title?: string;
};

type HistoryOptions = CommonOptions & {
  all?: boolean;
  limit?: number;
  reverse?: boolean;
};

type ResolveWorkspaceForSessionOptions =
  | string
  | {
      workspace?: string;
      offline?: boolean;
      reason: string;
    };

type SessionShowResult = {
  workspace: WorkspaceSummary;
  session: SessionMeta;
  historyCount: number;
  latestHistoryAt?: string;
  messageQueueCount: number;
};

type SessionStatusResult = {
  workspace: WorkspaceSummary;
  sessionId: SessionId;
  status: SessionMeta['status'];
  liveStatus: {
    state: 'idle' | 'initializing' | 'running' | 'waiting' | 'unavailable' | 'unknown';
    source: 'machine' | 'none';
    reason?: string;
  };
  machineId: MachineId;
  machineOnline: boolean;
  agent: {
    cliType: SessionMeta['cliType'];
    agentType: SessionMeta['agentType'];
    agentConfigId?: SessionMeta['agentConfigId'];
  };
  archived: boolean;
  activeTurn?: {
    assistantTurnId: string;
    processingUserMsgId?: string;
    latestUserMsgId?: string;
  };
  openedBySessionId?: SessionId;
  openedByRootSessionId?: SessionId;
  parentSessionId?: SessionId;
  latestUserMsgId?: string;
  processingUserMsgId?: string;
  lastHandledUserMsgId?: string;
};

type SessionTranscriptRole = Extract<SessionHistoryInput['role'], 'user' | 'assistant' | 'system'>;

export type SessionTranscriptEntry = {
  index: number;
  id: string;
  role: SessionTranscriptRole;
  timestamp: string;
  text: string;
};

type PromptStdinState = {
  wasRead: boolean;
  text?: string;
};

type SessionCreateRollbackManager = {
  repo: {
    deleteDoc(roomId: string): Promise<void>;
  };
  cleanSessionDoc(sessionId: SessionId, options?: { preserveStatus?: boolean }): Promise<void>;
};

type LocalProjectSelectorCandidate = {
  id: string;
  name?: string | null;
  rootPath?: string | null;
};

type ResolvedCreateContext = {
  targetMachine: MachineMeta;
  agentConfig: AgentConfigMeta;
  project?: ProjectRef;
  parentSessionId?: SessionId;
  openedBySessionId?: SessionId;
  openedByRootSessionId?: SessionId;
  taskId?: TaskId;
};

type SessionActivityTimestampManager = {
  repo: {
    getDocMeta(roomId: string): Promise<{ meta?: unknown; deleted?: boolean } | undefined>;
    upsertDocMeta(roomId: string, meta: Partial<SessionMeta>): Promise<unknown>;
  };
};

// Re-export for backward compatibility with tests
export { normalizeCliValue, selectWorkspaceSummary };

export function resolvePromptCandidate(input: {
  prompt?: string;
  promptFileContent?: string;
  positionalPrompt?: string;
  stdinText?: string;
}): string | undefined {
  return (
    normalizeCliValue(input.prompt) ??
    normalizeCliValue(input.promptFileContent) ??
    normalizeCliValue(input.positionalPrompt) ??
    normalizeCliValue(input.stdinText)
  );
}

export function sortSessionMetas(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((left, right) => {
    const leftCreatedAt = Date.parse(left.createdAt);
    const rightCreatedAt = Date.parse(right.createdAt);
    const leftTime = left.lastMessageAt ?? (Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0);
    const rightTime = right.lastMessageAt ?? (Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0);
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return right.id.localeCompare(left.id);
  });
}

export function filterSessionMetas(
  sessions: SessionMeta[],
  options: { archivedOnly?: boolean; includeAll?: boolean; openedBySessionId?: SessionId }
): SessionMeta[] {
  let result: SessionMeta[];
  if (options.includeAll) {
    result = [...sessions];
  } else if (options.archivedOnly) {
    result = sessions.filter((session) => session.isArchived === true);
  } else {
    result = sessions.filter((session) => session.isArchived !== true);
  }
  if (options.openedBySessionId) {
    result = result.filter((session) => session.openedBySessionId === options.openedBySessionId);
  }
  return result;
}

function formatAgentConfigCandidates(configs: AgentConfigMeta[]): string {
  return configs
    .map((config) => `${config.name} (${config.id})`)
    .sort((left, right) => left.localeCompare(right))
    .join(', ');
}

function selectUniqueAgentConfigByIdOrName(
  configs: AgentConfigMeta[],
  selector: string
): AgentConfigMeta {
  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector) {
    throw new Error('Missing agent config selector.');
  }

  const idMatch = configs.find((config) => config.id === normalizedSelector);
  if (idMatch) {
    return idMatch;
  }

  const nameMatches = configs.filter(
    (config) => normalizeCliValue(config.name) === normalizedSelector
  );
  if (nameMatches.length === 1) {
    return nameMatches[0]!;
  }
  if (nameMatches.length > 1) {
    throw new Error(
      `Agent config selector is ambiguous: ${normalizedSelector}. Use an id instead. Candidates: ${formatAgentConfigCandidates(configs)}`
    );
  }

  throw new Error(
    `Agent config not found: ${normalizedSelector}. Candidates: ${formatAgentConfigCandidates(configs)}`
  );
}

export function resolveCreateAgentSelector(options: {
  agent?: string;
  agentConfig?: string;
}): string | undefined {
  const agent = normalizeCliValue(options.agent);
  const agentConfig = normalizeCliValue(options.agentConfig);
  if (agent && agentConfig && agent !== agentConfig) {
    throw new Error('Pass either --agent or --agent-config, not both.');
  }
  return agentConfig ?? agent;
}

function buildAgentPrompt(prompt: string, agentPrompt = ''): string {
  return [agentPrompt, prompt].filter((part) => part?.trim()).join('\n\n');
}

function parsePositiveIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

const resolveStructuredOutputMode = resolveOutputMode;

export function shouldWaitForSessionCompletion(options: {
  wait?: boolean;
  json?: boolean;
  jsonl?: boolean;
}): boolean {
  return options.wait === true;
}

function isTranscriptRole(role: SessionHistoryInput['role']): role is SessionTranscriptRole {
  return role === 'user' || role === 'assistant' || role === 'system';
}

function formatTranscriptImage(item: Extract<MessageContent, { type: 'image' }>): string {
  const fileName = normalizeCliValue(item.fileName);
  return fileName ? `[image: ${fileName}]` : '[image]';
}

function formatVisibleTranscriptItem(item: MessageContent): string | undefined {
  if (item.type === 'text') {
    return normalizeCliValue(item.text);
  }

  if (item.type === 'image') {
    return formatTranscriptImage(item);
  }

  if (item.type === 'image_group') {
    const parts = item.images.map((image) => formatTranscriptImage({ type: 'image', ...image }));
    return parts.join('\n\n').trim() || undefined;
  }

  if (item.type === 'operation_completion') {
    return JSON.stringify({
      type: item.type,
      deliveryId: item.deliveryId,
      operationId: item.operationId,
      operationKind: item.operationKind,
      completion: item.completion,
      ...(item.continuation ? { continuation: item.continuation } : {}),
    });
  }

  return undefined;
}

function extractTranscriptText(
  items: MessageContent[] | undefined,
  role: SessionTranscriptRole
): string | undefined {
  if (role === 'assistant') {
    let lastVisible: string | undefined;
    for (const item of items ?? []) {
      const visible = formatVisibleTranscriptItem(item);
      if (visible) {
        lastVisible = visible;
      }
    }
    return lastVisible;
  }

  const parts: string[] = [];
  for (const item of items ?? []) {
    const visible = formatVisibleTranscriptItem(item);
    if (visible) {
      parts.push(visible);
    }
  }

  const text = parts.join('\n\n').trim();
  return text || undefined;
}

export function toSessionTranscriptEntries(
  history: SessionHistoryInput[]
): SessionTranscriptEntry[] {
  const entries: SessionTranscriptEntry[] = [];

  for (const [index, entry] of history.entries()) {
    if (!isTranscriptRole(entry.role)) {
      continue;
    }
    if (
      entry.role === 'system' &&
      !entry.items?.some((item) => item.type === 'operation_completion')
    ) {
      continue;
    }

    const text = extractTranscriptText(entry.items as MessageContent[] | undefined, entry.role);
    if (!text) {
      continue;
    }

    entries.push({
      index,
      id: entry.id,
      role: entry.role,
      timestamp: entry.timestamp,
      text,
    });
  }

  return entries;
}

export function selectSessionTranscriptEntries(
  entries: SessionTranscriptEntry[],
  options: { all?: boolean; limit?: number; reverse?: boolean }
): SessionTranscriptEntry[] {
  const selected = options.all ? [...entries] : entries.slice(-1 * (options.limit ?? 50));
  if (options.reverse) {
    selected.reverse();
  }
  return selected;
}

export function renderSessionTranscript(entries: SessionTranscriptEntry[]): string {
  if (entries.length === 0) {
    return 'No visible history found.';
  }

  return entries
    .map((entry) => `[${entry.role}] ${entry.timestamp} ${entry.id}\n${entry.text}`)
    .join('\n\n');
}

export function renderAssistantTurnCompletion(content: MessageContent[]): string {
  return extractTranscriptText(content, 'assistant') ?? 'No visible assistant reply found.';
}

async function readStdinText(): Promise<string> {
  const chunks: string[] = [];
  return await new Promise<string>((resolve, reject) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

async function readPromptStdinState(): Promise<PromptStdinState> {
  if (process.stdin.isTTY) {
    return { wasRead: false };
  }

  return {
    wasRead: true,
    text: resolvePromptCandidate({ stdinText: await readStdinText() }),
  };
}

export function hasNonPositionalPromptSource(input: {
  prompt?: string;
  promptFile?: string;
  stdinText?: string;
}): boolean {
  return (
    normalizeCliValue(input.prompt) !== undefined ||
    normalizeCliValue(input.promptFile) !== undefined ||
    normalizeCliValue(input.stdinText) !== undefined
  );
}

export function shouldReadStdinForChatArgResolution(input: {
  sessionIdArg?: string;
  promptArg?: string;
  envSessionId?: string;
  prompt?: string;
  promptFile?: string;
  stdinIsTty: boolean;
}): boolean {
  if (input.stdinIsTty) {
    return false;
  }

  if (hasNonPositionalPromptSource({ prompt: input.prompt, promptFile: input.promptFile })) {
    return false;
  }

  return (
    normalizeCliValue(input.sessionIdArg) !== undefined &&
    normalizeCliValue(input.promptArg) === undefined &&
    normalizeCliValue(input.envSessionId) !== undefined
  );
}

async function readPromptText(
  options: PromptOptions,
  positionalPrompt?: string,
  stdinState: PromptStdinState = { wasRead: false }
): Promise<string> {
  const explicitPrompt = normalizeCliValue(options.prompt);
  if (explicitPrompt) {
    return explicitPrompt;
  }

  const promptFile = normalizeCliValue(options.promptFile);
  if (promptFile) {
    const fileContent =
      promptFile === '-'
        ? stdinState.wasRead
          ? (stdinState.text ?? '')
          : await readStdinText()
        : await fs.readFile(promptFile, 'utf8');
    const resolved = resolvePromptCandidate({ promptFileContent: fileContent });
    if (!resolved) {
      throw new Error(`Prompt input is empty: ${promptFile}`);
    }
    return resolved;
  }

  const positional = normalizeCliValue(positionalPrompt);
  if (positional) {
    return positional;
  }

  if (stdinState.wasRead) {
    if (stdinState.text) {
      return stdinState.text;
    }
  } else if (!process.stdin.isTTY) {
    const resolved = resolvePromptCandidate({ stdinText: await readStdinText() });
    if (resolved) {
      return resolved;
    }
  }

  throw new Error(
    'Missing prompt. Pass a positional prompt, --prompt, --prompt-file, or pipe stdin.'
  );
}

function collectListOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function resolveRenameArgs(input: {
  sessionIdArg?: string;
  titleArg?: string;
  optionTitle?: string;
  envSessionId?: string;
}): { sessionId: SessionId; title: string } {
  const sessionIdArg = normalizeCliValue(input.sessionIdArg);
  const titleArg = normalizeCliValue(input.titleArg);
  const optionTitle = normalizeCliValue(input.optionTitle);
  const envSessionId = normalizeCliValue(input.envSessionId);

  if (optionTitle) {
    const sessionId = sessionIdArg ?? envSessionId;
    if (!sessionId) {
      throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
    }
    return {
      sessionId: sessionId as SessionId,
      title: optionTitle,
    };
  }

  if (titleArg) {
    const sessionId = sessionIdArg ?? envSessionId;
    if (!sessionId) {
      throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
    }
    return {
      sessionId: sessionId as SessionId,
      title: titleArg,
    };
  }

  if (sessionIdArg && envSessionId) {
    throw new Error(
      'Missing title. When LODY_SESSION_ID is set, pass --title to rename that session or provide both <sessionId> <title>.'
    );
  }

  if (!sessionIdArg && envSessionId) {
    throw new Error('Missing title. Pass it positionally or with --title.');
  }

  if (sessionIdArg) {
    throw new Error('Missing title. Pass it positionally or with --title.');
  }

  throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
}

export function resolveChatArgs(input: {
  sessionIdArg?: string;
  promptArg?: string;
  envSessionId?: string;
  hasNonPositionalPromptSource?: boolean;
}): { sessionId: SessionId; positionalPrompt?: string } {
  const sessionIdArg = normalizeCliValue(input.sessionIdArg);
  const promptArg = normalizeCliValue(input.promptArg);
  const envSessionId = normalizeCliValue(input.envSessionId);

  if (promptArg) {
    const sessionId = sessionIdArg ?? envSessionId;
    if (!sessionId) {
      throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
    }
    return {
      sessionId: sessionId as SessionId,
      positionalPrompt: promptArg,
    };
  }

  if (sessionIdArg && envSessionId && !input.hasNonPositionalPromptSource) {
    return {
      sessionId: envSessionId as SessionId,
      positionalPrompt: sessionIdArg,
    };
  }

  const sessionId = sessionIdArg ?? envSessionId;
  if (!sessionId) {
    throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
  }

  return {
    sessionId: sessionId as SessionId,
  };
}

export async function rollbackPendingSessionCreate(
  manager: SessionCreateRollbackManager,
  sessionId: SessionId,
  logger: Pick<ReturnType<typeof getLogger>, 'warn'> = getLogger('session')
): Promise<void> {
  const sessionRoomId = getSessionRoomId(sessionId);

  try {
    await manager.repo.deleteDoc(sessionRoomId);
  } catch (error) {
    logger.warn(
      `Failed to delete session metadata during rollback for ${sessionId}: ${formatErrorMessage(
        error
      )}`
    );
  }

  try {
    await manager.cleanSessionDoc(sessionId, { preserveStatus: true });
  } catch (error) {
    logger.warn(
      `Failed to clean session document during rollback for ${sessionId}: ${formatErrorMessage(
        error
      )}`
    );
  }
}

function getAuthContextOrThrow(): AuthContext {
  const authClient = new AuthClient(getLogger('session'));
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

async function withWorkspaceManager<T>(
  auth: AuthContext,
  workspace: WorkspaceSummary,
  fn: (manager: LoroDocumentManager) => Promise<T>
): Promise<T> {
  // One-shot commands need the remote Streams transport so their writes reach
  // the cloud (and the daemon) instead of stranding in the local SQLite store.
  if (!LODY_AUTH_URL) {
    throw new Error('Cloud session commands require LODY_AUTH_URL');
  }
  const logger = getLogger('session');
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
      getLogger('session').warn(
        `Failed to clean up workspace manager for ${workspace.id}: ${formatErrorMessage(error)}`
      );
    });
  }
}

async function listSessionMetasForWorkspace(manager: LoroDocumentManager): Promise<SessionMeta[]> {
  return (await listAliveSessionMetas(manager)).map((entry) => entry.meta);
}

/**
 * Session quotas are cooperative, so the entitlement only has to select the
 * plan (see context/billing-entitlements.md). Caching the in-flight promise
 * keeps create / chat off the network on the prompt hot path — and collapses
 * concurrent callers onto one query — while still noticing a plan change
 * within a minute.
 */
const BILLING_ENTITLEMENT_CACHE_TTL_MS = 60_000;
const billingEntitlementCache = new Map<
  string,
  {
    port: NonNullable<LoroDocumentManager['cloudBilling']>;
    expiresAt: number;
    entitlement: Promise<WorkspaceBillingEntitlement>;
  }
>();

async function getWorkspaceBillingEntitlementBestEffort(
  manager: LoroDocumentManager,
  workspace: WorkspaceSummary
): Promise<WorkspaceBillingEntitlement | null> {
  const port = manager.cloudBilling;
  if (!port) {
    return null;
  }
  const now = getServerNow();
  let entry = billingEntitlementCache.get(workspace.id);
  if (!entry || entry.port !== port || entry.expiresAt <= now) {
    entry = {
      port,
      expiresAt: now + BILLING_ENTITLEMENT_CACHE_TTL_MS,
      entitlement: port.getWorkspaceEntitlement(workspace.id as WorkspaceId),
    };
    billingEntitlementCache.set(workspace.id, entry);
  }
  try {
    return await entry.entitlement;
  } catch (error) {
    // A failure must not be cached for the rest of the TTL.
    if (billingEntitlementCache.get(workspace.id) === entry) {
      billingEntitlementCache.delete(workspace.id);
    }
    getLogger('session').warn(
      `Billing entitlement unavailable; allowing local operation: ${formatErrorMessage(error)}`
    );
    return null;
  }
}

function assertQuotaAdmission(admission: BillingQuotaAdmission, kind: SessionQuotaKind): void {
  if (admission.allowed) return;
  throw new Error(formatSessionQuotaRejection(kind, admission));
}

async function assertSessionCreateQuota(args: {
  workspace: WorkspaceSummary;
  manager: LoroDocumentManager;
  sessionId?: SessionId;
}): Promise<void> {
  if (args.sessionId) {
    const existing = await args.manager.repo.getDocMeta(getSessionRoomId(args.sessionId));
    if (existing?.meta && !isLoroRepoDocDeleted(existing)) {
      return;
    }
  }

  // The count is the expensive part, so settle the plan first: an exempt
  // workspace never has to pay for the scan.
  const entitlement = await getWorkspaceBillingEntitlementBestEffort(args.manager, args.workspace);
  if (!entitlement || isBillingQuotaExempt(entitlement)) return;
  // Existence rows already carry the count; materializing every session's meta
  // just to take a length is the expensive way to ask.
  const sessionCount = (await listAliveRoomIds(args.manager, isSessionDocRoomId)).length;
  assertQuotaAdmission(
    evaluateSessionCreateQuota({ ...entitlement, sessionCount }),
    'session_create'
  );
}

async function checkSessionTurnQuotaAndReadHistory(args: {
  manager: LoroDocumentManager;
  workspace: WorkspaceSummary;
  sessionDoc: SessionDocument;
  userTurnId?: string;
}): Promise<SessionHistory[] | undefined> {
  // Same ordering as session create: settle the plan before reading the doc.
  const entitlement = await getWorkspaceBillingEntitlementBestEffort(args.manager, args.workspace);
  if (!entitlement || isBillingQuotaExempt(entitlement)) return undefined;
  const [history, queue] = await Promise.all([
    args.sessionDoc.getHistory(),
    args.sessionDoc.getMessageQueue(),
  ]);
  if (
    args.userTurnId &&
    (history.some((entry) => entry.id === args.userTurnId) ||
      queue.some((item) => item.userTurnId === args.userTurnId))
  ) {
    return history;
  }
  assertQuotaAdmission(
    evaluateBillingQuota({
      ...entitlement,
      current: countBillableSessionTurns({ history, queue }),
      limit: FREE_SESSION_TURN_LIMIT,
    }),
    'session_turn'
  );
  return history;
}

export async function listChildSessionIds(
  manager: LoroDocumentManager,
  parentSessionId: SessionId
): Promise<SessionId[]> {
  return (await listSessionMetasForWorkspace(manager))
    .filter(
      (session) => session.parentSessionId === parentSessionId && session.id !== parentSessionId
    )
    .map((session) => session.id);
}

async function applySessionAndChildren(
  sessionId: SessionId,
  childSessionIds: SessionId[],
  apply: (sessionId: SessionId) => Promise<void>
): Promise<void> {
  await Promise.all([sessionId, ...childSessionIds].map(apply));
}

async function syncMachineFlockDocsForRead(
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  machineIds: readonly MachineId[],
  reason: string
): Promise<void> {
  await Promise.all(
    Array.from(new Set(machineIds)).map(
      async (machineId) =>
        await manager.syncFlockDocOrThrow(getMachineFlockDocId(workspaceId, machineId), {
          reason: `${reason}:${machineId}`,
        })
    )
  );
}

export async function resolveLocalProjectRefOrThrow(
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  selector: string,
  requestedBranch?: string,
  useWorktree?: boolean
): Promise<ProjectRef> {
  await syncMachineFlockDocsForRead(manager, workspaceId, [machineId], 'session.local-projects');
  const localProjects = Object.values(
    await readMachineLocalProjects(manager.repo, workspaceId, machineId)
  );
  if (localProjects.length === 0) {
    throw new Error('No local project is registered on this machine for the target workspace.');
  }

  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector) {
    throw new Error('Missing local project selector.');
  }

  const matches = selectLocalProjectsBySelector(localProjects, normalizedSelector);

  if (matches.length === 0) {
    throw new Error(
      `Local project not found: ${normalizedSelector}. Candidates: ${localProjects
        .map((project) => `${project.name} (${project.id})`)
        .join(', ')}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Local project selector is ambiguous: ${normalizedSelector}. Use a project id instead.`
    );
  }

  const project = matches[0]!;
  const branch = await resolveLocalProjectBranchForCreate(project, requestedBranch, {
    requireGit: useWorktree === true,
  });

  return {
    kind: 'local',
    localProjectId: project.id,
    ...(branch ? { branch } : {}),
    ...(useWorktree === true ? { useWorktree: true } : {}),
  };
}

export async function resolveLocalProjectBranchForCreate(
  project: { rootPath: string },
  requestedBranch?: string,
  options: { requireGit?: boolean } = {}
): Promise<string | undefined> {
  // A direct local-project session runs in the project's current working
  // directory. Capturing its current branch here would turn a harmless
  // snapshot into a later `git switch` if the directory changes before the
  // daemon starts the session. Branch selection is meaningful only when the
  // caller explicitly requested one or when a worktree needs a base ref.
  if (!requestedBranch?.trim() && options.requireGit !== true) {
    return undefined;
  }

  const gitState = await getLocalProjectGitStateAtRootPath(project.rootPath);
  if (!gitState.git) {
    if (options.requireGit === true) {
      throw new Error('Cannot use --worktree with a local project that is not a git repository.');
    }
    if (requestedBranch) {
      throw new Error('Cannot use --branch with a local project that is not a git repository.');
    }
    return undefined;
  }

  if (gitState.branches.length === 0) {
    if (requestedBranch?.trim()) {
      throw new Error(`Local project branch not found: ${requestedBranch.trim()}`);
    }
    if (options.requireGit === true) {
      throw new Error('The local project does not have a branch to use as a worktree base.');
    }
    return undefined;
  }

  const branch = resolveBaseBranchPreference({
    preferredBranch: requestedBranch,
    baseBranch: gitState.currentBranch,
    fallbackBranch: gitState.defaultBranch ?? gitState.branches[0],
  });
  // `branch` is either a selector this project reported or a name a human typed
  // as `--branch`. A typed `main` may match both refs/heads/main and
  // refs/remotes/origin/main, so validate it the way git resolves it.
  await resolveLocalProjectBranchAtRootPath(project.rootPath, branch, {
    preferLocalOnCollision: true,
  });
  return branch;
}

function isPathLikeLocalProjectSelector(selector: string): boolean {
  return (
    selector === '.' ||
    selector === '..' ||
    selector.startsWith('./') ||
    selector.startsWith('.\\') ||
    selector.startsWith('../') ||
    selector.startsWith('..\\') ||
    selector.includes('/') ||
    selector.includes('\\') ||
    /^[A-Za-z]:/.test(selector)
  );
}

export function normalizeLocalProjectPathSelector(selector: string): string | undefined {
  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector || !isPathLikeLocalProjectSelector(normalizedSelector)) {
    return undefined;
  }
  return normalizeLocalProjectRootPath(normalizedSelector);
}

export function selectLocalProjectsBySelector<T extends LocalProjectSelectorCandidate>(
  localProjects: T[],
  selector: string
): T[] {
  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector) {
    return [];
  }

  const normalizedPathSelector = normalizeLocalProjectPathSelector(normalizedSelector);
  return localProjects.filter((project) => {
    const projectRootPath = normalizeCliValue(project.rootPath);
    return (
      project.id === normalizedSelector ||
      normalizeCliValue(project.name) === normalizedSelector ||
      projectRootPath === normalizedSelector ||
      (normalizedPathSelector !== undefined &&
        projectRootPath !== undefined &&
        normalizeLocalProjectRootPath(projectRootPath) === normalizedPathSelector)
    );
  });
}

export function filterAuthorizedLocalProjectCandidates<T extends LocalProjectSelectorCandidate>(
  localProjects: readonly T[],
  authorizedLocalProjectIds: ReadonlySet<string>
): T[] {
  return localProjects.filter((project) => authorizedLocalProjectIds.has(project.id));
}

async function resolveWorkspaceOrThrow(
  auth: AuthContext,
  selector?: string
): Promise<WorkspaceSummary> {
  const workspaces = await listWorkspacesForToken(auth.token);
  const effectiveSelector =
    normalizeCliValue(selector) ?? normalizeCliValue(process.env.LODY_WORKSPACE_ID);
  return selectWorkspaceSummary(workspaces, effectiveSelector);
}

async function resolveWorkspaceForSessionOrThrow(
  auth: AuthContext,
  sessionId: SessionId,
  options?: ResolveWorkspaceForSessionOptions
): Promise<WorkspaceSummary> {
  const workspaces = await listWorkspacesForToken(auth.token);
  const selector = typeof options === 'string' ? options : options?.workspace;
  const shouldSync = typeof options === 'object' && options.offline !== true;
  const syncReason = typeof options === 'object' ? options.reason : undefined;
  const effectiveSelector =
    normalizeCliValue(selector) ?? normalizeCliValue(process.env.LODY_WORKSPACE_ID);
  const sessionExistsInWorkspace = async (workspace: WorkspaceSummary): Promise<boolean> =>
    await withWorkspaceManager(auth, workspace, async (manager) => {
      if (shouldSync) {
        await syncWorkspaceMetaForRead(
          manager,
          syncReason ?? `session.resolve:${sessionId}:${workspace.id}`
        );
      }
      const raw = await manager.repo.getDocMeta(getSessionRoomId(sessionId));
      return !!raw?.meta && !isLoroRepoDocDeleted(raw);
    });

  if (effectiveSelector) {
    const workspace = selectWorkspaceSummary(workspaces, effectiveSelector);
    const exists = await sessionExistsInWorkspace(workspace);
    if (!exists) {
      throw new Error(`Session not found in workspace ${workspace.id}: ${sessionId}`);
    }
    return workspace;
  }

  if (workspaces.length === 1) {
    const workspace = workspaces[0]!;
    const exists = await sessionExistsInWorkspace(workspace);
    if (!exists) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return workspace;
  }

  const matches: WorkspaceSummary[] = [];
  for (const workspace of workspaces) {
    const exists = await sessionExistsInWorkspace(workspace);
    if (exists) {
      matches.push(workspace);
    }
  }

  if (matches.length === 0) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Session ${sessionId} exists in multiple workspaces. Pass --workspace to disambiguate.`
    );
  }
  return matches[0]!;
}

async function syncSessionReadData(
  manager: LoroDocumentManager,
  sessionId: SessionId,
  offline: boolean | undefined,
  reason: string
): Promise<void> {
  if (offline === true) {
    return;
  }
  await syncWorkspaceMetaForRead(manager, `${reason}:meta`);
  await syncDocForRead(manager, getSessionRoomId(sessionId), `${reason}:doc`);
}

async function resolveSessionMetaOrThrow(
  manager: LoroDocumentManager,
  sessionId: SessionId
): Promise<SessionMeta> {
  const raw = await manager.repo.getDocMeta(getSessionRoomId(sessionId));
  if (!raw?.meta || isLoroRepoDocDeleted(raw)) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return raw.meta as SessionMeta;
}

async function resolveRunningAssistantTurnId(
  manager: LoroDocumentManager,
  sessionId: SessionId
): Promise<string | undefined> {
  const sessionDoc = await manager.getOrCreateSessionDoc(sessionId);
  const history = await sessionDoc.getHistory();
  return resolveActiveAssistantTurnId(history)?.trim();
}

async function appendUserPromptHistory(args: {
  sessionDoc: SessionDocument;
  prompt: string;
  userId: string;
  inputConfig?: SessionHistoryInput['inputConfig'];
  preallocatedId?: string;
  /** History the caller already read, so the idempotency check can skip a re-read. */
  knownHistory?: readonly SessionHistory[];
}): Promise<{ id: string; timestamp: string; inputConfig?: SessionTurnInputConfig }> {
  const { sessionDoc, prompt, userId, inputConfig, preallocatedId } = args;
  const historyId = preallocatedId?.trim() || uuidV4();
  if (preallocatedId) {
    const history = args.knownHistory ?? (await sessionDoc.getHistory());
    const existing = history.find((entry) => entry.id === historyId);
    if (existing) {
      const existingText = existing.items?.find((item) => item.type === 'text');
      if (
        existing.role !== 'user' ||
        existingText?.type !== 'text' ||
        existingText.text !== prompt ||
        !isDeepStrictEqual(existing.inputConfig ?? {}, inputConfig ?? {})
      ) {
        throw new Error(`Preallocated user turn id is already used: ${historyId}`);
      }
      return {
        id: historyId,
        timestamp: existing.timestamp,
        ...(existing.inputConfig ? { inputConfig: existing.inputConfig } : {}),
      };
    }
  }
  const timestamp = new Date(getServerNow()).toISOString();
  const entry: SessionHistoryInput = {
    id: historyId,
    role: 'user',
    timestamp,
    status: 'pending',
    read: false,
    userId,
    items: [{ type: 'text', text: prompt }],
    inputConfig,
    fileDiff: [],
    finished: true,
  };
  await sessionDoc.updateHistory((history) => [...history, entry]);
  return {
    id: historyId,
    timestamp,
    ...(inputConfig ? { inputConfig: inputConfig as SessionTurnInputConfig } : {}),
  };
}

function buildCliHistoryInputConfig(args: {
  prompt: string;
  cliType: SessionMeta['cliType'];
  agentType: SessionMeta['agentType'];
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, string | boolean>;
  taskToolsEnabled?: boolean;
  resume?: ACPSessionConfig['resume'];
  chainDepth?: number;
}): NonNullable<SessionHistoryInput['inputConfig']> {
  return {
    prompt: args.prompt,
    cliType: args.cliType,
    agentType: args.agentType,
    modeId: args.modeId,
    modelId: args.modelId,
    configOptionValues:
      args.configOptionValues && Object.keys(args.configOptionValues).length > 0
        ? args.configOptionValues
        : undefined,
    taskToolsEnabled: args.taskToolsEnabled === true,
    resume: args.resume,
    chainDepth: args.chainDepth,
  };
}

export type ResolvedTurnDispatchConfig = {
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, string | boolean>;
  /** Frozen capability gate for the built-in Lody Task MCP tools. */
  taskToolsEnabled?: boolean;
  /** Prevent create replay from re-reading mutable defaults from the requester history. */
  inheritSessionDefaults?: false;
  /**
   * Upgrade compatibility for Operations accepted before per-target configs
   * were stored. Filter this frozen requester input against the resolved target
   * agent kind before treating it as inherited defaults.
   */
  frozenInheritedInputConfig?: SessionTurnInputConfig;
  /**
   * Semantic run-config selection (model / reasoning effort / fast / plan) that
   * only becomes concrete ACP ids once the target agent's capabilities are
   * known. Resolved by `applyAgentRunConfigSelection` before validation.
   *
   * Session creation only: `sendSessionChatResult` does not resolve it, because
   * a follow-up turn keeps the settings the session was created with.
   */
  runConfig?: AgentRunConfigSelection;
};

/**
 * Turns a semantic run-config selection into the concrete mode/model/config
 * option values the target agent advertises. Explicit ids on the config win over
 * the semantic selection only where the selection produced nothing.
 *
 * Returns the ids the resolver validated against the TARGET model so the caller
 * can exclude them from the probed-model snapshot check, plus any selection that
 * could not be verified offline.
 */
export function applyAgentRunConfigSelection(
  config: ResolvedTurnDispatchConfig,
  capability: AcpCapabilityCacheEntry | undefined
): {
  config: ResolvedTurnDispatchConfig;
  validatedConfigIds: ReadonlySet<string>;
  unverifiedSelections: readonly string[];
} {
  const { runConfig, ...rest } = config;
  if (!hasAgentRunConfigSelection(runConfig)) {
    return { config: rest, validatedConfigIds: new Set(), unverifiedSelections: [] };
  }
  const resolved = resolveAgentRunConfigSelection(runConfig, capability);
  const configOptionValues = {
    ...(rest.configOptionValues ?? {}),
    ...(resolved.configOptionValues ?? {}),
  };
  return {
    config: {
      ...(rest.taskToolsEnabled !== undefined ? { taskToolsEnabled: rest.taskToolsEnabled } : {}),
      ...((resolved.modeId ?? rest.modeId) ? { modeId: resolved.modeId ?? rest.modeId } : {}),
      ...((resolved.modelId ?? rest.modelId) ? { modelId: resolved.modelId ?? rest.modelId } : {}),
      ...(Object.keys(configOptionValues).length > 0 ? { configOptionValues } : {}),
    },
    validatedConfigIds: new Set(resolved.validatedConfigIds ?? []),
    unverifiedSelections: resolved.unverifiedSelections ?? [],
  };
}

function resolveStructuredOutputTimeoutMs(timeoutSeconds: number | undefined): number {
  return (timeoutSeconds ?? 600) * 1_000;
}

function parseConfigOptionAssignments(
  values: string[] | undefined
): Record<string, string | boolean> | undefined {
  const result: Record<string, string | boolean> = {};
  for (const value of values ?? []) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid --config-option value: ${value}. Expected key=value.`);
    }
    const key = value.slice(0, separator).trim();
    const rawValue = value.slice(separator + 1).trim();
    if (!key) {
      throw new Error(`Invalid --config-option value: ${value}. Key is empty.`);
    }
    if (rawValue === 'true') {
      result[key] = true;
    } else if (rawValue === 'false') {
      result[key] = false;
    } else {
      result[key] = rawValue;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function resolveTurnDispatchConfig(args: {
  mode?: string;
  model?: string;
  configOption?: string[];
}): ResolvedTurnDispatchConfig {
  const modeId = normalizeCliValue(args.mode);
  const modelId = normalizeCliValue(args.model);

  return {
    modeId: modeId ?? undefined,
    modelId: modelId ?? undefined,
    configOptionValues: parseConfigOptionAssignments(args.configOption),
  };
}

export function withBuiltinDefaultTurnMode(
  config: ResolvedTurnDispatchConfig,
  target: Pick<SessionMeta, 'cliType' | 'agentType'>
): ResolvedTurnDispatchConfig {
  if (config.modeId || typeof config.configOptionValues?.mode === 'string') {
    return config;
  }
  const modeId = getBuiltinDefaultModeId(target.cliType, target.agentType);
  return modeId ? { ...config, modeId } : config;
}

function mergeTurnDispatchConfig(
  explicitConfig: ResolvedTurnDispatchConfig,
  fallbackConfig: ResolvedTurnDispatchConfig | undefined
): ResolvedTurnDispatchConfig {
  return {
    modeId: explicitConfig.modeId ?? fallbackConfig?.modeId,
    modelId: explicitConfig.modelId ?? fallbackConfig?.modelId,
    configOptionValues: explicitConfig.configOptionValues ?? fallbackConfig?.configOptionValues,
    taskToolsEnabled: explicitConfig.taskToolsEnabled ?? fallbackConfig?.taskToolsEnabled,
  };
}

function validateConfigOptionValue(
  option: AcpConfigOptionSummary,
  value: string | boolean
): string | undefined {
  if (option.type === 'boolean') {
    return typeof value === 'boolean'
      ? undefined
      : `Config option "${option.id}" expects a boolean value.`;
  }
  if (typeof value !== 'string') {
    return `Config option "${option.id}" expects a select value.`;
  }
  if (!option.options.some((candidate) => candidate.value === value)) {
    return `Invalid value for config option "${option.id}": ${value}. Allowed values: ${option.options
      .map((candidate) => candidate.value)
      .join(', ')}.`;
  }
  return undefined;
}

export function validateTurnConfigOptionValues(
  values: Record<string, string | boolean> | undefined,
  capability: AcpCapabilityCacheEntry | undefined,
  /**
   * Ids already validated against the model actually being selected. The
   * capability's `configOptions` only describe the probed model, so re-checking
   * them here would reject values that are valid for the target model.
   */
  skipIds?: ReadonlySet<string>
): void {
  const entries = Object.entries(values ?? {}).filter(([id]) => !skipIds?.has(id));
  if (entries.length === 0) {
    return;
  }
  if (!capability?.configOptions) {
    throw new Error('ACP config options are unavailable for the selected agent.');
  }
  const optionsById = new Map(capability.configOptions.map((option) => [option.id, option]));
  for (const [id, value] of entries) {
    const option = optionsById.get(id);
    if (!option) {
      throw new Error(`Unknown ACP config option for the selected agent: ${id}.`);
    }
    const error = validateConfigOptionValue(option, value);
    if (error) {
      throw new Error(error);
    }
  }
}

export function filterCompatibleTurnConfigOptionValues(
  values: Record<string, string | boolean> | undefined,
  capability: AcpCapabilityCacheEntry | undefined
): Record<string, string | boolean> | undefined {
  if (!values || !capability?.configOptions) {
    return undefined;
  }
  const optionsById = new Map(capability.configOptions.map((option) => [option.id, option]));
  const compatible = Object.fromEntries(
    Object.entries(values).filter(([id, value]) => {
      const option = optionsById.get(id);
      return option !== undefined && validateConfigOptionValue(option, value) === undefined;
    })
  );
  return Object.keys(compatible).length > 0 ? compatible : undefined;
}

const getSupportedTurnSelectorIds = (
  capability: AcpCapabilityCacheEntry | undefined,
  category: 'mode' | 'model'
): Set<string> => {
  const ids = new Set<string>(
    category === 'mode'
      ? (capability?.modes ?? []).map((mode) => mode.id)
      : (capability?.models ?? []).map((model) => model.modelId)
  );
  for (const option of capability?.configOptions ?? []) {
    if (option.category !== category || option.type !== 'select') {
      continue;
    }
    for (const candidate of option.options) {
      if (typeof candidate.value === 'string') {
        ids.add(candidate.value);
      }
    }
  }
  return ids;
};

export function validateTurnModeAndModel(
  config: Pick<ResolvedTurnDispatchConfig, 'modeId' | 'modelId'>,
  capability: AcpCapabilityCacheEntry | undefined
): void {
  if (config.modeId && !getSupportedTurnSelectorIds(capability, 'mode').has(config.modeId)) {
    throw new Error(`Unsupported ACP mode for the selected agent: ${config.modeId}.`);
  }
  if (config.modelId && !getSupportedTurnSelectorIds(capability, 'model').has(config.modelId)) {
    throw new Error(`Unsupported ACP model for the selected agent: ${config.modelId}.`);
  }
}

export function filterCompatibleInheritedTurnConfig(
  config: ResolvedTurnDispatchConfig | undefined,
  capability: AcpCapabilityCacheEntry | undefined
): ResolvedTurnDispatchConfig | undefined {
  if (!config) {
    return undefined;
  }
  const supportedModes = getSupportedTurnSelectorIds(capability, 'mode');
  const supportedModels = getSupportedTurnSelectorIds(capability, 'model');
  const configOptionValues = filterCompatibleTurnConfigOptionValues(
    config.configOptionValues,
    capability
  );
  return {
    ...(config.modeId && supportedModes.has(config.modeId) ? { modeId: config.modeId } : {}),
    ...(config.modelId && supportedModels.has(config.modelId) ? { modelId: config.modelId } : {}),
    ...(configOptionValues ? { configOptionValues } : {}),
    ...(config.taskToolsEnabled !== undefined ? { taskToolsEnabled: config.taskToolsEnabled } : {}),
  };
}

async function readAgentAcpCapability(args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  agentConfigId?: AgentConfigMeta['id'];
}): Promise<AcpCapabilityCacheEntry | undefined> {
  if (!args.agentConfigId) {
    return undefined;
  }
  await syncMachineFlockDocsForRead(
    args.manager,
    args.workspaceId,
    [args.machineId],
    'session.acp-capabilities'
  );
  const handle = await args.manager.repo.openFlockDoc(
    getMachineFlockDocId(args.workspaceId, args.machineId)
  );
  const capabilities = getMachineFlockAcpCapabilities(
    readMachineFlockRowsFromFlock(handle.flock, { families: ['acpCapability'] })
  );
  return capabilities[getAcpCapabilityCacheKey(args.agentConfigId)];
}

export function resolveTurnDispatchConfigFromInputConfig(
  inputConfig: SessionTurnInputConfig | undefined,
  agentConfig: AgentConfigMeta
): ResolvedTurnDispatchConfig | undefined {
  if (
    inputConfig?.cliType !== agentConfig.cliType ||
    inputConfig.agentType !== agentConfig.agentType
  ) {
    return undefined;
  }
  return {
    ...(inputConfig.modeId ? { modeId: inputConfig.modeId } : {}),
    ...(inputConfig.modelId ? { modelId: inputConfig.modelId } : {}),
    ...(inputConfig.configOptionValues
      ? { configOptionValues: inputConfig.configOptionValues }
      : {}),
    ...(inputConfig.taskToolsEnabled !== undefined
      ? { taskToolsEnabled: inputConfig.taskToolsEnabled }
      : {}),
  };
}

async function resolveSessionTurnDispatchDefaults(
  manager: LoroDocumentManager,
  sessionId: SessionId,
  agentConfig: AgentConfigMeta
): Promise<ResolvedTurnDispatchConfig | undefined> {
  const sessionDoc = await manager.getOrCreateSessionDoc(sessionId);
  const history = await sessionDoc.getHistory();
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.role !== 'user') {
      continue;
    }
    const defaults = resolveTurnDispatchConfigFromInputConfig(
      entry.inputConfig as SessionTurnInputConfig | undefined,
      agentConfig
    );
    if (defaults) {
      return defaults;
    }
  }
  return undefined;
}

function buildStructuredWaitError(
  outputMode: StructuredSessionOutputMode,
  sessionId: SessionId,
  userTurnId: string,
  error: unknown
): Error {
  const message = formatErrorMessage(error);
  if (outputMode === 'json') {
    return Object.assign(new Error(message), {
      structuredOutputPayload: {
        ok: false,
        sessionId,
        userTurnId,
        error: message,
      },
    });
  }

  const code = error instanceof SessionTurnWaitError ? error.code : 'failed';
  return Object.assign(new Error(message), {
    structuredOutputPayload: {
      type: 'error',
      sessionId,
      userTurnId,
      code,
      error: message,
    },
  });
}

async function removeHistoryEntryById(
  sessionDoc: SessionDocument,
  historyId: string
): Promise<void> {
  await sessionDoc.updateHistory((history) => history.filter((entry) => entry.id !== historyId));
}

export async function updateSessionActivityTimestamps(
  manager: SessionActivityTimestampManager,
  sessionId: SessionId
): Promise<void> {
  const nowMs = getServerNow();
  const roomId = getSessionRoomId(sessionId);
  const existing = await manager.repo.getDocMeta(roomId);
  if (isLoroRepoDocDeleted(existing)) return;
  const meta = existing?.meta as SessionMeta | undefined;

  await manager.repo.upsertDocMeta(roomId, {
    lastMessageAt: nowMs,
    lastReadAt: nowMs,
  } satisfies Partial<SessionMeta>);

  const parentSessionId = meta?.parentSessionId;
  if (!parentSessionId || parentSessionId === sessionId) {
    return;
  }

  const parentRoomId = getSessionRoomId(parentSessionId);
  const parentExisting = await manager.repo.getDocMeta(parentRoomId);
  if (isLoroRepoDocDeleted(parentExisting)) return;
  const parentMeta = parentExisting?.meta as SessionMeta | undefined;
  const parentPatch: Partial<SessionMeta> = {};
  const parentLastMessageAt =
    typeof parentMeta?.lastMessageAt === 'number' && Number.isFinite(parentMeta.lastMessageAt)
      ? parentMeta.lastMessageAt
      : null;
  if (parentLastMessageAt === null || nowMs > parentLastMessageAt) {
    parentPatch.lastMessageAt = nowMs;
  }
  const parentLastReadAt =
    typeof parentMeta?.lastReadAt === 'number' && Number.isFinite(parentMeta.lastReadAt)
      ? parentMeta.lastReadAt
      : null;
  if (parentLastReadAt === null || nowMs > parentLastReadAt) {
    parentPatch.lastReadAt = nowMs;
  }
  if (Object.keys(parentPatch).length > 0) {
    await manager.repo.upsertDocMeta(parentRoomId, parentPatch);
  }
}

export async function updateSessionActivityTimestampsBestEffort(
  manager: SessionActivityTimestampManager,
  sessionId: SessionId,
  logger: Pick<ReturnType<typeof getLogger>, 'warn'> = getLogger('session')
): Promise<void> {
  try {
    await updateSessionActivityTimestamps(manager, sessionId);
  } catch (error) {
    logger.warn(
      `Failed to update session activity timestamps for ${sessionId}: ${formatErrorMessage(error)}`
    );
  }
}

function extractCancelResponse(
  responses: Awaited<ReturnType<typeof dispatchLocalControl>>
): z.infer<typeof SessionCancelResponseSchema> {
  const target = responses.find((response) => response.type === 'session/cancel_response');
  if (!target) {
    throw new Error('Missing session/cancel_response from local CLI daemon.');
  }
  return SessionCancelResponseSchema.parse(target);
}

function extractMachineStatusResponse(
  responses: Awaited<ReturnType<typeof dispatchLocalControl>>
): z.infer<typeof MachineStatusResponseSchema> {
  const target = responses.find((response) => response.type === 'machine/status_response');
  if (!target) {
    throw new Error('Missing machine/status_response from local CLI daemon.');
  }
  return MachineStatusResponseSchema.parse(target);
}

async function ensureLocalRuntimeAvailable(
  machineId: MachineId,
  workspaceId: WorkspaceId
): Promise<void> {
  try {
    extractMachineStatusResponse(
      await dispatchLocalControl({
        type: 'machine/status',
        machineId,
        workspaceId,
      })
    );
  } catch (error) {
    if (error instanceof LocalDaemonAvailabilityError) {
      throw error;
    }
    throw new Error(`Local session runtime is not available: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = normalizeCliValue(process.env[name]);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function createMachineRpcClient(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
}): Promise<LoroStreamsMachineRpcClient> {
  if (!LODY_AUTH_URL) {
    throw new Error('Cloud machine RPC requires LODY_AUTH_URL');
  }
  const logger = getLogger('session');
  const cliHttpFetch = getCliHttpFetch({ logger });
  const streamsTokenProvider = createCloudStreamsTokenPort({
    token: args.auth.token,
    authBaseUrl: LODY_AUTH_URL,
    authSiteUrl: LODY_AUTH_SITE_URL,
    logger,
  }).createTokenProvider({ workspaceId: args.workspaceId });
  const baseUrl = await prepareCliStreamsGatewayBaseUrl(streamsTokenProvider);
  const streamClient = createLoroStreamsJsonStreamClient({
    bucketId: LORO_STREAMS_BUCKET_ID,
    getToken: async () => await streamsTokenProvider.getToken(),
    // Keep the prepared URL available during an auth-triggered token refresh;
    // prefer a newly returned gateway after the refresh completes.
    getBaseUrl: () => streamsTokenProvider.getGatewayBaseUrl() ?? baseUrl,
    shardUrls: getLoroStreamsShardUrls(baseUrl, streamsTokenProvider.getShardHostSuffix()),
    fetchImpl: cliHttpFetch,
    timeout: {
      connectTimeoutMs: readPositiveIntEnv('LODY_LORO_RPC_CONNECT_TIMEOUT_MS', 30_000),
    },
  });
  const client = new LoroStreamsMachineRpcClient({
    workspaceId: args.workspaceId,
    machineId: args.machineId,
    streamClient,
    rpcVersion: LORO_STREAMS_RPC_VERSION,
    retentionSeconds: LORO_STREAMS_RPC_RETENTION_SECONDS,
    now: getServerNow,
    logger,
  });
  await client.start();
  return client;
}

async function withMachineRpcClient<T>(
  args: {
    auth: AuthContext;
    workspaceId: WorkspaceId;
    machineId: MachineId;
  },
  fn: (client: LoroStreamsMachineRpcClient) => Promise<T>
): Promise<T> {
  const client = await createMachineRpcClient(args);
  try {
    return await fn(client);
  } finally {
    client.stop();
  }
}

async function ensureTargetMachineOnline(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
}): Promise<void> {
  if (args.machineId === args.auth.machineId) {
    await ensureLocalRuntimeAvailable(args.machineId, args.workspaceId);
    return;
  }

  const status = await withMachineRpcClient(
    args,
    async (client) => await client.requestMachineStatus({ timeoutMs: 10_000 })
  ).catch((error: unknown) => {
    throw new Error(
      `Machine ${args.machineId} is offline or unreachable: ${formatErrorMessage(error)}`
    );
  });
  if (!status?.success) {
    throw new Error(
      `Machine ${args.machineId} is offline or unavailable${
        status?.error ? `: ${status.error}` : '.'
      }`
    );
  }
}

async function getMachineOnlineState(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
}): Promise<{ online: boolean; message?: string }> {
  try {
    await ensureTargetMachineOnline(args);
    return { online: true };
  } catch (error) {
    return { online: false, message: formatErrorMessage(error) };
  }
}

export async function readSessionMachineAccess(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  requesterUserId?: string;
  delegatedRequester?: DelegatedSessionRequester;
  localProjectId?: string;
}): Promise<MachineAccessCheckResult> {
  const requester = resolveSessionRequester(
    args.auth,
    args.requesterUserId,
    args.delegatedRequester
  );
  return await readResolvedSessionMachineAccess({
    auth: args.auth,
    workspaceId: args.workspaceId,
    machineId: args.machineId,
    requester,
    ...(args.localProjectId ? { localProjectId: args.localProjectId } : {}),
  });
}

async function readResolvedSessionMachineAccess(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  requester: ResolvedSessionRequester;
  localProjectId?: string;
}): Promise<MachineAccessCheckResult> {
  try {
    const readAccess = args.requester.isDelegated
      ? canUseMachineForCliToken
      : canRequestMachineForCliToken;
    return await readAccess({
      token: args.auth.token,
      workspaceId: args.workspaceId,
      machineId: args.machineId,
      requesterUserId: args.requester.userId,
      ...(args.localProjectId ? { localProjectId: args.localProjectId } : {}),
    });
  } catch (error) {
    throw new Error(`Could not verify machine access: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
}

async function assertMachineAccess(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  requester: ResolvedSessionRequester;
  localProjectId?: string;
}): Promise<void> {
  const access = await readResolvedSessionMachineAccess(args);
  if (!access.allowed) {
    throw new Error(`Machine access denied for ${args.machineId}: ${access.reason}`);
  }
}

async function dispatchTurnFastPath(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  sessionId: SessionId;
  userTurnId: string;
  userId: string;
  timestamp: string;
  inputConfig: SessionTurnInputConfig | undefined;
}): Promise<void> {
  if (!args.inputConfig) {
    return;
  }
  try {
    await withMachineRpcClient(
      args,
      async (client) =>
        await client.requestSessionDispatchTurn({
          sessionId: args.sessionId,
          userTurnId: args.userTurnId,
          userId: args.userId,
          timestamp: args.timestamp,
          inputConfig: args.inputConfig!,
          timeoutMs: 15_000,
        })
    );
  } catch {
    // The synchronized Session document is the durable delivery path.
  }
}

/**
 * Write the durable dispatch pointer that tells the daemon a turn is pending.
 * Once this resolves the pointer is committed to the local repo and the daemon
 * may already be executing the turn, so this is the point of no rollback: a
 * later failure must NOT delete the session/turn. Cloud confirmation is a
 * separate, best-effort step — see {@link confirmDispatchSyncedBestEffort}.
 */
async function writeDispatchPointer(args: {
  manager: LoroDocumentManager;
  sessionId: SessionId;
  userTurnId: string;
}): Promise<void> {
  await args.manager.repo.upsertDocMeta(getSessionRoomId(args.sessionId), {
    latestUserMsgId: args.userTurnId,
    lastMissingHistoryUserMsgId: undefined,
  } satisfies Partial<SessionMeta>);
}

/**
 * Best-effort confirmation that the durable dispatch write reached Loro Streams.
 *
 * We still AWAIT it so the push completes before {@link withWorkspaceManager}
 * tears the one-shot transport down; otherwise the write strands locally and the
 * daemon can only re-materialize the turn from the Operation store after its
 * ~60s claim expires (slower session start). But a failed/timed-out confirmation
 * is NOT fatal and NEVER throws: the durable dispatch pointer plus the SQLite
 * Operation are the delivery truth, and the repo transport reconciles on its own
 * schedule. Treating a transient sync blip as a hard error previously caused the
 * caller's catch to delete an already-dispatched session out from under the
 * running turn (and drop its generated title). Log and let the command succeed.
 */
export async function confirmDispatchSyncedBestEffort(args: {
  manager: Pick<LoroDocumentManager, 'waitUntilMetaSynced'>;
  sessionDoc: Pick<SessionDocument, 'waitUntilSynced'>;
  reason: string;
  logger?: Pick<ReturnType<typeof getLogger>, 'warn'>;
}): Promise<void> {
  const logger = args.logger ?? getLogger('session');
  try {
    const synced = await args.sessionDoc.waitUntilSynced();
    if (!synced) {
      logger.warn(
        `Session dispatch not yet confirmed by Loro Streams (${args.reason}:doc); ` +
          `the durable dispatch pointer will converge on reconnect.`
      );
      return;
    }
    await ensureWorkspaceMetaSynced(args.manager, `${args.reason}:meta`);
  } catch (error) {
    logger.warn(
      `Session dispatch confirmation did not complete (${args.reason}); ` +
        `the durable dispatch pointer will converge on reconnect: ${formatErrorMessage(error)}`
    );
  }
}

async function listMachineMetasForWorkspace(manager: LoroDocumentManager): Promise<MachineMeta[]> {
  return (await listAliveDocMetas<MachineMeta>(manager, isMachineDocRoomId)).map(
    (entry) => entry.meta
  );
}

function formatMachineCandidates(machines: MachineMeta[]): string {
  return machines
    .map((machine) => `${machine.name} (${machine.id})`)
    .sort((left, right) => left.localeCompare(right))
    .join(', ');
}

function selectUniqueMachineByIdOrName(machines: MachineMeta[], selector: string): MachineMeta {
  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector) {
    throw new Error('Missing machine selector.');
  }
  const idMatch = machines.find((machine) => machine.id === normalizedSelector);
  if (idMatch) {
    return idMatch;
  }
  const nameMatches = machines.filter(
    (machine) => normalizeCliValue(machine.name) === normalizedSelector
  );
  if (nameMatches.length === 1) {
    return nameMatches[0]!;
  }
  if (nameMatches.length > 1) {
    throw new Error(
      `Machine selector is ambiguous: ${normalizedSelector}. Use a machine id. Candidates: ${formatMachineCandidates(nameMatches)}`
    );
  }
  throw new Error(
    `Machine not found: ${normalizedSelector}. Candidates: ${formatMachineCandidates(machines)}`
  );
}

export function filterAuthorizedMachineMetas(
  machines: readonly MachineMeta[],
  authorizedMachineIds: ReadonlySet<MachineId>
): MachineMeta[] {
  return machines.filter((machine) => authorizedMachineIds.has(machine.id));
}

export function resolveSessionCommandRequesterUserId(
  auth: Pick<AuthContext, 'userId'>,
  requesterUserId?: string
): string {
  const requested = normalizeCliValue(requesterUserId);
  if (requested !== undefined && requested !== auth.userId) {
    throw new Error('Requester identity must match the authenticated CLI user.');
  }
  return auth.userId;
}

export function resolveSessionRequester(
  auth: Pick<AuthContext, 'userId'>,
  requesterUserId?: string,
  delegatedRequester?: DelegatedSessionRequester
): ResolvedSessionRequester {
  if (!delegatedRequester) {
    return {
      userId: resolveSessionCommandRequesterUserId(auth, requesterUserId),
      isDelegated: false,
    };
  }
  const delegatedUserId = normalizeCliValue(delegatedRequester.userId);
  if (!delegatedUserId) {
    throw new Error('Delegated Session requester must identify a user.');
  }
  const requested = normalizeCliValue(requesterUserId);
  if (requested !== undefined && requested !== delegatedUserId) {
    throw new Error('Requester identity must match the delegated Session requester.');
  }
  return { userId: delegatedUserId, isDelegated: true };
}

export function resolveSessionCreateOwnerUserId(
  requesterUserId: string,
  sessionOwnerUserId?: string
): string {
  return normalizeCliValue(sessionOwnerUserId) ?? requesterUserId;
}

export function selectTargetMachineForCreate(args: {
  authorizedMachines: readonly MachineMeta[];
  authMachineId: MachineId;
  machineSelector?: string;
  defaultMachineId?: MachineId;
  parentMachineId?: MachineId;
}): MachineMeta {
  const machines = [...args.authorizedMachines];
  if (args.parentMachineId) {
    if (args.machineSelector) {
      const explicit = selectUniqueMachineByIdOrName(machines, args.machineSelector);
      if (explicit.id !== args.parentMachineId) {
        throw new Error('Child session target machine must match the parent session machine.');
      }
      return explicit;
    }
    return selectUniqueMachineByIdOrName(machines, args.parentMachineId);
  }
  if (args.machineSelector) {
    return selectUniqueMachineByIdOrName(machines, args.machineSelector);
  }
  const defaultMachineId = normalizeCliValue(args.defaultMachineId) ?? args.authMachineId;
  return selectUniqueMachineByIdOrName(machines, defaultMachineId);
}

async function listAuthorizedMachineMetasForCreate(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machines: readonly MachineMeta[];
  requester: ResolvedSessionRequester;
}): Promise<MachineMeta[]> {
  const rows = await Promise.all(
    args.machines.map(async (machine) => ({
      machine,
      access: await readResolvedSessionMachineAccess({
        auth: args.auth,
        workspaceId: args.workspaceId,
        machineId: machine.id,
        requester: args.requester,
      }),
    }))
  );
  return filterAuthorizedMachineMetas(
    rows.map((row) => row.machine),
    new Set(rows.filter((row) => row.access.allowed).map((row) => row.machine.id))
  );
}

async function filterAuthorizedLocalProjectsForCreate<
  T extends LocalProjectSelectorCandidate,
>(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  localProjects: readonly T[];
  requester: ResolvedSessionRequester;
}): Promise<T[]> {
  const rows = await Promise.all(
    args.localProjects.map(async (project) => ({
      project,
      access: await readResolvedSessionMachineAccess({
        auth: args.auth,
        workspaceId: args.workspaceId,
        machineId: args.machineId,
        requester: args.requester,
        localProjectId: project.id,
      }),
    }))
  );
  return filterAuthorizedLocalProjectCandidates(
    rows.map((row) => row.project),
    new Set(rows.filter((row) => row.access.allowed).map((row) => row.project.id))
  );
}

async function resolveTargetMachineForCreate(args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  auth: AuthContext;
  machineSelector?: string;
  defaultMachineId?: MachineId;
  requester: ResolvedSessionRequester;
  parentSessionId?: SessionId;
}): Promise<MachineMeta> {
  const machines = await listMachineMetasForWorkspace(args.manager);
  if (machines.length === 0) {
    throw new Error('No machines are registered in this workspace.');
  }
  const authorizedMachines = await listAuthorizedMachineMetasForCreate({
    auth: args.auth,
    workspaceId: args.workspaceId,
    machines,
    requester: args.requester,
  });
  if (authorizedMachines.length === 0) {
    throw new Error('No authorized machines are available in this workspace.');
  }
  const parent = args.parentSessionId
    ? await resolveSessionMetaOrThrow(args.manager, args.parentSessionId)
    : undefined;
  return selectTargetMachineForCreate({
    authorizedMachines,
    authMachineId: args.auth.machineId,
    machineSelector: args.machineSelector,
    defaultMachineId: args.defaultMachineId,
    ...(parent ? { parentMachineId: parent.machineId } : {}),
  });
}

async function listAgentConfigsForMachine(
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  machineId: MachineId
): Promise<AgentConfigMeta[]> {
  await syncMachineFlockDocsForRead(manager, workspaceId, [machineId], 'session.agent-configs');
  const configs = await listMergedAgentConfigs(manager.repo, workspaceId, [machineId]);
  configs.sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }
    return left.id.localeCompare(right.id);
  });
  return configs;
}

export function selectDefaultAgentConfigForCreate(
  configs: AgentConfigMeta[],
  machineId: MachineId,
  currentSession?: SessionMeta
): AgentConfigMeta | undefined {
  if (currentSession?.machineId === machineId && currentSession.agentConfigId !== undefined) {
    const currentConfig = configs.find((config) => config.id === currentSession.agentConfigId);
    if (currentConfig) {
      return currentConfig;
    }
  }
  if (currentSession) {
    const sameKind = configs.filter(
      (config) =>
        config.cliType === currentSession.cliType && config.agentType === currentSession.agentType
    );
    if (sameKind.length === 1) {
      return sameKind[0];
    }
  }
  return configs.length === 1 ? configs[0] : undefined;
}

async function resolveAgentConfigForCreate(args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  selector?: string;
  currentSession?: SessionMeta;
}): Promise<AgentConfigMeta> {
  const configs = await listAgentConfigsForMachine(args.manager, args.workspaceId, args.machineId);
  if (configs.length === 0) {
    throw new Error(`No agent config exists on machine ${args.machineId}.`);
  }
  const selector =
    normalizeCliValue(args.selector) ?? normalizeCliValue(process.env.LODY_AGENT_CONFIG_ID);
  if (selector) {
    return selectUniqueAgentConfigByIdOrName(configs, selector);
  }
  const defaultConfig = selectDefaultAgentConfigForCreate(
    configs,
    args.machineId,
    args.currentSession
  );
  if (defaultConfig) {
    return defaultConfig;
  }
  throw new Error(
    `Multiple agent configs are available on machine ${args.machineId}; pass --agent-config. Candidates: ${formatAgentConfigCandidates(configs)}`
  );
}

async function assertGitHubRepoAccess(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  repoFullName: string;
  requesterUserId: string;
}): Promise<void> {
  const repos = await listWorkspaceGitHubRepositoriesForCliToken({
    token: args.auth.token,
    workspaceId: args.workspaceId,
    requesterUserId: args.requesterUserId,
    enabledOnly: true,
  });
  const normalized = args.repoFullName.toLowerCase();
  if (!repos.some((repo) => repo.fullName.toLowerCase() === normalized)) {
    throw new Error(`GitHub repository is not available in this workspace: ${args.repoFullName}`);
  }
}

export async function readLocalProjectGitStateOnMachine(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  localProjectId: string;
  localRootPath: string;
  requesterUserId: string;
}): Promise<
  | { success: true; state: Awaited<ReturnType<typeof getLocalProjectGitStateAtRootPath>> }
  | { success: false; error: string; message?: string }
> {
  if (args.machineId === args.auth.machineId) {
    try {
      return {
        success: true,
        state: await getLocalProjectGitStateAtRootPath(args.localRootPath),
      };
    } catch (error) {
      return { success: false, error: formatErrorMessage(error) };
    }
  }

  const response = await withMachineRpcClient(
    args,
    async (client) =>
      await client.requestLocalProjectGitState({
        localProjectId: args.localProjectId as LocalProjectId,
        requestedByUserId: args.requesterUserId,
        timeoutMs: 30_000,
      })
  );
  if (!response) {
    return {
      success: false,
      error: `Timed out while reading local project git state on ${args.machineId}.`,
    };
  }
  return response;
}

/**
 * Create-time projection of a local project's git state onto the `ProjectRef`
 * fields the daemon and every GitHub surface later read.
 */
type LocalProjectCreateGitContext = {
  branch?: string;
  githubRepoFullName?: string;
};

/**
 * A local project's `origin` only becomes a Session's repository identity when
 * the workspace actually enables that repository, which is exactly what desktop
 * creation does (`chat-landing.tsx`). Matching is case-insensitive and returns
 * the workspace's spelling so the persisted `repoFullName` is the same string
 * every repository lookup uses.
 */
function selectWorkspaceRepoFullName(
  githubRepoFullName: string | null | undefined,
  workspaceRepositories: readonly { fullName: string }[]
): string | undefined {
  const repoFullName = normalizeCliValue(githubRepoFullName);
  if (!repoFullName) {
    return undefined;
  }
  const normalized = repoFullName.toLowerCase();
  return workspaceRepositories.find((repo) => repo.fullName.toLowerCase() === normalized)?.fullName;
}

/**
 * Pure part of local create resolution: branch selection and GitHub identity
 * read off one git-state snapshot.
 *
 * Identity is resolved for direct and worktree local sessions alike, because a
 * Session's repository is a property of the project rather than of the workdir
 * mode; without it `createSessionResult` persists no `repoFullName` and the
 * client hides `Create PR` / `Commit & Push` and skips post-turn PR detection.
 * An unauthorized or absent `origin` simply leaves the Session local.
 */
export function resolveLocalProjectCreateGitContext(args: {
  gitState: LocalProjectGitState;
  workspaceRepositories: readonly { fullName: string }[];
  requestedBranch?: string;
  useWorktree?: boolean;
}): LocalProjectCreateGitContext {
  const requestedBranch = normalizeCliValue(args.requestedBranch);
  if (!args.gitState.git) {
    if (args.useWorktree === true) {
      throw new Error('Cannot use --worktree with a local project that is not a git repository.');
    }
    if (requestedBranch) {
      throw new Error('Cannot use --branch with a local project that is not a git repository.');
    }
    return {};
  }
  const githubRepoFullName = selectWorkspaceRepoFullName(
    args.gitState.githubRepoFullName,
    args.workspaceRepositories
  );
  const identity = githubRepoFullName ? { githubRepoFullName } : {};
  // Keep direct local sessions branchless. The target daemon must use the
  // directory as it exists at dispatch time rather than switching back to a
  // branch observed by this remote preflight.
  if (!requestedBranch && args.useWorktree !== true) {
    return identity;
  }
  if (args.gitState.branches.length === 0) {
    if (requestedBranch) {
      throw new Error(`Local project branch not found: ${requestedBranch}`);
    }
    throw new Error('The local project does not have a branch to use as a worktree base.');
  }
  const branch = resolveBaseBranchPreference({
    preferredBranch: requestedBranch,
    baseBranch: args.gitState.currentBranch,
    fallbackBranch: args.gitState.defaultBranch ?? args.gitState.branches[0],
  });
  // Only the remote machine can resolve refs, so map a typed `--branch main`
  // onto one of the selectors it reported instead of demanding an exact match.
  const selected = selectLocalProjectBranchSelector(args.gitState.branches, branch);
  if (!selected) {
    throw new Error(`Local project branch not found: ${branch}`);
  }
  return { branch: selected, ...identity };
}

/**
 * Repository identity is best effort: a workspace whose repository list cannot
 * be read still creates the local Session, just without GitHub actions.
 */
async function listWorkspaceGitHubRepositoriesBestEffort(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  requesterUserId: string;
}): Promise<{ fullName: string }[]> {
  try {
    return await listWorkspaceGitHubRepositoriesForCliToken({
      token: args.auth.token,
      workspaceId: args.workspaceId,
      requesterUserId: args.requesterUserId,
      enabledOnly: true,
    });
  } catch (error) {
    getLogger('session').warn(
      `Workspace GitHub repositories unavailable; creating the local session without repository identity: ${formatErrorMessage(
        error
      )}`
    );
    return [];
  }
}

async function resolveLocalProjectCreateGitContextOnMachine(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  localProjectId: string;
  localRootPath: string;
  requesterUserId: string;
  requestedBranch?: string;
  useWorktree?: boolean;
}): Promise<LocalProjectCreateGitContext> {
  const response = await readLocalProjectGitStateOnMachine(args);
  if (!response.success) {
    // Only an explicit branch or a worktree base depends on this read; a direct
    // local session must still be creatable when the state cannot be read.
    if (normalizeCliValue(args.requestedBranch) || args.useWorktree === true) {
      throw new Error(response.message ?? response.error);
    }
    return {};
  }
  // Only a project that actually reports a GitHub `origin` needs the workspace
  // repository list, so a purely local project stays off the network.
  const workspaceRepositories =
    response.state.git && normalizeCliValue(response.state.githubRepoFullName)
      ? await listWorkspaceGitHubRepositoriesBestEffort(args)
      : [];
  return resolveLocalProjectCreateGitContext({
    gitState: response.state,
    workspaceRepositories,
    ...(args.requestedBranch ? { requestedBranch: args.requestedBranch } : {}),
    ...(args.useWorktree !== undefined ? { useWorktree: args.useWorktree } : {}),
  });
}

async function resolveLocalProjectRefOnMachineOrThrow(
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  auth: AuthContext,
  machineId: MachineId,
  selector: string,
  requester: ResolvedSessionRequester,
  requestedBranch?: string,
  useWorktree?: boolean
): Promise<ProjectRef> {
  await syncMachineFlockDocsForRead(manager, workspaceId, [machineId], 'session.local-projects');
  const localProjects = Object.values(
    await readMachineLocalProjects(manager.repo, workspaceId, machineId)
  );
  if (localProjects.length === 0) {
    throw new Error('No local project is registered on the target machine for this workspace.');
  }
  const authorizedLocalProjects = await filterAuthorizedLocalProjectsForCreate({
    auth,
    workspaceId,
    machineId,
    localProjects,
    requester,
  });
  if (authorizedLocalProjects.length === 0) {
    throw new Error('No authorized local projects are available on the target machine.');
  }
  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector) {
    throw new Error('Missing local project selector.');
  }
  const matches = selectLocalProjectsBySelector(authorizedLocalProjects, normalizedSelector);
  if (matches.length === 0) {
    throw new Error(
      `Local project not found on ${machineId}: ${normalizedSelector}. Candidates: ${authorizedLocalProjects
        .map((project) => `${project.name} (${project.id})`)
        .join(', ')}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Local project selector is ambiguous on ${machineId}: ${normalizedSelector}. Use a project id instead.`
    );
  }
  const project = matches[0]!;
  const { branch, githubRepoFullName } = await resolveLocalProjectCreateGitContextOnMachine({
    auth,
    workspaceId,
    machineId,
    localProjectId: project.id,
    localRootPath: project.rootPath,
    requesterUserId: requester.userId,
    requestedBranch,
    useWorktree,
  });
  return {
    kind: 'local',
    localProjectId: project.id,
    ...(branch ? { branch } : {}),
    ...(githubRepoFullName ? { githubRepoFullName } : {}),
    ...(useWorktree === true ? { useWorktree: true } : {}),
  };
}

function resolveParentProjectRef(parentSession: SessionMeta): ProjectRef | undefined {
  const project = parentSession.project;
  if (project?.kind === 'github') {
    return {
      ...project,
      branch: normalizeCliValue(project.branch) ?? parentSession.baseBranch ?? 'main',
    };
  }
  if (project?.kind === 'local') {
    const branch = normalizeCliValue(project.branch) ?? parentSession.baseBranch;
    return branch ? { ...project, branch } : project;
  }
  const repoFullName = normalizeCliValue(parentSession.repoFullName);
  if (!repoFullName) {
    return undefined;
  }
  return {
    kind: 'github',
    repoFullName,
    branch: parentSession.baseBranch ?? 'main',
  };
}

export function resolveCreateCurrentSessionId(
  options: Pick<CreateOptions, 'currentSessionId'>,
  env: NodeJS.ProcessEnv = process.env
): SessionId | undefined {
  return (normalizeCliValue(options.currentSessionId) ?? normalizeCliValue(env.LODY_SESSION_ID)) as
    | SessionId
    | undefined;
}

export function resolveOpenedBySessionRelation(
  currentSession: Pick<SessionMeta, 'id' | 'parentSessionId'> | undefined
): { openedBySessionId?: SessionId; openedByRootSessionId?: SessionId } {
  if (!currentSession) return {};
  return {
    openedBySessionId: currentSession.id,
    ...(currentSession.parentSessionId
      ? { openedByRootSessionId: currentSession.parentSessionId }
      : {}),
  };
}

export function assertSupportedParentDepth(
  parentSession: Pick<SessionMeta, 'parentSessionId'> | undefined
): void {
  if (parentSession?.parentSessionId) {
    throw new Error(
      `Nested child sessions are not supported. Use the root parent session ${parentSession.parentSessionId}.`
    );
  }
}

async function resolveCreateContext(args: {
  auth: AuthContext;
  workspace: WorkspaceSummary;
  manager: LoroDocumentManager;
  options: CreateOptions;
  requester: ResolvedSessionRequester;
  skipMachineAvailabilityCheck?: boolean;
}): Promise<ResolvedCreateContext> {
  const workspaceId = args.workspace.id as WorkspaceId;
  const agentSelector = resolveCreateAgentSelector(args.options);
  const requesterUserId = args.requester.userId;
  const parentSelector = normalizeCliValue(args.options.parent);
  const currentSessionId = resolveCreateCurrentSessionId(args.options);
  if (parentSelector && args.options.useCurrentSessionAsParent === true) {
    throw new Error('Pass either --parent or --use-current-session-as-parent, not both.');
  }
  const parentSessionId = (parentSelector ??
    (args.options.useCurrentSessionAsParent === true ? currentSessionId : undefined)) as
    | SessionId
    | undefined;
  if (args.options.useCurrentSessionAsParent === true && !parentSessionId) {
    throw new Error('No current session is available for --use-current-session-as-parent.');
  }

  const normalizedRepo = normalizeCliValue(args.options.repo);
  const normalizedLocalProject = normalizeCliValue(args.options.localProject);
  const requestedBranch = normalizeCliValue(args.options.branch);
  if (
    parentSessionId &&
    (normalizedRepo || normalizedLocalProject || args.options.worktree || requestedBranch)
  ) {
    throw new Error(
      '--parent cannot be used with --repo, --local-project, --worktree, or --branch.'
    );
  }

  const currentSession = currentSessionId
    ? await resolveSessionMetaOrThrow(args.manager, currentSessionId)
    : undefined;
  const parentSession = parentSessionId
    ? await resolveSessionMetaOrThrow(args.manager, parentSessionId)
    : undefined;
  assertSupportedParentDepth(parentSession);

  // An explicit taskId wins; otherwise inherit from the session that asked for
  // this one, which is what keeps agent-spawned work on the same task.
  const taskId = (normalizeCliValue(args.options.taskId) ?? currentSession?.taskId) as
    | TaskId
    | undefined;
  const targetMachine = await resolveTargetMachineForCreate({
    manager: args.manager,
    workspaceId,
    auth: args.auth,
    machineSelector: args.options.machine,
    defaultMachineId: args.options.defaultMachineId,
    requester: args.requester,
    parentSessionId,
  });
  await assertMachineAccess({
    auth: args.auth,
    workspaceId,
    machineId: targetMachine.id,
    requester: args.requester,
  });
  if (args.skipMachineAvailabilityCheck !== true) {
    await ensureTargetMachineOnline({
      auth: args.auth,
      workspaceId,
      machineId: targetMachine.id,
    });
  }
  const agentConfig = await resolveAgentConfigForCreate({
    manager: args.manager,
    workspaceId,
    machineId: targetMachine.id,
    selector: agentSelector,
    currentSession,
  });

  let project: ProjectRef | undefined;
  if (normalizedRepo && normalizedLocalProject) {
    throw new Error('Pass either --repo or --local-project, not both.');
  }
  if (args.options.worktree === true && !normalizedLocalProject) {
    throw new Error('Pass --worktree together with --local-project.');
  }
  if (requestedBranch && !normalizedRepo && !normalizedLocalProject) {
    throw new Error('Pass --branch together with --repo or --local-project.');
  }
  if (parentSession) {
    project = resolveParentProjectRef(parentSession);
    const parentRepoFullName = project?.kind === 'github' ? project.repoFullName : undefined;
    if (parentRepoFullName) {
      await assertGitHubRepoAccess({
        auth: args.auth,
        workspaceId,
        repoFullName: parentRepoFullName,
        requesterUserId,
      });
    }
  } else if (normalizedRepo) {
    await assertGitHubRepoAccess({
      auth: args.auth,
      workspaceId,
      repoFullName: normalizedRepo,
      requesterUserId,
    });
    const branch = resolveBaseBranchPreference({
      preferredBranch: requestedBranch,
      fallbackBranch: 'main',
    });
    project = { kind: 'github', repoFullName: normalizedRepo, branch };
  } else if (normalizedLocalProject) {
    project = await resolveLocalProjectRefOnMachineOrThrow(
      args.manager,
      workspaceId,
      args.auth,
      targetMachine.id,
      normalizedLocalProject,
      args.requester,
      requestedBranch,
      args.options.worktree === true
    );
  }

  await assertMachineAccess({
    auth: args.auth,
    workspaceId,
    machineId: targetMachine.id,
    requester: args.requester,
    localProjectId: project?.kind === 'local' ? project.localProjectId : undefined,
  });

  return {
    targetMachine,
    agentConfig,
    ...(project ? { project } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...resolveOpenedBySessionRelation(currentSession),
    ...(taskId ? { taskId } : {}),
  };
}

/** Validate every create selector and access rule without writing a Session or Turn. */
export async function validateSessionCreateOptions(args: {
  auth: AuthContext;
  workspace: WorkspaceSummary;
  manager: LoroDocumentManager;
  options: CreateOptions;
  /**
   * Durable orchestration callers may validate selectors before accepting the
   * Operation and defer the fallible availability probe to materialization.
   */
  skipMachineAvailabilityCheck?: boolean;
  /**
   * Validated against the resolved target agent's ACP capabilities so an
   * unsupported model/effort/fast/plan selection is rejected BEFORE a durable
   * Operation is accepted, instead of failing after the target ids are fixed.
   */
  dispatchConfig?: ResolvedTurnDispatchConfig;
}): Promise<ResolvedTurnDispatchConfig> {
  const requester = resolveSessionRequester(
    args.auth,
    args.options.requesterUserId,
    args.options.delegatedRequester
  );
  const resolved = await resolveCreateContext({ ...args, requester });
  return await resolveEffectiveSessionCreateDispatchConfig({
    manager: args.manager,
    workspaceId: args.workspace.id as WorkspaceId,
    agentConfig: resolved.agentConfig,
    openedBySessionId: resolved.openedBySessionId,
    dispatchConfig: args.dispatchConfig ?? resolveTurnDispatchConfig({}),
  });
}

async function resolveEffectiveSessionCreateDispatchConfig(args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  agentConfig: AgentConfigMeta;
  openedBySessionId?: SessionId;
  dispatchConfig: ResolvedTurnDispatchConfig;
}): Promise<ResolvedTurnDispatchConfig> {
  const { frozenInheritedInputConfig, ...dispatchConfig } = args.dispatchConfig;
  const inheritedDispatchConfig =
    frozenInheritedInputConfig !== undefined
      ? resolveTurnDispatchConfigFromInputConfig(frozenInheritedInputConfig, args.agentConfig)
      : dispatchConfig.inheritSessionDefaults !== false && args.openedBySessionId
        ? await resolveSessionTurnDispatchDefaults(
            args.manager,
            args.openedBySessionId,
            args.agentConfig
          )
        : undefined;
  const needsCapability =
    dispatchConfig.modeId !== undefined ||
    dispatchConfig.modelId !== undefined ||
    dispatchConfig.configOptionValues !== undefined ||
    hasAgentRunConfigSelection(dispatchConfig.runConfig) ||
    inheritedDispatchConfig?.modeId !== undefined ||
    inheritedDispatchConfig?.modelId !== undefined ||
    inheritedDispatchConfig?.configOptionValues !== undefined;
  const capability = needsCapability
    ? await readAgentAcpCapability({
        manager: args.manager,
        workspaceId: args.workspaceId,
        machineId: args.agentConfig.machineId,
        agentConfigId: args.agentConfig.id,
      })
    : undefined;
  const requested = applyAgentRunConfigSelection(dispatchConfig, capability);
  validateTurnModeAndModel(requested.config, capability);
  validateTurnConfigOptionValues(
    requested.config.configOptionValues,
    capability,
    requested.validatedConfigIds
  );
  return {
    ...withBuiltinDefaultTurnMode(
      mergeTurnDispatchConfig(
        requested.config,
        filterCompatibleInheritedTurnConfig(inheritedDispatchConfig, capability)
      ),
      args.agentConfig
    ),
    inheritSessionDefaults: false,
  };
}

export function shouldQueueMachineDelete(
  session: Pick<SessionMeta, 'repoFullName' | 'project' | 'isWorktree' | 'parentSessionId'>
): boolean {
  return shouldQueueMachineDeleteSession(session);
}

export function buildSessionArchiveMetaPatch(): Partial<SessionMeta> {
  return {
    isArchived: true,
    status: SessionStatusFactory.idle(),
  };
}

export function buildSessionRestoreMetaPatch(): Partial<SessionMeta> {
  return {
    isArchived: false,
  };
}

export function buildLegacyMachineRestoreQueueCleanupPatch(
  sessionId: SessionId,
  machineMeta:
    | Pick<MachineLegacyMetaFields, 'needToArchiveSessions' | 'needToDeleteSessions'>
    | undefined
): Pick<MachineLegacyMetaFields, 'needToArchiveSessions' | 'needToDeleteSessions'> | null {
  const nextNeedToArchiveSessions = { ...(machineMeta?.needToArchiveSessions ?? {}) };
  const nextNeedToDeleteSessions = { ...(machineMeta?.needToDeleteSessions ?? {}) };
  let changed = false;

  if (sessionId in nextNeedToArchiveSessions) {
    delete nextNeedToArchiveSessions[sessionId];
    changed = true;
  }
  if (sessionId in nextNeedToDeleteSessions) {
    delete nextNeedToDeleteSessions[sessionId];
    changed = true;
  }

  if (!changed) {
    return null;
  }
  return {
    needToArchiveSessions: nextNeedToArchiveSessions,
    needToDeleteSessions: nextNeedToDeleteSessions,
  };
}

async function writeMachineFlockCommandRow(
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  row: MachineFlockRow,
  nowMs: number
): Promise<void> {
  const handle = await manager.repo.openFlockDoc(getMachineFlockDocId(workspaceId, machineId));
  const changed = writeMachineFlockRowToFlock(handle.flock, row, nowMs);
  if (!changed) {
    return;
  }
  await manager.repo.flush();
  await handle.syncOnce();
}

async function deleteMachineFlockCommandRows(
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  keys: MachineFlockKey[],
  nowMs: number
): Promise<void> {
  const handle = await manager.repo.openFlockDoc(getMachineFlockDocId(workspaceId, machineId));
  let changed = false;
  for (const key of keys) {
    changed = deleteMachineFlockRowFromFlock(handle.flock, key, nowMs) || changed;
  }
  if (!changed) {
    return;
  }
  await manager.repo.flush();
  await handle.syncOnce();
}

export async function createSessionResult(
  auth: AuthContext,
  workspace: WorkspaceSummary,
  manager: LoroDocumentManager,
  prompt: string,
  options: CreateOptions,
  dispatchConfig: ResolvedTurnDispatchConfig,
  structuredOutput?: {
    outputMode: StructuredSessionOutputMode;
    timeoutMs: number;
    onEvent?: (event: SessionTurnOutputEvent) => void;
  }
): Promise<{
  sessionId: SessionId;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  userTurnId: string;
  agentConfigId: string;
  project?: ProjectRef;
  parentSessionId?: SessionId;
  openedBySessionId?: SessionId;
  openedByRootSessionId?: SessionId;
  completionPromise?: Promise<Awaited<ReturnType<typeof waitForTurnCompletion>>>;
}> {
  const envOverrides = parseEnvAssignments(options.env);
  if (Object.keys(envOverrides).length > 0) {
    throw new Error(
      'Per-session --env overrides are no longer persisted. Configure environment variables on the agent config instead.'
    );
  }
  await ensureSessionCreateWorkspaceMetaFresh({
    manager,
    workspaceId: workspace.id as WorkspaceId,
    prewriteSatisfied: options.workspaceMetaPrewriteSatisfied === true,
  });
  if (!options.bypassSessionQuota) {
    await assertSessionCreateQuota({
      workspace,
      manager,
      sessionId: options.sessionId,
    });
  }
  const requester = resolveSessionRequester(
    auth,
    options.requesterUserId,
    options.delegatedRequester
  );
  const requesterUserId = requester.userId;
  const sessionOwnerUserId = resolveSessionCreateOwnerUserId(
    requesterUserId,
    options.sessionOwnerUserId
  );
  const resolved = await resolveCreateContext({ auth, workspace, manager, options, requester });
  const {
    targetMachine,
    agentConfig,
    project,
    parentSessionId,
    openedBySessionId,
    openedByRootSessionId,
    taskId,
  } = resolved;
  const effectiveDispatchConfig = await resolveEffectiveSessionCreateDispatchConfig({
    manager,
    workspaceId: workspace.id as WorkspaceId,
    agentConfig,
    ...(openedBySessionId ? { openedBySessionId } : {}),
    dispatchConfig,
  });

  const sessionId = options.sessionId ?? (uuidV4() as SessionId);
  const sessionRoomId = getSessionRoomId(sessionId);
  const sessionDoc = await manager.getOrCreateSessionDoc(sessionId);
  const repoFullName = resolveProjectGitHubRepo(project);
  const baseBranch = project?.kind === 'local' ? undefined : project?.branch?.trim();
  const title = normalizeCliValue(options.title);
  await manager.repo.upsertDocMeta(sessionRoomId, {
    id: sessionId,
    machineId: targetMachine.id,
    createdAt: new Date(getServerNow()).toISOString(),
    userId: sessionOwnerUserId,
    status: SessionStatusFactory.initializing(),
    isArchived: false,
    cliType: agentConfig.cliType,
    agentType: agentConfig.agentType,
    agentConfigId: agentConfig.id,
    ...(title ? { title } : {}),
    ...(project ? { project } : {}),
    ...(repoFullName ? { repoFullName } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(openedBySessionId ? { openedBySessionId } : {}),
    ...(openedByRootSessionId ? { openedByRootSessionId } : {}),
    ...(options.agentRoleId ? { agentRoleId: options.agentRoleId as AgentRoleId } : {}),
    ...(options.agentRoleRevision !== undefined
      ? { agentRoleRevision: options.agentRoleRevision }
      : {}),
    ...(taskId ? { taskId } : {}),
    // `agentRoleId`/`agentRoleRevision` are declared on `SessionMeta` now, so
    // the provenance fields no longer need a local intersection here.
  } satisfies SessionMeta);

  let completionAbortController: AbortController | undefined;
  let completionPromise: Promise<Awaited<ReturnType<typeof waitForTurnCompletion>>> | undefined;
  // Once the durable dispatch pointer is written the daemon may already be
  // running the turn, so a later failure must not roll the session back.
  let dispatched = false;
  try {
    const modeId = effectiveDispatchConfig.modeId;
    const modelId = effectiveDispatchConfig.modelId;
    const sessionCreatePrompt = buildAgentPrompt(prompt, agentConfig.prompt ?? '');
    const userTurn = await appendUserPromptHistory({
      sessionDoc,
      prompt,
      userId: requesterUserId,
      inputConfig: buildCliHistoryInputConfig({
        prompt: sessionCreatePrompt,
        cliType: agentConfig.cliType,
        agentType: agentConfig.agentType,
        modeId: modeId ?? undefined,
        modelId: modelId ?? undefined,
        configOptionValues: effectiveDispatchConfig.configOptionValues,
        taskToolsEnabled: taskId ? true : effectiveDispatchConfig.taskToolsEnabled,
        chainDepth: options.chainDepth,
      }),
      preallocatedId: options.userTurnId,
    });
    const userTurnId = userTurn.id;
    completionAbortController = structuredOutput ? new AbortController() : undefined;
    completionPromise = structuredOutput
      ? waitForTurnCompletion({
          sessionDoc,
          userTurnId,
          outputMode: structuredOutput.outputMode,
          timeoutMs: structuredOutput.timeoutMs,
          signal: completionAbortController?.signal,
          onEvent: structuredOutput.onEvent,
        })
      : undefined;

    await updateSessionActivityTimestampsBestEffort(manager, sessionId);
    await manager.repo.upsertDocMeta(sessionRoomId, {
      status: SessionStatusFactory.idle(),
    } satisfies Partial<SessionMeta>);
    await writeDispatchPointer({ manager, sessionId, userTurnId });
    dispatched = true;
    await confirmDispatchSyncedBestEffort({
      manager,
      sessionDoc,
      reason: `session.create:${sessionId}`,
    });
    await dispatchTurnFastPath({
      auth,
      workspaceId: workspace.id as WorkspaceId,
      machineId: targetMachine.id,
      sessionId,
      userTurnId,
      userId: requesterUserId,
      timestamp: userTurn.timestamp,
      inputConfig: userTurn.inputConfig,
    });
    if (taskId) {
      // AFTER the fast path on purpose: this opens and syncs the task document,
      // which is a network round trip, and the prompt must not wait on it
      // (context/cli-prompt-hot-path.md). Best effort too — it runs past the
      // dispatch point of no rollback, so a failure must never unwind a running
      // session, and the reverse pointer on session meta is already durable.
      // Still awaited rather than fired: this command's workspace transport is
      // torn down on return, so an un-awaited write could be dropped.
      await linkTaskSessionFromCli(
        manager,
        workspace.id as WorkspaceId,
        taskId,
        {
          sessionId,
          // A Run from the app authors its own session and links it there, so a
          // taskId arriving here is either delegated automation (an explicit
          // run) or an agent spawning helpers.
          origin: options.taskLinkOrigin ?? 'agent-spawn',
          ...(openedBySessionId ? { parentSessionId: openedBySessionId } : {}),
        },
        { agentConfigId: agentConfig.id }
      ).catch(() => undefined);
    }

    return {
      sessionId,
      machineId: targetMachine.id,
      workspaceId: workspace.id as WorkspaceId,
      userTurnId,
      agentConfigId: agentConfig.id,
      ...(project ? { project } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(openedBySessionId ? { openedBySessionId } : {}),
      ...(openedByRootSessionId ? { openedByRootSessionId } : {}),
      ...(taskId ? { taskId } : {}),
      completionPromise,
    };
  } catch (error) {
    completionAbortController?.abort();
    await completionPromise?.catch(() => undefined);
    // Only roll back a create that failed BEFORE the durable dispatch pointer
    // was committed. After dispatch, deleting the session would destroy an
    // already-running turn (and its title) — the durable pointer plus Operation
    // store own eventual delivery instead.
    if (!dispatched) {
      await rollbackPendingSessionCreate(manager, sessionId);
    }
    throw error;
  }
}

/** Validate a chat target without appending history or dispatching work. */
export async function validateSessionChatTarget(args: {
  auth: AuthContext;
  workspace: WorkspaceSummary;
  manager: LoroDocumentManager;
  sessionId: SessionId;
  requesterUserIdOverride?: string;
  delegatedRequester?: DelegatedSessionRequester;
}): Promise<SessionMeta> {
  const requester = resolveSessionRequester(
    args.auth,
    args.requesterUserIdOverride,
    args.delegatedRequester
  );
  return await validateSessionChatTargetForRequester({
    auth: args.auth,
    workspace: args.workspace,
    manager: args.manager,
    sessionId: args.sessionId,
    requester,
  });
}

async function validateSessionChatTargetForRequester(args: {
  auth: AuthContext;
  workspace: WorkspaceSummary;
  manager: LoroDocumentManager;
  sessionId: SessionId;
  requester: ResolvedSessionRequester;
}): Promise<SessionMeta> {
  await syncWorkspaceMetaForRead(args.manager, `session.chat:${args.sessionId}:prewrite:meta`);
  const session = await resolveSessionMetaOrThrow(args.manager, args.sessionId);
  if (session.isArchived) {
    throw new Error(`Session ${args.sessionId} is archived. Restore it before chatting.`);
  }
  await assertMachineAccess({
    auth: args.auth,
    workspaceId: args.workspace.id as WorkspaceId,
    machineId: session.machineId,
    requester: args.requester,
    localProjectId: session.project?.kind === 'local' ? session.project.localProjectId : undefined,
  });
  await ensureTargetMachineOnline({
    auth: args.auth,
    workspaceId: args.workspace.id as WorkspaceId,
    machineId: session.machineId,
  });
  return session;
}

export async function sendSessionChatResult(
  auth: AuthContext,
  workspace: WorkspaceSummary,
  manager: LoroDocumentManager,
  sessionId: SessionId,
  prompt: string,
  dispatchConfig: ResolvedTurnDispatchConfig,
  structuredOutput?: {
    outputMode: StructuredSessionOutputMode;
    timeoutMs: number;
    onEvent?: (event: SessionTurnOutputEvent) => void;
  },
  requesterUserIdOverride?: string,
  orchestration?: {
    userTurnId: string;
    chainDepth: number;
    bypassSessionQuota?: boolean;
  },
  delegatedRequester?: DelegatedSessionRequester
): Promise<{
  sessionId: SessionId;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  userTurnId: string;
  completionPromise?: Promise<Awaited<ReturnType<typeof waitForTurnCompletion>>>;
}> {
  const requester = resolveSessionRequester(auth, requesterUserIdOverride, delegatedRequester);
  const requesterUserId = requester.userId;
  const session = await validateSessionChatTargetForRequester({
    auth,
    workspace,
    manager,
    sessionId,
    requester,
  });
  if (dispatchConfig.modeId || dispatchConfig.modelId || dispatchConfig.configOptionValues) {
    const capability = await readAgentAcpCapability({
      manager,
      workspaceId: workspace.id as WorkspaceId,
      machineId: session.machineId,
      agentConfigId: session.agentConfigId,
    });
    validateTurnModeAndModel(dispatchConfig, capability);
    validateTurnConfigOptionValues(dispatchConfig.configOptionValues, capability);
  }
  const effectiveDispatchConfig = withBuiltinDefaultTurnMode(dispatchConfig, session);

  await syncDocForRead(
    manager,
    getSessionRoomId(sessionId),
    `session.chat:${sessionId}:prewrite:doc`
  );
  const sessionDoc = await manager.getOrCreateSessionDoc(sessionId);
  const quotaHistory = orchestration?.bypassSessionQuota
    ? undefined
    : await checkSessionTurnQuotaAndReadHistory({
        manager,
        workspace,
        sessionDoc,
        userTurnId: orchestration?.userTurnId,
      });
  const userTurn = await appendUserPromptHistory({
    sessionDoc,
    prompt,
    userId: requesterUserId,
    inputConfig: buildCliHistoryInputConfig({
      prompt,
      cliType: session.cliType,
      agentType: session.agentType,
      modeId: effectiveDispatchConfig.modeId,
      modelId: effectiveDispatchConfig.modelId,
      configOptionValues: effectiveDispatchConfig.configOptionValues,
      taskToolsEnabled: effectiveDispatchConfig.taskToolsEnabled,
      resume: session.acpSessionId ?? undefined,
      chainDepth: orchestration?.chainDepth,
    }),
    preallocatedId: orchestration?.userTurnId,
    knownHistory: quotaHistory,
  });
  const userTurnId = userTurn.id;
  const completionAbortController = structuredOutput ? new AbortController() : undefined;
  const completionPromise = structuredOutput
    ? waitForTurnCompletion({
        sessionDoc,
        userTurnId,
        outputMode: structuredOutput.outputMode,
        timeoutMs: structuredOutput.timeoutMs,
        signal: completionAbortController?.signal,
        onEvent: structuredOutput.onEvent,
      })
    : undefined;

  // Once the durable dispatch pointer is written the daemon may already be
  // running the turn, so a later failure must not un-dispatch it.
  let dispatched = false;
  try {
    await updateSessionActivityTimestampsBestEffort(manager, sessionId);
    await writeDispatchPointer({ manager, sessionId, userTurnId });
    dispatched = true;
    await confirmDispatchSyncedBestEffort({
      manager,
      sessionDoc,
      reason: `session.chat:${sessionId}:${userTurnId}`,
    });
    await dispatchTurnFastPath({
      auth,
      workspaceId: workspace.id as WorkspaceId,
      machineId: session.machineId,
      sessionId,
      userTurnId,
      userId: requesterUserId,
      timestamp: userTurn.timestamp,
      inputConfig: userTurn.inputConfig,
    });
    return {
      sessionId,
      machineId: session.machineId,
      workspaceId: workspace.id as WorkspaceId,
      userTurnId,
      completionPromise,
    };
  } catch (error) {
    completionAbortController?.abort();
    await completionPromise?.catch(() => undefined);
    // Only unwind the appended user turn if it was never durably dispatched.
    // After dispatch, removing the history entry and clearing the pointer would
    // corrupt a turn the daemon is already executing.
    if (!dispatched) {
      await removeHistoryEntryById(sessionDoc, userTurnId);
      await manager.repo
        .upsertDocMeta(getSessionRoomId(sessionId), {
          latestUserMsgId: undefined,
          lastMissingHistoryUserMsgId: undefined,
        } satisfies Partial<SessionMeta>)
        .catch(() => undefined);
    }
    throw error;
  }
}

async function buildSessionShowResult(
  workspace: WorkspaceSummary,
  manager: LoroDocumentManager,
  sessionId: SessionId
): Promise<SessionShowResult> {
  const session = await resolveSessionMetaOrThrow(manager, sessionId);
  const sessionDoc = await manager.getOrCreateSessionDoc(sessionId);
  const docState = (await sessionDoc.getDocState()) as SessionDocMeta | undefined;
  const history = docState?.history ?? [];

  return {
    workspace,
    session,
    historyCount: history.length,
    latestHistoryAt: history[history.length - 1]?.timestamp,
    messageQueueCount: docState?.mq?.length ?? 0,
  };
}

export function deriveSessionLiveStatus(machineStatus: {
  online: boolean;
  state?: 'idle' | 'initializing' | 'running' | 'waiting' | 'unknown';
  message?: string;
}): SessionStatusResult['liveStatus'] {
  if (!machineStatus.online) {
    return {
      state: 'unavailable',
      source: 'none',
      ...(machineStatus.message ? { reason: machineStatus.message } : {}),
    };
  }
  if (machineStatus.state) {
    return {
      state: machineStatus.state,
      source: 'machine',
      ...(machineStatus.message ? { reason: machineStatus.message } : {}),
    };
  }
  return {
    state: 'unavailable',
    source: 'none',
    reason: machineStatus.message ?? 'Session live status is unavailable.',
  };
}

async function readSessionLiveStatus(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  sessionId: SessionId;
}): Promise<{
  machineOnline: boolean;
  liveStatus: SessionStatusResult['liveStatus'];
}> {
  const machineOnline = await getMachineOnlineState(args);
  if (!machineOnline.online) {
    return {
      machineOnline: false,
      liveStatus: deriveSessionLiveStatus(machineOnline),
    };
  }

  try {
    const response = await withMachineRpcClient(
      args,
      async (client) =>
        await client.requestSessionLiveStatus({ sessionId: args.sessionId, timeoutMs: 10_000 })
    );
    if (!response?.success) {
      return {
        machineOnline: true,
        liveStatus: deriveSessionLiveStatus({
          online: true,
          message: response?.error ?? 'Target machine did not answer the live status request.',
        }),
      };
    }
    return {
      machineOnline: true,
      liveStatus: deriveSessionLiveStatus({
        online: true,
        state: response.state,
        message: response.reason,
      }),
    };
  } catch (error) {
    return {
      machineOnline: true,
      liveStatus: deriveSessionLiveStatus({
        online: true,
        message: formatErrorMessage(error),
      }),
    };
  }
}

export type SessionLiveStatusBatchItem = {
  sessionId: SessionId;
  machineOnline: boolean;
  state?: string;
  fresh: boolean;
  observedAt?: number;
  reason?: string;
};

/** Reuse one Machine RPC client for every Session owned by that Machine. */
export async function readSessionLiveStatusesMany(args: {
  auth: AuthContext;
  workspaceId: WorkspaceId;
  sessions: ReadonlyArray<Pick<SessionMeta, 'id' | 'machineId'>>;
}): Promise<Map<SessionId, SessionLiveStatusBatchItem>> {
  const groups = new Map<MachineId, Array<Pick<SessionMeta, 'id' | 'machineId'>>>();
  for (const session of args.sessions) {
    const group = groups.get(session.machineId) ?? [];
    group.push(session);
    groups.set(session.machineId, group);
  }
  const output = new Map<SessionId, SessionLiveStatusBatchItem>();
  await Promise.all(
    [...groups].map(async ([machineId, sessions]) => {
      const online = await getMachineOnlineState({
        auth: args.auth,
        workspaceId: args.workspaceId,
        machineId,
      });
      if (!online.online) {
        for (const session of sessions) {
          output.set(session.id, {
            sessionId: session.id,
            machineOnline: false,
            fresh: false,
            ...(online.message ? { reason: online.message } : {}),
          });
        }
        return;
      }
      try {
        const responses = await withMachineRpcClient(
          { auth: args.auth, workspaceId: args.workspaceId, machineId },
          async (client) =>
            await Promise.all(
              sessions.map(async (session) => ({
                session,
                response: await client.requestSessionLiveStatus({
                  sessionId: session.id,
                  timeoutMs: 10_000,
                }),
              }))
            )
        );
        for (const { session, response } of responses) {
          output.set(session.id, {
            sessionId: session.id,
            machineOnline: true,
            fresh: response?.success === true,
            ...(response?.state ? { state: response.state } : {}),
            ...(response?.success === true && typeof response.observedAtMs === 'number'
              ? { observedAt: response.observedAtMs }
              : {}),
            ...(!response?.success && response?.error ? { reason: response.error } : {}),
          });
        }
      } catch (error) {
        const reason = formatErrorMessage(error);
        for (const session of sessions) {
          output.set(session.id, {
            sessionId: session.id,
            machineOnline: true,
            fresh: false,
            reason,
          });
        }
      }
    })
  );
  return output;
}

async function buildSessionStatusResult(
  auth: AuthContext,
  workspace: WorkspaceSummary,
  manager: LoroDocumentManager,
  sessionId: SessionId
): Promise<SessionStatusResult> {
  const session = await resolveSessionMetaOrThrow(manager, sessionId);
  const sessionDoc = await manager.getOrCreateSessionDoc(sessionId);
  const history = await sessionDoc.getHistory();
  const assistantTurnId = resolveActiveAssistantTurnId(history);
  const live = await readSessionLiveStatus({
    auth,
    workspaceId: workspace.id as WorkspaceId,
    machineId: session.machineId,
    sessionId,
  });

  return {
    workspace,
    sessionId,
    status: session.status,
    liveStatus: live.liveStatus,
    machineId: session.machineId,
    machineOnline: live.machineOnline,
    agent: {
      cliType: session.cliType,
      agentType: session.agentType,
      ...(session.agentConfigId ? { agentConfigId: session.agentConfigId } : {}),
    },
    archived: session.isArchived === true,
    ...(assistantTurnId
      ? {
          activeTurn: {
            assistantTurnId,
            ...(session.processingUserMsgId
              ? { processingUserMsgId: session.processingUserMsgId }
              : {}),
            ...(session.latestUserMsgId ? { latestUserMsgId: session.latestUserMsgId } : {}),
          },
        }
      : {}),
    ...(session.openedBySessionId ? { openedBySessionId: session.openedBySessionId } : {}),
    ...(session.openedByRootSessionId
      ? { openedByRootSessionId: session.openedByRootSessionId }
      : {}),
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.latestUserMsgId ? { latestUserMsgId: session.latestUserMsgId } : {}),
    ...(session.processingUserMsgId ? { processingUserMsgId: session.processingUserMsgId } : {}),
    ...(session.lastHandledUserMsgId ? { lastHandledUserMsgId: session.lastHandledUserMsgId } : {}),
  };
}

function printHumanSessionList(sessions: SessionMeta[]): void {
  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  console.log(
    renderTerminalTable(
      [
        { header: 'ID' },
        { header: 'Status' },
        { header: 'State' },
        { header: 'Repo' },
        { header: 'Title' },
      ],
      sessions.map((session) => [
        session.id,
        session.status?.type ?? 'unknown',
        session.isArchived ? 'archived' : 'active',
        normalizeCliValue(session.repoFullName),
        normalizeCliValue(session.title),
      ])
    )
  );
}

function printHumanSessionShow(result: SessionShowResult): void {
  const session = result.session;
  console.log(`id: ${session.id}`);
  console.log(`workspace: ${result.workspace.slug ?? result.workspace.id}`);
  console.log(`machine: ${session.machineId}`);
  console.log(`status: ${session.status?.type ?? 'unknown'}`);
  console.log(`archived: ${session.isArchived === true ? 'yes' : 'no'}`);
  console.log(`title: ${normalizeCliValue(session.title) ?? '-'}`);
  console.log(`agent: ${session.cliType}/${session.agentType}`);
  console.log(`agentConfigId: ${session.agentConfigId ?? '-'}`);
  console.log(`parentSessionId: ${session.parentSessionId ?? '-'}`);
  console.log(`openedBySessionId: ${session.openedBySessionId ?? '-'}`);
  console.log(`openedByRootSessionId: ${session.openedByRootSessionId ?? '-'}`);
  console.log(`repo: ${normalizeCliValue(session.repoFullName) ?? '-'}`);
  console.log(`baseBranch: ${session.baseBranch ?? '-'}`);
  console.log(`branch: ${session.branchName ?? '-'}`);
  console.log(`historyCount: ${result.historyCount}`);
  console.log(`messageQueueCount: ${result.messageQueueCount}`);
  console.log(`createdAt: ${session.createdAt}`);
  console.log(`lastHistoryAt: ${result.latestHistoryAt ?? '-'}`);
}

function printHumanSessionStatus(result: SessionStatusResult): void {
  console.log(`id: ${result.sessionId}`);
  console.log(`workspace: ${result.workspace.slug ?? result.workspace.id}`);
  console.log(`machine: ${result.machineId}`);
  console.log(`status: ${result.status?.type ?? 'unknown'}`);
  console.log(`liveStatus: ${result.liveStatus.state}`);
  console.log(`machineOnline: ${result.machineOnline ? 'yes' : 'no'}`);
  console.log(`archived: ${result.archived ? 'yes' : 'no'}`);
  console.log(`agent: ${result.agent.cliType}/${result.agent.agentType}`);
  console.log(`agentConfigId: ${result.agent.agentConfigId ?? '-'}`);
  console.log(`activeTurn: ${result.activeTurn?.assistantTurnId ?? '-'}`);
  console.log(`openedBySessionId: ${result.openedBySessionId ?? '-'}`);
  console.log(`openedByRootSessionId: ${result.openedByRootSessionId ?? '-'}`);
  console.log(`parentSessionId: ${result.parentSessionId ?? '-'}`);
}

async function runSessionCommand(
  options: CommonOptions,
  action: () => Promise<void>
): Promise<void> {
  if (options.debug) {
    rootLogger.setDebug(true);
  }

  try {
    await syncCommandTime('session');
    await action();
    await exitSessionCommand(0);
  } catch (error) {
    const message = formatErrorMessage(error);
    const structuredOutputPayload =
      error && typeof error === 'object' && 'structuredOutputPayload' in error
        ? (error as { structuredOutputPayload?: unknown }).structuredOutputPayload
        : undefined;
    if (options.json || options.jsonl) {
      printJson(
        structuredOutputPayload ??
          (options.jsonl ? { type: 'error', error: message } : { ok: false, error: message })
      );
    } else {
      getLogger('session').error(message);
    }
    await exitSessionCommand(1);
  }
}

function shouldForceExitSessionProcess(env: NodeJS.ProcessEnv = process.env): boolean {
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

async function exitSessionCommand(code: number): Promise<void> {
  process.exitCode = code;
  if (!shouldForceExitSessionProcess()) {
    // In tests we do not force-exit, so still flush analytics best-effort.
    await flushTelemetry();
    return;
  }

  try {
    await flushTelemetry();
    await Promise.all([flushWritableStream(process.stdout), flushWritableStream(process.stderr)]);
  } finally {
    process.exit(code);
  }
}

const sessionCreateCommand = new Command('create')
  .description('Create a new session')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--machine <idOrName>', 'Target machine id or name')
  .option('--agent <idOrName>', 'Agent config id or name')
  .option('--agent-config <idOrName>', 'Agent config id or name')
  .option('--parent <sessionId>', 'Parent session whose work context should be reused')
  .option('--use-current-session-as-parent', 'Use LODY_SESSION_ID as the parent session')
  .option('--title <title>', 'Session title')
  .option('--repo <owner/repo>', 'GitHub repository to attach')
  .option('--local-project <id|name|path>', 'Local project id, name, or root path')
  .option('--worktree', 'Create an isolated git worktree for --local-project')
  .option('--branch <name>', 'Git branch to use for GitHub repos or local git projects')
  .option('--mode <modeId>', 'ACP mode override')
  .option('--model <modelId>', 'ACP model override')
  .option(
    '--config-option <keyValue>',
    'ACP config option override in key=value form; repeatable',
    collectListOption,
    []
  )
  .option(
    '--env <keyValue>',
    'Deprecated per-session env override; configure env on the agent config instead',
    collectListOption,
    []
  )
  .option('--prompt <text>', 'Prompt text')
  .option('--prompt-file <path>', 'Read prompt text from file, or - for stdin')
  .option('--json', 'Print JSON output')
  .option('--jsonl', 'Print JSON Lines output')
  .option('--wait', 'Wait for the assistant turn to complete before exiting')
  .option('--timeout <seconds>', 'Wait timeout in seconds for --wait', parsePositiveIntOption)
  .option('--debug', 'Enable debug output')
  .argument('[prompt]', 'Prompt text')
  .action(async (promptArg: string | undefined, options: CreateOptions) => {
    await runSessionCommand(options, async () => {
      const outputMode = resolveStructuredOutputMode(options);
      const createStartMs = Date.now();
      captureSessionCommandEvent('session_create_started', { output_mode: outputMode });
      try {
        const auth = getAuthContextOrThrow();
        const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
        const prompt = await readPromptText(options, promptArg);
        await withWorkspaceManager(auth, workspace, async (manager) => {
          const dispatchConfig = resolveTurnDispatchConfig({
            mode: options.mode,
            model: options.model,
            configOption: options.configOption,
          });
          const shouldWaitForCompletion = shouldWaitForSessionCompletion(options);
          const result = await createSessionResult(
            auth,
            workspace,
            manager,
            prompt,
            options,
            dispatchConfig,
            shouldWaitForCompletion
              ? {
                  outputMode: outputMode === 'human' ? 'json' : outputMode,
                  timeoutMs: resolveStructuredOutputTimeoutMs(options.timeout),
                  onEvent: outputMode === 'jsonl' ? (event) => printJson(event) : undefined,
                }
              : undefined
          );
          const response = {
            ok: true,
            sessionId: result.sessionId,
            workspaceId: result.workspaceId,
            machineId: result.machineId,
            agentConfigId: result.agentConfigId,
            userTurnId: result.userTurnId,
            ...(result.parentSessionId ? { parentSessionId: result.parentSessionId } : {}),
            ...(result.openedBySessionId ? { openedBySessionId: result.openedBySessionId } : {}),
            ...(result.openedByRootSessionId
              ? { openedByRootSessionId: result.openedByRootSessionId }
              : {}),
          };

          if (!shouldWaitForCompletion) {
            captureSessionCommandEvent(
              'session_create_succeeded',
              { output_mode: outputMode, turn_duration_ms: Date.now() - createStartMs },
              { distinctId: auth.machineId }
            );
            if (outputMode === 'human') {
              console.log(result.sessionId);
            } else {
              printJson(response);
            }
            return;
          }

          if (outputMode === 'json') {
            try {
              const completionPromise = result.completionPromise;
              if (!completionPromise) {
                throw new Error('Missing completion promise for structured session create output.');
              }
              const completedTurn = await completionPromise;
              captureSessionCommandEvent(
                'session_create_succeeded',
                {
                  output_mode: outputMode,
                  turn_duration_ms: completedTurn.durationMs,
                },
                { distinctId: auth.machineId }
              );
              printJson({
                ...response,
                turnId: completedTurn.turnId,
                content: completedTurn.content,
                durationMs: completedTurn.durationMs,
              });
            } catch (error) {
              throw buildStructuredWaitError(
                outputMode,
                result.sessionId,
                result.userTurnId,
                error
              );
            }
            return;
          }

          if (outputMode === 'jsonl') {
            try {
              const completionPromise = result.completionPromise;
              if (!completionPromise) {
                throw new Error('Missing completion promise for structured session create output.');
              }
              const completedTurn = await completionPromise;
              captureSessionCommandEvent(
                'session_create_succeeded',
                {
                  output_mode: outputMode,
                  turn_duration_ms: completedTurn.durationMs,
                },
                { distinctId: auth.machineId }
              );
            } catch (error) {
              throw buildStructuredWaitError(
                outputMode,
                result.sessionId,
                result.userTurnId,
                error
              );
            }
            return;
          }

          console.log(result.sessionId);
          const completionPromise = result.completionPromise;
          if (!completionPromise) {
            throw new Error('Missing completion promise for session create --wait output.');
          }
          const completedTurn = await completionPromise;
          captureSessionCommandEvent(
            'session_create_succeeded',
            {
              output_mode: outputMode,
              turn_duration_ms: completedTurn.durationMs,
            },
            { distinctId: auth.machineId }
          );
          console.log('');
          console.log(renderAssistantTurnCompletion(completedTurn.content));
        });
      } catch (error) {
        captureSessionCommandEvent('session_create_failed', {
          output_mode: outputMode,
          turn_duration_ms: Date.now() - createStartMs,
        });
        throw error;
      }
    });
  });

const sessionChatCommand = new Command('chat')
  .description('Send a new user prompt to an existing session')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--mode <modeId>', 'ACP mode override')
  .option('--model <modelId>', 'ACP model override')
  .option(
    '--config-option <keyValue>',
    'ACP config option override in key=value form; repeatable',
    collectListOption,
    []
  )
  .option('--prompt <text>', 'Prompt text')
  .option('--prompt-file <path>', 'Read prompt text from file, or - for stdin')
  .option('--json', 'Print JSON output')
  .option('--jsonl', 'Print JSON Lines output')
  .option('--wait', 'Wait for the assistant turn to complete before exiting')
  .option('--timeout <seconds>', 'Wait timeout in seconds for --wait', parsePositiveIntOption)
  .option('--debug', 'Enable debug output')
  .argument('[sessionId]', 'Session ID; falls back to LODY_SESSION_ID')
  .argument('[prompt]', 'Prompt text')
  .action(
    async (
      sessionIdArg: string | undefined,
      promptArg: string | undefined,
      options: ChatOptions
    ) => {
      await runSessionCommand(options, async () => {
        const outputMode = resolveStructuredOutputMode(options);
        const auth = getAuthContextOrThrow();
        const stdinState = shouldReadStdinForChatArgResolution({
          sessionIdArg,
          promptArg,
          envSessionId: process.env.LODY_SESSION_ID,
          prompt: options.prompt,
          promptFile: options.promptFile,
          stdinIsTty: process.stdin.isTTY,
        })
          ? await readPromptStdinState()
          : { wasRead: false };
        const { sessionId, positionalPrompt } = resolveChatArgs({
          sessionIdArg,
          promptArg,
          envSessionId: process.env.LODY_SESSION_ID,
          hasNonPositionalPromptSource: hasNonPositionalPromptSource({
            prompt: options.prompt,
            promptFile: options.promptFile,
            stdinText: stdinState.text,
          }),
        });

        const workspace = await resolveWorkspaceForSessionOrThrow(
          auth,
          sessionId,
          options.workspace
        );
        const prompt = await readPromptText(options, positionalPrompt, stdinState);

        await withWorkspaceManager(auth, workspace, async (manager) => {
          const dispatchConfig = resolveTurnDispatchConfig({
            mode: options.mode,
            model: options.model,
            configOption: options.configOption,
          });
          const shouldWaitForCompletion = shouldWaitForSessionCompletion(options);
          const result = await sendSessionChatResult(
            auth,
            workspace,
            manager,
            sessionId,
            prompt,
            dispatchConfig,
            shouldWaitForCompletion
              ? {
                  outputMode: outputMode === 'human' ? 'json' : outputMode,
                  timeoutMs: resolveStructuredOutputTimeoutMs(options.timeout),
                  onEvent: outputMode === 'jsonl' ? (event) => printJson(event) : undefined,
                }
              : undefined
          );
          const completionPromise = result.completionPromise;
          const response = {
            ok: true,
            sessionId: result.sessionId,
            workspaceId: result.workspaceId,
            machineId: result.machineId,
            userTurnId: result.userTurnId,
          };

          if (!shouldWaitForCompletion) {
            if (outputMode === 'human') {
              console.log(result.userTurnId);
            } else {
              printJson(response);
            }
            return;
          }

          if (outputMode === 'json') {
            try {
              if (!completionPromise) {
                throw new Error('Missing completion promise for structured session chat output.');
              }
              const completedTurn = await completionPromise;
              printJson({
                ...response,
                turnId: completedTurn.turnId,
                content: completedTurn.content,
                durationMs: completedTurn.durationMs,
              });
            } catch (error) {
              throw buildStructuredWaitError(
                outputMode,
                result.sessionId,
                result.userTurnId,
                error
              );
            }
            return;
          }

          if (outputMode === 'jsonl') {
            try {
              if (!completionPromise) {
                throw new Error('Missing completion promise for structured session chat output.');
              }
              await completionPromise;
            } catch (error) {
              throw buildStructuredWaitError(
                outputMode,
                result.sessionId,
                result.userTurnId,
                error
              );
            }
            return;
          }

          try {
            if (!completionPromise) {
              throw new Error('Missing completion promise for session chat --wait output.');
            }
            const completedTurn = await completionPromise;
            console.log(renderAssistantTurnCompletion(completedTurn.content));
          } catch (error) {
            throw buildStructuredWaitError('json', result.sessionId, result.userTurnId, error);
          }
        });
      });
    }
  );

const sessionCancelCommand = new Command('cancel')
  .description('Cancel the current running turn for a session')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--turn-id <turnId>', 'Cancel only when this exact assistant turn is active')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[sessionId]', 'Session ID; falls back to LODY_SESSION_ID')
  .action(
    async (sessionIdArg: string | undefined, options: CommonOptions & { turnId?: string }) => {
      await runSessionCommand(options, async () => {
        const auth = getAuthContextOrThrow();
        const sessionId = (normalizeCliValue(sessionIdArg) ??
          normalizeCliValue(process.env.LODY_SESSION_ID)) as SessionId | undefined;
        if (!sessionId) {
          throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
        }

        const workspace = await resolveWorkspaceForSessionOrThrow(
          auth,
          sessionId,
          options.workspace
        );
        await withWorkspaceManager(auth, workspace, async (manager) => {
          await syncSessionReadData(manager, sessionId, undefined, `session.cancel:${sessionId}`);
          const session = await resolveSessionMetaOrThrow(manager, sessionId);
          const workspaceId = workspace.id as WorkspaceId;
          await assertMachineAccess({
            auth,
            workspaceId,
            machineId: session.machineId,
            requester: resolveSessionRequester(auth),
            localProjectId:
              session.project?.kind === 'local' ? session.project.localProjectId : undefined,
          });
          // Already-stopped cancellation stays idempotent even when the daemon is offline.
          const turnId = await resolveRunningAssistantTurnId(manager, sessionId);
          if (!turnId) {
            if (options.json) {
              printJson({ ok: true, sessionId, alreadyStopped: true });
            } else {
              console.log(`Session ${sessionId} has no active turn.`);
            }
            return;
          }
          const expectedTurnId = normalizeCliValue(options.turnId);
          if (expectedTurnId && turnId !== expectedTurnId) {
            if (options.json) {
              printJson({
                ok: true,
                sessionId,
                alreadyStopped: true,
                expectedTurnId,
                activeTurnId: turnId,
              });
            } else {
              console.log(`Target turn ${expectedTurnId} is no longer active in ${sessionId}.`);
            }
            return;
          }

          await ensureTargetMachineOnline({ auth, workspaceId, machineId: session.machineId });

          const response =
            session.machineId === auth.machineId
              ? extractCancelResponse(
                  await dispatchLocalControl({
                    type: 'session/cancel',
                    sessionId,
                    machineId: auth.machineId,
                    workspaceId,
                    turnId,
                  })
                )
              : await withMachineRpcClient(
                  { auth, workspaceId, machineId: session.machineId },
                  async (client) =>
                    await client.requestSessionCancel({ sessionId, turnId, timeoutMs: 10_000 })
                );

          if (!response) {
            throw new Error(`Machine ${session.machineId} did not answer the cancel request.`);
          }

          if (!response.success) {
            throw new Error(response.error ?? `Failed to cancel ${sessionId}.`);
          }

          if (options.json) {
            printJson({
              ok: true,
              sessionId,
              response,
            });
            return;
          }

          console.log(`Cancelled ${sessionId}`);
        });
      });
    }
  );

const sessionListCommand = new Command('list')
  .description('List sessions in a workspace')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--archived', 'Only include archived sessions')
  .option('--all', 'Include active and archived sessions')
  .option('--opened-by <sessionId>', 'Only include sessions opened by this session id')
  .option('--opened-by-current', 'Only include sessions opened by LODY_SESSION_ID')
  .option('--limit <count>', 'Maximum number of sessions to print', parsePositiveIntOption)
  .option('--offline', 'Read the local cache without syncing first')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: ListOptions) => {
    await runSessionCommand(options, async () => {
      const auth = getAuthContextOrThrow();
      const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
      if (options.openedBy && options.openedByCurrent === true) {
        throw new Error('Pass either --opened-by or --opened-by-current, not both.');
      }
      const openedBySessionId = (normalizeCliValue(options.openedBy) ??
        (options.openedByCurrent === true
          ? normalizeCliValue(process.env.LODY_SESSION_ID)
          : undefined)) as SessionId | undefined;
      if (options.openedByCurrent === true && !openedBySessionId) {
        throw new Error('No current session is available for --opened-by-current.');
      }

      await withWorkspaceManager(auth, workspace, async (manager) => {
        if (options.offline !== true) {
          await syncWorkspaceMetaForRead(manager, `session.list:${workspace.id}`);
        }
        const sessions = sortSessionMetas(
          filterSessionMetas(await listSessionMetasForWorkspace(manager), {
            archivedOnly: options.archived,
            includeAll: options.all,
            openedBySessionId,
          })
        );
        const limited =
          typeof options.limit === 'number' ? sessions.slice(0, options.limit) : sessions;

        if (options.json) {
          printJson({
            ok: true,
            workspaceId: workspace.id,
            sessions: limited,
          });
          return;
        }

        printHumanSessionList(limited);
      });
    });
  });

const sessionHistoryCommand = new Command('history')
  .description('Read visible session transcript history')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option(
    '--limit <count>',
    `Maximum number of transcript turns to print (default: ${DEFAULT_SESSION_HISTORY_LIMIT})`,
    parsePositiveIntOption
  )
  .option('--all', 'Include all transcript turns')
  .option('--reverse', 'Print newest transcript turns first')
  .option('--offline', 'Read the local cache without syncing first')
  .option('--json', 'Print JSON output')
  .option('--jsonl', 'Print JSON Lines output')
  .option('--debug', 'Enable debug output')
  .argument('[sessionId]', 'Session ID; falls back to LODY_SESSION_ID')
  .action(async (sessionIdArg: string | undefined, options: HistoryOptions) => {
    await runSessionCommand(options, async () => {
      const outputMode = resolveStructuredOutputMode(options);
      if (options.all && typeof options.limit === 'number') {
        throw new Error('Pass either --limit or --all, not both.');
      }

      const auth = getAuthContextOrThrow();
      const sessionId = (normalizeCliValue(sessionIdArg) ??
        normalizeCliValue(process.env.LODY_SESSION_ID)) as SessionId | undefined;
      if (!sessionId) {
        throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
      }

      const workspace = await resolveWorkspaceForSessionOrThrow(auth, sessionId, {
        workspace: options.workspace,
        offline: options.offline,
        reason: `session.history.resolve:${sessionId}`,
      });
      await withWorkspaceManager(auth, workspace, async (manager) => {
        await syncSessionReadData(
          manager,
          sessionId,
          options.offline,
          `session.history:${sessionId}`
        );
        await resolveSessionMetaOrThrow(manager, sessionId);
        const sessionDoc = await manager.getOrCreateSessionDoc(sessionId);
        const transcript = toSessionTranscriptEntries(await sessionDoc.getHistory());
        const entries = selectSessionTranscriptEntries(transcript, {
          all: options.all,
          limit: options.limit,
          reverse: options.reverse,
        });

        if (outputMode === 'json') {
          printJson({
            ok: true,
            workspaceId: workspace.id,
            sessionId,
            total: transcript.length,
            returned: entries.length,
            entries,
          });
          return;
        }

        if (outputMode === 'jsonl') {
          for (const entry of entries) {
            printJson({
              workspaceId: workspace.id,
              sessionId,
              ...entry,
            });
          }
          return;
        }

        console.log(renderSessionTranscript(entries));
      });
    });
  });

const sessionShowCommand = new Command('show')
  .description('Show session metadata')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--offline', 'Read the local cache without syncing first')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[sessionId]', 'Session ID; falls back to LODY_SESSION_ID')
  .action(async (sessionIdArg: string | undefined, options: CommonOptions) => {
    await runSessionCommand(options, async () => {
      const auth = getAuthContextOrThrow();
      const sessionId = (normalizeCliValue(sessionIdArg) ??
        normalizeCliValue(process.env.LODY_SESSION_ID)) as SessionId | undefined;
      if (!sessionId) {
        throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
      }

      const workspace = await resolveWorkspaceForSessionOrThrow(auth, sessionId, {
        workspace: options.workspace,
        offline: options.offline,
        reason: `session.show.resolve:${sessionId}`,
      });
      await withWorkspaceManager(auth, workspace, async (manager) => {
        await syncSessionReadData(manager, sessionId, options.offline, `session.show:${sessionId}`);
        const result = await buildSessionShowResult(workspace, manager, sessionId);
        if (options.json) {
          printJson({ ok: true, ...result });
          return;
        }

        printHumanSessionShow(result);
      });
    });
  });

const sessionStatusCommand = new Command('status')
  .description('Show current session status')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--offline', 'Read the local cache without syncing first')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[sessionId]', 'Session ID; falls back to LODY_SESSION_ID')
  .action(async (sessionIdArg: string | undefined, options: CommonOptions) => {
    await runSessionCommand(options, async () => {
      const auth = getAuthContextOrThrow();
      const sessionId = (normalizeCliValue(sessionIdArg) ??
        normalizeCliValue(process.env.LODY_SESSION_ID)) as SessionId | undefined;
      if (!sessionId) {
        throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
      }

      const workspace = await resolveWorkspaceForSessionOrThrow(auth, sessionId, {
        workspace: options.workspace,
        offline: options.offline,
        reason: `session.status.resolve:${sessionId}`,
      });
      await withWorkspaceManager(auth, workspace, async (manager) => {
        await syncSessionReadData(
          manager,
          sessionId,
          options.offline,
          `session.status:${sessionId}`
        );
        const result = await buildSessionStatusResult(auth, workspace, manager, sessionId);
        if (options.json) {
          printJson({ ok: true, ...result });
          return;
        }

        printHumanSessionStatus(result);
      });
    });
  });

const sessionRenameCommand = new Command('rename')
  .description('Rename a session')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--title <title>', 'New session title')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[sessionId]', 'Session ID; falls back to LODY_SESSION_ID')
  .argument('[title]', 'New session title')
  .action(
    async (
      sessionIdArg: string | undefined,
      titleArg: string | undefined,
      options: RenameOptions
    ) => {
      await runSessionCommand(options, async () => {
        const auth = getAuthContextOrThrow();
        const { sessionId, title } = resolveRenameArgs({
          sessionIdArg,
          titleArg,
          optionTitle: options.title,
          envSessionId: process.env.LODY_SESSION_ID,
        });

        const workspace = await resolveWorkspaceForSessionOrThrow(
          auth,
          sessionId,
          options.workspace
        );
        await withWorkspaceManager(auth, workspace, async (manager) => {
          await resolveSessionMetaOrThrow(manager, sessionId);
          await manager.repo.upsertDocMeta(getSessionRoomId(sessionId), {
            title,
          } satisfies Partial<SessionMeta>);
          await ensureWorkspaceMetaSynced(manager, `session.rename:${sessionId}`);

          if (options.json) {
            printJson({ ok: true, sessionId, title });
            return;
          }

          console.log(`Renamed ${sessionId}`);
        });
      });
    }
  );

const sessionArchiveCommand = new Command('archive')
  .description('Archive a session')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[sessionId]', 'Session ID; falls back to LODY_SESSION_ID')
  .action(async (sessionIdArg: string | undefined, options: CommonOptions) => {
    await runSessionCommand(options, async () => {
      const auth = getAuthContextOrThrow();
      const sessionId = (normalizeCliValue(sessionIdArg) ??
        normalizeCliValue(process.env.LODY_SESSION_ID)) as SessionId | undefined;
      if (!sessionId) {
        throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
      }

      const workspace = await resolveWorkspaceForSessionOrThrow(auth, sessionId, options.workspace);
      await withWorkspaceManager(auth, workspace, async (manager) => {
        const session = await resolveSessionMetaOrThrow(manager, sessionId);
        const childSessionIds = await listChildSessionIds(manager, sessionId);
        await applySessionAndChildren(sessionId, childSessionIds, (id) =>
          manager.repo.upsertDocMeta(getSessionRoomId(id), buildSessionArchiveMetaPatch())
        );

        if (
          !session.parentSessionId &&
          session.machineId !== undefined &&
          session.machineId.length > 0
        ) {
          const requestedAt = getServerNow();
          await writeMachineFlockCommandRow(
            manager,
            workspace.id as WorkspaceId,
            session.machineId,
            {
              key: machineFlockKeys.archiveSessionCommand(sessionId),
              value: buildMachineArchiveSessionCommand({ requestedAt }),
            },
            requestedAt
          );
          const machineRoomId = getMachineRoomId(session.machineId);
          const machineMeta = (await manager.repo.getDocMeta(machineRoomId))?.meta as
            | MachineLegacyMetaFields
            | undefined;
          await manager.repo.upsertDocMeta(machineRoomId, {
            needToArchiveSessions: {
              ...(machineMeta?.needToArchiveSessions ?? {}),
              [sessionId]: true,
            },
          });
        }
        await ensureWorkspaceMetaSynced(manager, `session.archive:${sessionId}`);

        if (options.json) {
          printJson({ ok: true, sessionId, archivedChildSessionIds: childSessionIds });
          return;
        }

        console.log(`Archived ${sessionId}`);
      });
    });
  });

const sessionRestoreCommand = new Command('restore')
  .description('Restore an archived session')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[sessionId]', 'Session ID; falls back to LODY_SESSION_ID')
  .action(async (sessionIdArg: string | undefined, options: CommonOptions) => {
    await runSessionCommand(options, async () => {
      const auth = getAuthContextOrThrow();
      const sessionId = (normalizeCliValue(sessionIdArg) ??
        normalizeCliValue(process.env.LODY_SESSION_ID)) as SessionId | undefined;
      if (!sessionId) {
        throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
      }

      const workspace = await resolveWorkspaceForSessionOrThrow(auth, sessionId, options.workspace);
      await withWorkspaceManager(auth, workspace, async (manager) => {
        const session = await resolveSessionMetaOrThrow(manager, sessionId);
        if (session.isArchived !== true) {
          throw new Error(`Session ${sessionId} is not archived.`);
        }
        const childSessionIds = await listChildSessionIds(manager, sessionId);
        await applySessionAndChildren(sessionId, childSessionIds, (id) =>
          manager.repo.upsertDocMeta(getSessionRoomId(id), buildSessionRestoreMetaPatch())
        );

        if (session.machineId !== undefined && session.machineId.length > 0) {
          const nowMs = getServerNow();
          const machineRoomId = getMachineRoomId(session.machineId);
          const machineMeta = (await manager.repo.getDocMeta(machineRoomId))?.meta as
            | MachineLegacyMetaFields
            | undefined;
          const machinePatch = buildLegacyMachineRestoreQueueCleanupPatch(sessionId, machineMeta);
          if (machinePatch) {
            await manager.repo.upsertDocMeta(machineRoomId, machinePatch);
          }
          await deleteMachineFlockCommandRows(
            manager,
            workspace.id as WorkspaceId,
            session.machineId,
            [
              machineFlockKeys.archiveSessionCommand(sessionId),
              machineFlockKeys.deleteSessionCommand(sessionId),
            ],
            nowMs
          );
        }
        await ensureWorkspaceMetaSynced(manager, `session.restore:${sessionId}`);

        if (options.json) {
          printJson({ ok: true, sessionId, restoredChildSessionIds: childSessionIds });
          return;
        }

        console.log(`Restored ${sessionId}`);
      });
    });
  });

const sessionDeleteCommand = new Command('delete')
  .description('Permanently delete an archived session')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[sessionId]', 'Session ID; falls back to LODY_SESSION_ID')
  .action(async (sessionIdArg: string | undefined, options: CommonOptions) => {
    await runSessionCommand(options, async () => {
      const auth = getAuthContextOrThrow();
      const sessionId = (normalizeCliValue(sessionIdArg) ??
        normalizeCliValue(process.env.LODY_SESSION_ID)) as SessionId | undefined;
      if (!sessionId) {
        throw new Error('Missing session ID. Pass one explicitly or set LODY_SESSION_ID.');
      }

      const workspace = await resolveWorkspaceForSessionOrThrow(auth, sessionId, options.workspace);
      await withWorkspaceManager(auth, workspace, async (manager) => {
        const session = await resolveSessionMetaOrThrow(manager, sessionId);
        if (session.isArchived !== true) {
          throw new Error(`Session ${sessionId} is not archived. Archive it before deleting.`);
        }
        const childSessionIds = await listChildSessionIds(manager, sessionId);
        const machineId =
          session.machineId !== undefined && session.machineId.length > 0
            ? session.machineId
            : undefined;
        const shouldQueueDelete = shouldQueueMachineDelete(session);

        if (machineId && shouldQueueDelete) {
          const requestedAt = getServerNow();
          const machineRoomId = getMachineRoomId(machineId);
          const machineMeta = (await manager.repo.getDocMeta(machineRoomId))?.meta as
            | MachineLegacyMetaFields
            | undefined;
          const machineFlockHandle = await manager.repo.openFlockDoc(
            getMachineFlockDocId(workspace.id as WorkspaceId, machineId)
          );
          const machineMetaForCleanup = {
            ...(machineMeta ?? {}),
            localProjects: {
              ...(machineMeta?.localProjects ?? {}),
              ...getMachineFlockLocalProjects(
                readMachineFlockRowsFromFlock(machineFlockHandle.flock, {
                  families: ['localProject'],
                })
              ),
            },
          } satisfies Pick<
            MachineLegacyMetaFields,
            'needToArchiveSessions' | 'needToDeleteSessions' | 'localProjects'
          >;
          let nextNeedToArchiveSessions: Record<SessionId, boolean> | undefined;
          if (machineMetaForCleanup.needToArchiveSessions?.[sessionId] !== undefined) {
            nextNeedToArchiveSessions = {
              ...(machineMetaForCleanup.needToArchiveSessions ?? {}),
            };
            delete nextNeedToArchiveSessions[sessionId];
          }
          await deleteMachineFlockCommandRows(
            manager,
            workspace.id as WorkspaceId,
            machineId,
            [machineFlockKeys.archiveSessionCommand(sessionId)],
            requestedAt
          );
          const deleteCommand = buildMachineDeleteSessionCommand({
            session,
            machineMeta: machineMetaForCleanup,
            requestedAt,
            existing: machineMeta?.needToDeleteSessions?.[sessionId],
          });
          if (nextNeedToArchiveSessions !== undefined || deleteCommand) {
            await manager.repo.upsertDocMeta(machineRoomId, {
              ...(nextNeedToArchiveSessions !== undefined
                ? { needToArchiveSessions: nextNeedToArchiveSessions }
                : {}),
              ...(deleteCommand
                ? {
                    needToDeleteSessions: {
                      ...(machineMeta?.needToDeleteSessions ?? {}),
                      [sessionId]: machineDeleteCommandToQueueItem(deleteCommand),
                    },
                  }
                : {}),
            });
          }
          if (deleteCommand) {
            await writeMachineFlockCommandRow(
              manager,
              workspace.id as WorkspaceId,
              machineId,
              {
                key: machineFlockKeys.deleteSessionCommand(sessionId),
                value: deleteCommand,
              },
              requestedAt
            );
          }
        } else if (machineId) {
          const requestedAt = getServerNow();
          const machineRoomId = getMachineRoomId(machineId);
          const machineMeta = (await manager.repo.getDocMeta(machineRoomId))?.meta as
            | MachineLegacyMetaFields
            | undefined;
          const machinePatch = buildLegacyMachineRestoreQueueCleanupPatch(sessionId, machineMeta);
          if (machinePatch) {
            await manager.repo.upsertDocMeta(machineRoomId, machinePatch);
          }
          await deleteMachineFlockCommandRows(
            manager,
            workspace.id as WorkspaceId,
            machineId,
            [
              machineFlockKeys.archiveSessionCommand(sessionId),
              machineFlockKeys.deleteSessionCommand(sessionId),
            ],
            requestedAt
          );
        }

        await applySessionAndChildren(sessionId, childSessionIds, async (id) => {
          await manager.repo.deleteDoc(getSessionRoomId(id));
          await manager.cleanSessionDoc(id);
        });
        await ensureWorkspaceMetaSynced(manager, `session.delete:${sessionId}`);

        if (options.json) {
          printJson({ ok: true, sessionId, deletedChildSessionIds: childSessionIds });
          return;
        }

        console.log(`Deleted ${sessionId}`);
      });
    });
  });

export const sessionCommand = new Command('session')
  .description('Manage sessions without the web UI')
  .addCommand(sessionCreateCommand)
  .addCommand(sessionChatCommand)
  .addCommand(sessionCancelCommand)
  .addCommand(sessionListCommand)
  .addCommand(sessionHistoryCommand)
  .addCommand(sessionShowCommand)
  .addCommand(sessionStatusCommand)
  .addCommand(sessionRenameCommand)
  .addCommand(sessionArchiveCommand)
  .addCommand(sessionRestoreCommand)
  .addCommand(sessionDeleteCommand);
