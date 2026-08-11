import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { Logger } from '@/utils/logger';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { SessionUsageUpdate, UsageData } from 'acp-extension-core';
import {
  ACPSessionId,
  MODEL_THOUGHT_LEVEL_META_KEY,
  type MachineId,
  type AcpConfigOptionValue,
  type AcpSessionNotification,
  type AgentConfigCliType,
  type MessageContent,
  type SessionGoalContent,
  type SessionTurnInputConfig,
  sanitizeGoalObjective,
  usesAcpProvidedSessionTitle,
  parseSessionNotification,
  SessionContextWindowUsage,
  SessionId,
  type WorkspaceId,
  type ModelInfo,
  parseAskUserQuestionElicitationRequest,
  buildAskUserQuestionElicitationResponse,
  getServerNow,
} from '@lody/shared';
import { getLocalControlSocketPath } from '@lody/shared/node/local-ipc';
import { TerminalManager } from '@/session/terminal-manager';
import { reportError } from 'src/utils/telemetry';
import { formatErrorMessage } from '@/utils/format-error';
import { LODY_AUTH_SITE_URL, LODY_AUTH_URL, LODY_SERVER_URL } from '@/utils/const';
import { startTraceSpan } from '@/utils/trace-span';
import { withSlowOperationWarning } from '@/utils/slow-operation-warning';
import {
  type AcpLauncher,
  type AcpSessionPath,
  captureAcpProtocolInitCompleted,
  captureAcpProtocolInitFailed,
  captureAcpSessionEstablished,
  captureAcpSessionEstablishFailed,
  captureAcpStartupCompleted,
  captureAcpStartupTimeout,
  classifyAcpProtocolReason,
} from './acp-analytics';
import { filterAcpConfigOptions } from './acp-config-option-filter';
import {
  readLegacySessionModelState,
  type LegacySessionModelState,
} from './acp-capability-normalization';
import {
  CLAUDE_TASK_LIFECYCLE_EXTENSION_METHOD,
  convertClaudeTaskLifecycleNotification,
} from './claude-task-lifecycle';
import {
  buildSteerRequestMeta,
  findActiveSteerConfigMismatch,
  parseAcknowledgedSteerCapability,
  parseSteerAppliedParams,
  type AcknowledgedSteerCapability,
} from './acknowledged-steer';

/**
 * Checks if an error is a transport-related error that may be transient.
 * These errors typically indicate the underlying process communication layer
 * is temporarily unavailable (e.g., "ProcessTransport is not ready for writing").
 */
function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message?.toLowerCase() ?? '';
  return (
    msg.includes('not ready for writing') ||
    msg.includes('transport') ||
    (msg.includes('process') && msg.includes('not ready'))
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function summarizeAcpConfigOptions(options: acp.SessionConfigOption[]): string {
  if (options.length === 0) {
    return 'none';
  }

  return options
    .slice(0, 12)
    .map((option) => `${option.id}:${option.category ?? 'uncategorized'}`)
    .join(',');
}

/**
 * Wraps an async operation with retry logic for transient transport errors.
 * If the operation fails with a transport error, it will retry up to `maxRetries` times
 * with exponential backoff. On final transport error, logs a warning but does not throw
 * (graceful degradation). Non-transport errors are always rethrown to preserve failure semantics.
 */
async function withTransportRetry<T>(
  operation: () => Promise<T>,
  logger: Logger,
  operationName: string,
  sessionId: string,
  maxRetries: number = 2
): Promise<T | undefined> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const isTransport = isTransportError(err);

      if (isTransport && attempt < maxRetries) {
        const delayMs = 100 * (attempt + 1);
        logger.debug(
          `[${sessionId}] ${operationName} failed with transport error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      // Non-transport errors should be rethrown to preserve failure semantics
      if (!isTransport) {
        throw err;
      }

      // Final transport failure - log warning but don't throw (graceful degradation)
      logger.debug(
        `[${sessionId}] ${operationName} failed after ${attempt + 1} attempt(s) with transport error: ${formatErrorMessage(err)}`
      );
      void reportError(
        `agent-client:${operationName}`,
        err instanceof Error ? err : new Error(String(err))
      );
      return undefined;
    }
  }
  return undefined;
}

/**
 * Error thrown when an ACP operation times out.
 */
export class AcpTimeoutError extends Error {
  constructor(
    public readonly operationName: string,
    public readonly timeoutMs: number,
    public readonly sessionId: string
  ) {
    super(
      `[ACP_TIMEOUT] Operation "${operationName}" timed out after ${Math.round(timeoutMs / 1000)}s`
    );
    this.name = 'AcpTimeoutError';
  }
}

/**
 * The agent refused an acknowledged steer, which by the inject-or-refuse
 * contract proves the prompt never reached the live turn (Codex answers
 * `No active Codex turn to steer` once that turn has ended). The caller may
 * therefore re-send that user turn as an ordinary follow-up.
 */
export class AgentSteerNotDeliveredError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AgentSteerNotDeliveredError';
  }
}

function isAcpAuthenticationRequired(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === -32000 && /authentication required/iu.test(message);
}

/**
 * JSON-RPC `invalid request` (-32600): the agent answered and declined the call.
 * Distinct from a plain `Error` (connection closed) or any other code, which
 * mean we never got a verdict.
 */
function isAcpInvalidRequestError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === -32600
  );
}

function isAcpMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === -32601
  );
}

export class AcpAuthenticationRequiredError extends Error {
  readonly code = -32000;
  readonly data: { readonly authMethods: readonly acp.AuthMethod[] };

  constructor(
    public readonly authMethods: readonly acp.AuthMethod[],
    options?: { cause?: unknown }
  ) {
    super('Authentication required', options);
    this.name = 'AcpAuthenticationRequiredError';
    this.data = { authMethods };
  }
}

/**
 * Wraps a promise with a hard timeout. If the operation does not complete within
 * the specified timeout, the promise is rejected with an AcpTimeoutError.
 * Also logs periodic warnings while waiting.
 *
 * Use this for critical ACP operations that should not hang indefinitely
 * (e.g., newSession, initialize).
 */
function withTimeout<T>(
  promise: Promise<T>,
  logger: Logger,
  operationName: string,
  sessionId: string,
  timeoutMs: number,
  warningIntervalMs: number = 10000
): Promise<T> {
  let completed = false;
  let elapsedMs = 0;
  let timeoutHandle: NodeJS.Timeout | undefined;

  // Log warnings periodically
  const warningInterval = setInterval(() => {
    elapsedMs += warningIntervalMs;
    if (!completed) {
      const remainingMs = timeoutMs - elapsedMs;
      logger.debug(
        `[${sessionId}] Operation "${operationName}" is still pending after ${Math.round(elapsedMs / 1000)}s ` +
          `(timeout in ${Math.round(remainingMs / 1000)}s)`
      );
    }
  }, warningIntervalMs);

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      if (!completed) {
        reject(new AcpTimeoutError(operationName, timeoutMs, sessionId));
      }
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    completed = true;
    clearInterval(warningInterval);
    clearTimeout(timeoutHandle);
  });
}

function withAbort<T>(promise: Promise<T>, abortPromise?: Promise<never>): Promise<T> {
  if (!abortPromise) {
    return promise;
  }
  return Promise.race([promise, abortPromise]);
}

type SessionModelUsage = NonNullable<SessionUsageUpdate['modelUsage']>[string];

const toModelUsageFromUsage = (usage: SessionUsageUpdate['usage']): SessionModelUsage => {
  const rawCostUSD = (usage as { costUSD?: unknown }).costUSD;
  const costUSD =
    typeof rawCostUSD === 'number' && Number.isFinite(rawCostUSD) ? rawCostUSD : undefined;

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    costUSD,
  };
};

const sanitizeModelUsage = (
  modelUsage: SessionUsageUpdate['modelUsage']
): SessionUsageUpdate['modelUsage'] => {
  if (!modelUsage) {
    return undefined;
  }
  const sanitized: NonNullable<SessionUsageUpdate['modelUsage']> = {};
  for (const [modelId, usage] of Object.entries(modelUsage)) {
    sanitized[modelId] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      webSearchRequests: usage.webSearchRequests,
      costUSD: usage.costUSD,
    };
  }
  return sanitized;
};

export type AcpStartupStageEvent =
  | { type: 'initialize_start' }
  | { type: 'initialize_end'; durationMs: number }
  | { type: 'new_session_start' }
  | { type: 'new_session_end'; durationMs: number };

export type AcpStartupTimeoutOptions = {
  initTimeoutMs?: number;
  newSessionTimeoutMs?: number;
  loadSessionTimeoutMs?: number;
  resumeSessionTimeoutMs?: number;
};

export type AcpSessionStartTarget = {
  workdir: string;
  resumeSessionId?: ACPSessionId;
};

const LegacyCodexGoalStatusSchema = z.enum([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
  'cleared',
]);
const LegacyCodexGoalSnapshotSchema = z.object({
  objective: z.string(),
  status: LegacyCodexGoalStatusSchema,
  tokenBudget: z.number().nullable().optional(),
  tokensUsed: z.number().optional(),
  timeUsedSeconds: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
const NeutralGoalSnapshotSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'limited', 'complete']),
  controlMethod: z.literal('_session/goal'),
  tokenBudget: z.number().nullable().optional(),
  tokensUsed: z.number().optional(),
  timeUsedSeconds: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

const CodexRetryErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    turnId: z.string().min(1),
    willRetry: z.literal(true),
  }),
});

const CodexSessionWarningSchema = z.object({
  warning: z.object({
    message: z.string(),
    source: z.enum(['warning', 'configWarning']).optional(),
  }),
});

export type AgentSessionWarning = z.infer<typeof CodexSessionWarningSchema>['warning'];

const CodexProposedPlanParamsSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string(),
  turnId: z.string(),
  markdown: z.string(),
  status: z.enum(['delta', 'completed', 'cleared']),
  isLatest: z.boolean(),
});

export type SteerApplicationLease = {
  release: () => void;
};

export type SteerPromptRun = {
  completion: Promise<acp.PromptResponse | undefined>;
  applied: Promise<SteerApplicationLease>;
};

type SteerApplicationWaiter = {
  sessionId: ACPSessionId;
  applied: boolean;
  resolve: (lease: SteerApplicationLease) => void;
  reject: (error: unknown) => void;
  released: Promise<void>;
  release: () => void;
};

type ActivePromptCompletion = {
  sessionId: ACPSessionId;
  promise: Promise<acp.PromptResponse | undefined>;
};

export type CodexImageGenerationBeginEvent = {
  acpSessionId: ACPSessionId;
  callId: string;
};

export type CodexImageGenerationEndEvent = {
  acpSessionId: ACPSessionId;
  callId: string;
  status: string;
  revisedPrompt?: string;
  savedPath?: string;
  image?: {
    data: string;
    mimeType: string;
    uri?: string;
  };
};

const CODEX_IMAGE_GENERATION_TOOL_TITLE = 'Image generation';
const CODEX_IMAGE_GENERATION_REVISED_PROMPT_PREFIX = 'Revised prompt: ';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringField(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function parseRawOutputRecord(rawOutput: unknown): Record<string, unknown> | undefined {
  if (isRecord(rawOutput)) {
    return rawOutput;
  }
  if (typeof rawOutput !== 'string' || rawOutput.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(rawOutput);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractCodexImageGenerationRawOutputFields(rawOutput: unknown): {
  revisedPrompt?: string;
  savedPath?: string;
  status?: string;
  imageData?: string;
} {
  const record = parseRawOutputRecord(rawOutput);
  if (!record) return {};

  return {
    revisedPrompt: getStringField(record, ['revisedPrompt', 'revised_prompt']),
    savedPath: getStringField(record, ['savedPath', 'saved_path']),
    status: getStringField(record, ['status']),
    imageData: getStringField(record, ['result']),
  };
}

/**
 * Extract Codex image-generation metadata from the `content` array of a
 * tool_call / tool_call_update: a leading "Revised prompt: …" text block and
 * an image block whose `uri` is the on-disk saved path. codex-acp 0.15 also
 * exposes the same fields via `rawOutput` — see
 * extractCodexImageGenerationRawOutputFields — which the caller merges in as
 * a fallback so we do not depend on the inline image payload shape.
 */
function extractCodexImageGenerationContentFields(content: unknown): {
  revisedPrompt?: string;
  savedPath?: string;
  image?: CodexImageGenerationEndEvent['image'];
} {
  if (!Array.isArray(content)) return {};
  let revisedPrompt: string | undefined;
  let savedPath: string | undefined;
  let image: CodexImageGenerationEndEvent['image'];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'content') continue;
    const inner = block.content;
    if (!isRecord(inner)) continue;
    if (inner.type === 'text' && typeof inner.text === 'string') {
      if (
        revisedPrompt === undefined &&
        inner.text.startsWith(CODEX_IMAGE_GENERATION_REVISED_PROMPT_PREFIX)
      ) {
        revisedPrompt = inner.text.slice(CODEX_IMAGE_GENERATION_REVISED_PROMPT_PREFIX.length);
      }
    } else if (
      inner.type === 'image' &&
      typeof inner.data === 'string' &&
      inner.data.length > 0 &&
      typeof inner.mimeType === 'string' &&
      inner.mimeType.length > 0
    ) {
      const uri = typeof inner.uri === 'string' && inner.uri.length > 0 ? inner.uri : undefined;
      savedPath = uri ?? savedPath;
      image = {
        data: inner.data,
        mimeType: inner.mimeType,
        ...(uri ? { uri } : {}),
      };
    }
  }
  return { revisedPrompt, savedPath, image };
}

interface AgentClientOptions {
  sessionId: SessionId;
  workspaceId?: WorkspaceId;
  machineId?: MachineId;
  logger: Logger;
  terminalManager: TerminalManager;
  agentConfig?: {
    cliType: AgentConfigCliType;
    agentType: string;
  };
  /** Launcher family (npx/uvx/local) for ACP startup analytics; non-PII. */
  launcher?: AcpLauncher;
  /** Set to false to disable terminal capability advertisement. Defaults to true. */
  terminalEnabled?: boolean;
  onStartupStage?: (event: AcpStartupStageEvent) => void;
  onUpdateMessage(message: AcpSessionNotification): void;
  onRequestPermission(
    requestId: string,
    request: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse>;
  onUsageUpdate?(usage: SessionUsageUpdate): void;
  onContextWindowUsageUpdate?(usage: SessionContextWindowUsage): void;
  onRateLimitUpdate?(limits: UsageData): void;
  onThreadGoalUpdated?(goal: SessionGoalContent): void;
  onThreadGoalCleared?(threadId: string): void;
  onSessionTitleUpdate?(title: string): void;
  onAgentWarning?(warning: AgentSessionWarning): void;
  onCodexProposedPlan?(plan: Extract<MessageContent, { type: 'proposed_plan' }>): void;
  onCodexImageGenerationBegin?(event: CodexImageGenerationBeginEvent): void;
  onCodexImageGenerationEnd?(event: CodexImageGenerationEndEvent): void;
  onWriteTextFile?(event: AcpWriteTextFileEvidence): void | Promise<void>;
}

export type AcpWriteTextFileEvidence = {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
};

export class AgentClient implements acp.Client {
  private connection: acp.ClientSideConnection | null = null;
  private lastSessionUpdateAtMs = Date.now();
  logger: Logger;
  private readonly terminalManager: TerminalManager;
  private readonly terminalEnabled: boolean;
  private acpSessionId: string | null = null;
  private supportsResume = false;
  private supportsLoadSession = false;
  private supportsClose = false;
  private supportsFork = false;
  private supportsForkAtTurn = false;
  private authMethods: acp.AuthMethod[] = [];
  private authenticationRequired = false;
  private acknowledgedSteerCapability: AcknowledgedSteerCapability | null = null;
  private readonly steerApplicationWaiters = new Map<string, SteerApplicationWaiter>();
  private steerApplicationBarrier: Promise<void> | null = null;
  private activePromptCompletion: ActivePromptCompletion | null = null;
  private sessionWorkdir: string | null = null;
  /** Session config options returned by the agent; the source of model/mode choices and names. */
  private configOptions: acp.SessionConfigOption[] = [];
  /** Legacy top-level `models` state proves that `session/set_model` is supported. */
  private legacySessionModelState: LegacySessionModelState | null = null;
  public currentModel?: ModelInfo;
  /**
   * Tool-call IDs that we've identified as Codex image generations (by their
   * "Image generation" title on the initial tool_call). We need this so the
   * follow-up `tool_call_update` notifications — which never repeat the title —
   * can still be recognized and routed through the upload pipeline.
   */
  private codexImageGenerationToolCallIds = new Set<string>();
  private activeCodexRetry: { sessionId: string; toolCallId: string } | null = null;

  constructor(private options: AgentClientOptions) {
    this.logger = options.logger;
    this.terminalManager = options.terminalManager;
    this.terminalEnabled = options.terminalEnabled ?? true;
  }

  private describePromptDiagnosticContext(): string {
    const agentConfig = this.options.agentConfig;
    return `cliType=${agentConfig?.cliType ?? 'unknown'} agentType=${
      agentConfig?.agentType ?? 'unknown'
    } currentModel=${this.currentModel?.modelId ?? 'none'} configOptions=${summarizeAcpConfigOptions(
      this.configOptions
    )}`;
  }

  private buildMcpServers(workdir: string) {
    if (!this.options.workspaceId || !this.options.machineId) {
      return [];
    }
    const cliEntrypoint = process.argv[1];
    if (!cliEntrypoint) {
      return [];
    }
    const env = [
      { name: 'LODY_MCP_SESSION_ID', value: this.options.sessionId },
      { name: 'LODY_MCP_WORKSPACE_ID', value: this.options.workspaceId },
      { name: 'LODY_MCP_MACHINE_ID', value: this.options.machineId },
      { name: 'LODY_MCP_SOCKET_PATH', value: getLocalControlSocketPath() },
      { name: 'LODY_MCP_WORKDIR', value: workdir },
    ];

    // ACP MCP config is an explicit environment allowlist. The MCP subprocess
    // invokes normal CLI services, so forward their public deployment endpoints
    // while keeping credentials out of the agent-visible server config.
    for (const [name, value] of [
      ['LODY_AUTH_URL', LODY_AUTH_URL],
      ['LODY_AUTH_SITE_URL', LODY_AUTH_SITE_URL],
      ['LODY_SERVER_URL', LODY_SERVER_URL],
    ] as const) {
      const normalized = value?.trim();
      if (normalized) {
        env.push({ name, value: normalized });
      }
    }

    if (process.env.ELECTRON_RUN_AS_NODE) {
      env.push({
        name: 'ELECTRON_RUN_AS_NODE',
        value: process.env.ELECTRON_RUN_AS_NODE,
      });
    }

    return [
      {
        name: 'lody',
        command: process.execPath,
        args: [cliEntrypoint, '__internal', 'lody-mcp-server'],
        env,
      },
    ];
  }

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const requestId = randomUUID();
    this.logger.debug(
      `[${this.options.sessionId}] Requesting permission for tool call ${params.toolCall.toolCallId}`
    );
    return this.options.onRequestPermission(requestId, params);
  }

  /**
   * acp-extension-claude >= 0.44.0 surfaces AskUserQuestion as an ACP form
   * elicitation rather than a permission request. Bridge it onto the existing
   * AskUserQuestion permission flow: parse the form back into question metadata,
   * synthesize the permission request the UI already renders, then fold the
   * user's answers back into the elicitation response. Url-mode and non-question
   * forms (e.g. arbitrary MCP elicitations) are declined — we only advertise
   * form elicitation to re-enable AskUserQuestion.
   */
  async unstable_createElicitation(
    params: acp.CreateElicitationRequest
  ): Promise<acp.CreateElicitationResponse> {
    const elicitation = parseAskUserQuestionElicitationRequest(params);
    if (!elicitation) {
      this.logger.debug(
        `[${this.options.sessionId}] Declining unsupported elicitation (mode=${(params as { mode?: unknown }).mode})`
      );
      return { action: 'decline' };
    }

    const sessionId = (params as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== 'string') {
      return { action: 'decline' };
    }
    this.ensureSessionMatch(sessionId as ACPSessionId);

    const toolCallId =
      typeof (params as { toolCallId?: unknown }).toolCallId === 'string'
        ? ((params as { toolCallId?: string }).toolCallId as string)
        : undefined;
    const requestId = randomUUID();
    const firstQuestion = elicitation.meta.questions[0];
    const autoResolveAt =
      typeof elicitation.autoResolutionMs === 'number' &&
      Number.isFinite(elicitation.autoResolutionMs)
        ? getServerNow() + Math.max(0, elicitation.autoResolutionMs)
        : undefined;
    const syntheticRequest: acp.RequestPermissionRequest = {
      sessionId,
      toolCall: {
        toolCallId: toolCallId ?? requestId,
        title: firstQuestion?.question ?? 'Answer question',
        // Mirrors how acp-extension-claude reports the AskUserQuestion tool call.
        kind: 'think',
        status: 'pending',
        rawInput: { questions: elicitation.meta.questions },
      },
      options: [
        { kind: 'allow_once', name: 'Submit answers', optionId: 'answer' },
        { kind: 'reject_once', name: 'Cancel', optionId: 'cancel' },
      ],
      _meta:
        elicitation.meta.source === 'codex'
          ? {
              codex: {
                requestUserInput: {
                  version: elicitation.meta.version,
                  allowCustomAnswer: elicitation.meta.allowCustomAnswer,
                  questions: elicitation.meta.questions,
                  ...(autoResolveAt !== undefined ? { autoResolveAt } : {}),
                },
              },
            }
          : {
              claudeCode: {
                requestType: 'askUserQuestion',
                askUserQuestion: {
                  version: elicitation.meta.version,
                  allowCustomAnswer: elicitation.meta.allowCustomAnswer,
                  questions: elicitation.meta.questions,
                },
              },
            },
    };

    this.logger.debug(
      `[${this.options.sessionId}] Bridging AskUserQuestion elicitation (toolCallId=${toolCallId ?? '<none>'}, questions=${elicitation.meta.questions.length})`
    );
    const response = await this.options.onRequestPermission(requestId, syntheticRequest);
    return buildAskUserQuestionElicitationResponse(elicitation, response);
  }
  async sessionUpdate(params: acp.SessionNotification) {
    const applicationBarrier = this.steerApplicationBarrier;
    if (applicationBarrier) {
      await applicationBarrier;
    }
    if (
      this.acpSessionId !== null &&
      (params.sessionId as unknown as string) !== this.acpSessionId
    ) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping update for detached ACP session: ${params.sessionId}`
      );
      return;
    }
    this.lastSessionUpdateAtMs = Date.now();
    if (this.handleUsageUpdate(params.update)) {
      // Usage telemetry is handled outside persisted chat history and remains
      // soft-validated so malformed telemetry cannot break the session stream.
      return;
    }

    const notification = parseSessionNotification(params);

    this.handleGoalSessionInfoUpdate(notification);
    this.handleCodexWarningSessionInfoUpdate(notification);
    this.handleAgentSessionTitleUpdate(notification);

    if (this.handleCodexRetrySessionInfoUpdate(notification)) {
      return;
    }
    if (this.isCodexRecoveryNotification(notification)) {
      this.completeCodexRetryStatus();
    }

    if (this.handleCodexImageGenerationNotification(notification)) {
      // handleCodexImageGenerationNotification has already routed the data
      // to onCodexImageGenerationBegin/End. Suppress the raw notification so
      // the inline base64 image never lands in the session history doc — the
      // host's upload pipeline attaches the image as an image_group instead.
      return;
    }

    this.options.onUpdateMessage(notification);
    return;
  }

  private handleGoalSessionInfoUpdate(notification: AcpSessionNotification): void {
    if (notification.update.sessionUpdate !== 'session_info_update') {
      return;
    }

    const meta = notification.update._meta;
    if (typeof meta !== 'object' || meta === null) {
      return;
    }

    let goalContainer: unknown;
    let source: 'ACP' | 'legacy Codex';
    if ('goal' in meta) {
      goalContainer = meta;
      source = 'ACP';
    } else {
      const codexMeta = meta.codex;
      if (
        !this.isCodexAgent() ||
        typeof codexMeta !== 'object' ||
        codexMeta === null ||
        !('goal' in codexMeta)
      ) {
        return;
      }
      goalContainer = codexMeta;
      source = 'legacy Codex';
    }

    const goalSchema = source === 'ACP' ? NeutralGoalSnapshotSchema : LegacyCodexGoalSnapshotSchema;
    const parsed = z.object({ goal: goalSchema.nullable() }).safeParse(goalContainer);
    if (!parsed.success) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping invalid ${source} goal session info: ${parsed.error.message}`
      );
      return;
    }

    const threadId = notification.sessionId;
    if (parsed.data.goal === null) {
      this.options.onThreadGoalCleared?.(threadId);
      return;
    }

    const goal = parsed.data.goal;
    this.options.onThreadGoalUpdated?.({
      type: 'goal',
      threadId,
      objective: sanitizeGoalObjective(goal.objective),
      // The neutral extension collapses provider-specific limit reasons into
      // `limited`. Normalize to the older generic blocked state at the durable
      // boundary: mixed-version readers can consume it without falsely claiming
      // that a usage or token budget was the specific limiting resource.
      status: goal.status === 'limited' ? 'blocked' : goal.status,
      tokenBudget: goal.tokenBudget ?? null,
      ...(goal.tokensUsed !== undefined ? { tokensUsed: goal.tokensUsed } : {}),
      ...(goal.timeUsedSeconds !== undefined ? { timeUsedSeconds: goal.timeUsedSeconds } : {}),
      ...(goal.createdAt !== undefined ? { createdAt: goal.createdAt } : {}),
      ...(goal.updatedAt !== undefined ? { updatedAt: goal.updatedAt } : {}),
    });
  }

  /**
   * The Codex adapter forwards app-server `warning`/`configWarning` notifications as
   * structured `_meta.codex.warning` metadata (kept out of agent text so history and
   * titles stay clean). Forward it so the host can record it as a warning notice.
   */
  private handleCodexWarningSessionInfoUpdate(notification: AcpSessionNotification): void {
    if (!this.isCodexAgent() || notification.update.sessionUpdate !== 'session_info_update') {
      return;
    }
    const codexMeta = notification.update._meta?.codex;
    if (typeof codexMeta !== 'object' || codexMeta === null || !('warning' in codexMeta)) {
      return;
    }
    const parsed = CodexSessionWarningSchema.safeParse(codexMeta);
    if (!parsed.success) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping invalid Codex warning session info: ${parsed.error.message}`
      );
      return;
    }
    this.options.onAgentWarning?.(parsed.data.warning);
  }

  private handleCodexRetrySessionInfoUpdate(notification: AcpSessionNotification): boolean {
    if (!this.isCodexAgent() || notification.update.sessionUpdate !== 'session_info_update') {
      return false;
    }
    const parsed = CodexRetryErrorSchema.safeParse(notification.update._meta?.codex);
    if (!parsed.success) return false;

    const toolCallId = `codex-retry:${parsed.data.error.turnId}`;
    if (this.activeCodexRetry?.toolCallId === toolCallId) {
      return true;
    }
    this.completeCodexRetryStatus();
    this.activeCodexRetry = { sessionId: notification.sessionId, toolCallId };
    this.options.onUpdateMessage(
      parseSessionNotification({
        sessionId: notification.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Codex retrying',
          kind: 'other',
          status: 'in_progress',
          _meta: { lody: { activityKind: 'codex_retry' } },
        },
      })
    );
    return true;
  }

  private isCodexRecoveryNotification(notification: AcpSessionNotification): boolean {
    if (!this.activeCodexRetry) return false;
    switch (notification.update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
      case 'tool_call':
      case 'tool_call_update':
        return true;
      default:
        return false;
    }
  }

  private completeCodexRetryStatus(): void {
    const active = this.activeCodexRetry;
    if (!active) return;
    this.activeCodexRetry = null;
    this.options.onUpdateMessage(
      parseSessionNotification({
        sessionId: active.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: active.toolCallId,
          status: 'completed',
          _meta: { lody: { activityKind: 'codex_retry' } },
        },
      })
    );
  }

  private handleCodexImageGenerationNotification(notification: AcpSessionNotification): boolean {
    if (!this.isCodexAgent()) return false;
    const update = notification.update;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
      return false;
    }
    const callId = update.toolCallId;
    if (typeof callId !== 'string' || callId.length === 0) return false;

    const isBegin = update.sessionUpdate === 'tool_call';
    const isImageGenByTitle =
      typeof update.title === 'string' && update.title === CODEX_IMAGE_GENERATION_TOOL_TITLE;
    const isTracked = this.codexImageGenerationToolCallIds.has(callId);
    if (isBegin) {
      if (!isImageGenByTitle) return false;
    } else if (!isTracked) {
      return false;
    }

    const acpSessionId = (notification.sessionId ?? this.acpSessionId) as ACPSessionId | null;
    if (!acpSessionId || !this.isCurrentAcpSession(acpSessionId)) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping Codex image generation notification for mismatched ACP session: ${acpSessionId}`
      );
      // Still suppress so the inline base64 doesn't leak into history.
      return true;
    }

    const rawOutput = (update as { rawOutput?: unknown }).rawOutput;
    const rawFields = extractCodexImageGenerationRawOutputFields(rawOutput);
    const status = typeof update.status === 'string' ? update.status : rawFields.status;
    const isTerminalStatus = status === 'completed' || status === 'failed';

    if (isBegin && !isTracked) {
      this.codexImageGenerationToolCallIds.add(callId);
      this.options.onCodexImageGenerationBegin?.({ acpSessionId, callId });
    }

    // Any notification that arrives after begin (or a fresh `tool_call` with
    // a terminal status, which upstream emits when the begin event was lost
    // on session resume) carries the end-state payload.
    const carriesEndPayload = !isBegin || isTerminalStatus || Array.isArray(update.content);
    if (carriesEndPayload && status) {
      const contentFields = extractCodexImageGenerationContentFields(update.content);
      const image =
        contentFields.image ??
        (rawFields.imageData
          ? {
              data: rawFields.imageData,
              mimeType: 'image/png',
              ...(rawFields.savedPath ? { uri: rawFields.savedPath } : {}),
            }
          : undefined);
      this.options.onCodexImageGenerationEnd?.({
        acpSessionId,
        callId,
        status,
        revisedPrompt: contentFields.revisedPrompt ?? rawFields.revisedPrompt,
        savedPath: contentFields.savedPath ?? rawFields.savedPath,
        ...(image ? { image } : {}),
      });
    }

    if (isTerminalStatus) {
      this.codexImageGenerationToolCallIds.delete(callId);
    }

    return true;
  }

  private handleUsageUpdate(update: unknown): boolean {
    if (!isUsageUpdate(update)) {
      return false;
    }

    const size = typeof update.size === 'number' ? update.size : null;
    const used = typeof update.used === 'number' ? update.used : null;
    if (
      size !== null &&
      used !== null &&
      Number.isFinite(size) &&
      Number.isFinite(used) &&
      size >= 0 &&
      used >= 0
    ) {
      this.options.onContextWindowUsageUpdate?.({ size, used });
    }
    return true;
  }

  isCreated(): boolean {
    return !!this.connection;
  }

  supportsAcknowledgedSteer(): boolean {
    return this.acknowledgedSteerCapability !== null;
  }

  getAuthMethods(): readonly acp.AuthMethod[] {
    return this.authMethods;
  }

  isAuthenticationRequired(): boolean {
    return this.authenticationRequired;
  }

  getAcknowledgedSteerCapability(): AcknowledgedSteerCapability | null {
    return this.acknowledgedSteerCapability;
  }

  findSteerConfigMismatch(input: SessionTurnInputConfig): string | null {
    return findActiveSteerConfigMismatch(input, this.configOptions, this.currentModel?.modelId);
  }

  async writeTextFile?(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    // ACP file writes are executed locally by the CLI and may be invoked by the agent.
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const resolvedPath = this.resolvePath(params.path);
    let oldText: string | null = null;
    try {
      oldText = await fs.readFile(resolvedPath, 'utf8');
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, params.content, 'utf8');
    if (this.options.onWriteTextFile) {
      try {
        await this.options.onWriteTextFile({
          path: resolvedPath,
          oldText,
          newText: params.content,
        });
      } catch (error) {
        this.logger.debug(
          `[${this.options.sessionId}] ACP write_text_file evidence callback failed: ${formatErrorMessage(error)}`
        );
      }
    }
    return {};
  }
  async readTextFile?(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    // ACP file reads can return large payloads; they are streamed to the UI via notifications,
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const resolvedPath = this.resolvePath(params.path);
    const content = await fs.readFile(resolvedPath, 'utf8');
    const sliced = sliceTextByLines(content, params.line ?? null, params.limit ?? null);
    return { content: sliced };
  }
  async createTerminal?(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const env =
      params.env?.reduce<Record<string, string>>((acc, variable) => {
        acc[variable.name] = variable.value;
        return acc;
      }, {}) ?? undefined;

    const terminalId = await this.terminalManager.createTerminal(
      params.sessionId,
      params.command,
      params.args ?? [],
      params.cwd ?? undefined,
      env,
      typeof params.outputByteLimit === 'bigint'
        ? params.outputByteLimit > BigInt(Number.MAX_SAFE_INTEGER)
          ? Number.MAX_SAFE_INTEGER
          : Number(params.outputByteLimit)
        : (params.outputByteLimit ?? undefined)
    );
    return { terminalId };
  }
  async terminalOutput?(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const result = await this.terminalManager.terminalOutput(params.sessionId, params.terminalId);
    return {
      output: result.output,
      truncated: result.truncated,
      exitStatus: result.exitStatus ?? undefined,
    };
  }
  async releaseTerminal?(
    params: acp.ReleaseTerminalRequest
  ): Promise<acp.ReleaseTerminalResponse | void> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    await this.terminalManager.releaseTerminal(params.sessionId, params.terminalId);
    return {};
  }
  async waitForTerminalExit?(
    params: acp.WaitForTerminalExitRequest
  ): Promise<acp.WaitForTerminalExitResponse> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const exitStatus = await this.terminalManager.waitForTerminalExit(
      params.sessionId,
      params.terminalId
    );
    return exitStatus;
  }
  async killTerminal?(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse | void> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    await this.terminalManager.killTerminal(params.sessionId, params.terminalId);
    return {};
  }
  async extMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    try {
      await this.handleExtensionMessage(method, params);
    } catch (error) {
      this.logger.warn(`Error handling extension method ${method}: ${error}`);
    }
    return {};
  }

  async extNotification?(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.handleExtensionMessage(method, params);
    } catch (error) {
      this.logger.warn(`Error handling extension notification ${method}: ${error}`);
    }
  }

  private async handleExtensionMessage(
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    // rust acp will add '_'
    const resolvedMethod = method.startsWith('_') ? method.slice(1) : method;
    if (resolvedMethod === this.acknowledgedSteerCapability?.appliedNotificationMethod) {
      await this.handleSteerApplied(resolvedMethod, params);
      return;
    }
    switch (resolvedMethod) {
      case 'acp_ext:session_usage_update': {
        const p = params as SessionUsageUpdate;
        if (p.modelUsage == null && this.currentModel) {
          p.modelUsage = {
            [this.currentModel.modelId]: toModelUsageFromUsage(p.usage),
          };
        } else {
          p.modelUsage = sanitizeModelUsage(p.modelUsage);
        }
        this.options.onUsageUpdate?.(p);
        break;
      }
      case 'acp_ext:session_rate_limits': {
        // only codex
        const limits = params as UsageData | undefined;
        // {
        //           planName: null,
        //             limitName: "GPT-5.3-Codex-Spark",
        //               limitId: "codex_bengalfox",
        //                 fiveHour: 0,
        //                   sevenDay: 3,
        //                     fiveHourResetAt: 1772607985,
        //                       sevenDayResetAt: 1773023790,
        // }
        //         {
        //           planName: null,
        //             limitName: null,
        //               limitId: "codex",
        //                 fiveHour: 10,
        //                   sevenDay: 25,
        //                     fiveHourResetAt: 1772603484,
        //                       sevenDayResetAt: 1773116209,
        // }
        if (limits) this.options.onRateLimitUpdate?.(limits);
        break;
      }
      case 'acp_ext:codex_proposed_plan': {
        this.tryHandleCodexProposedPlanExtension(resolvedMethod, params);
        break;
      }
      case CLAUDE_TASK_LIFECYCLE_EXTENSION_METHOD: {
        this.tryHandleClaudeTaskLifecycleExtension(resolvedMethod, params);
        break;
      }
      default:
        this.logger.debug(
          `[${this.options.sessionId}] Ignoring extension message ${resolvedMethod}`
        );
    }
  }

  private async handleSteerApplied(method: string, params: Record<string, unknown>): Promise<void> {
    const parsed = parseSteerAppliedParams(params);
    if (!parsed) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping invalid steer application from ${method}`
      );
      return;
    }
    const acpSessionId = parsed.sessionId as ACPSessionId;
    if (!this.isCurrentAcpSession(acpSessionId)) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping steer application for mismatched ACP session: ${acpSessionId}`
      );
      return;
    }
    const waiter = this.steerApplicationWaiters.get(parsed.steerId);
    if (!waiter || waiter.sessionId !== acpSessionId) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping steer application without a matching waiter: ${parsed.steerId}`
      );
      return;
    }
    if (!waiter.applied) {
      waiter.applied = true;
      this.steerApplicationBarrier = waiter.released;
      waiter.resolve({ release: waiter.release });
    }
    await waiter.released;
    if (this.steerApplicationBarrier === waiter.released) {
      this.steerApplicationBarrier = null;
    }
    if (this.steerApplicationWaiters.get(parsed.steerId) === waiter) {
      this.steerApplicationWaiters.delete(parsed.steerId);
    }
  }

  private tryHandleClaudeTaskLifecycleExtension(
    method: string,
    params: Record<string, unknown>
  ): void {
    const result = convertClaudeTaskLifecycleNotification(params);
    if (!result.ok) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping invalid Claude task lifecycle update from ${method}: ${result.reason}`
      );
      return;
    }

    const acpSessionId = result.notification.sessionId;
    if (!this.isCurrentAcpSession(acpSessionId)) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping Claude task lifecycle update for mismatched ACP session: ${acpSessionId}`
      );
      return;
    }

    this.options.onUpdateMessage(result.notification);
  }

  private tryHandleCodexProposedPlanExtension(
    method: string,
    params: Record<string, unknown>
  ): void {
    if (!this.options.onCodexProposedPlan) return;
    const result = CodexProposedPlanParamsSchema.safeParse(params);
    if (!result.success) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping invalid Codex proposed plan update from ${method}: ${result.error.message}`
      );
      return;
    }
    this.options.onCodexProposedPlan({
      type: 'proposed_plan',
      turnId: result.data.turnId,
      markdown: result.data.markdown,
      status: result.data.status,
      isLatest: result.data.isLatest,
    });
  }

  /** Forward titles from builtin adapters that own session title generation. */
  private handleAgentSessionTitleUpdate(notification: AcpSessionNotification): void {
    if (
      !usesAcpProvidedSessionTitle(
        this.options.agentConfig?.cliType,
        this.options.agentConfig?.agentType
      ) ||
      notification.update.sessionUpdate !== 'session_info_update'
    ) {
      return;
    }
    const title =
      typeof notification.update.title === 'string' ? notification.update.title.trim() : '';
    if (!title) {
      return;
    }
    this.options.onSessionTitleUpdate?.(title);
  }

  private isCodexAgent(): boolean {
    return this.options.agentConfig?.agentType === 'codex';
  }

  private isCurrentAcpSession(acpSessionId: string): boolean {
    return this.acpSessionId !== null && acpSessionId === this.acpSessionId;
  }

  private applySessionResponseState(sessionResponse: acp.NewSessionResponse): void {
    // Drop config options the current version intentionally skips (e.g. the
    // `agent` option from acp-extension-claude). See backward-compatibility doc
    // entry BC-2026-06-24-ACP-CONFIG-OPTION-AGENT-FILTERED.
    this.configOptions = filterAcpConfigOptions(sessionResponse.configOptions ?? []);
    this.legacySessionModelState = readLegacySessionModelState(sessionResponse) ?? null;
    this.currentModel = undefined;
    const initialModelOption = this.findConfigOptionByCategory('model');
    if (
      initialModelOption?.type === 'select' &&
      typeof initialModelOption.currentValue === 'string'
    ) {
      this.currentModel = this.resolveModelInfo(initialModelOption.currentValue);
    } else if (this.legacySessionModelState?.currentModelId) {
      this.currentModel = this.resolveModelInfo(this.legacySessionModelState.currentModelId);
    }
  }

  async startSession(
    stream: acp.Stream,
    workdir: string,
    resumeSessionId?: ACPSessionId,
    timeoutOptions: AcpStartupTimeoutOptions = {},
    startupAbort?: Promise<never>,
    resolveSessionStart?: () => Promise<AcpSessionStartTarget>,
    forkSessionId?: ACPSessionId,
    forkSessionTurnId?: string
  ): Promise<acp.NewSessionResponse> {
    const connection = new acp.ClientSideConnection(() => this, stream);
    this.connection = connection;
    this.logger.debug(
      `[${this.options.sessionId}] Starting ACP client (workdir=${workdir} resumeSessionId=${
        resumeSessionId ?? 'none'
      } forkSessionId=${forkSessionId ?? 'none'})`
    );
    if (resumeSessionId && forkSessionId) {
      throw new Error(
        '[ACP_SESSION_START_INVALID] resumeSessionId and forkSessionId are exclusive'
      );
    }

    // Common analytics props for the ACP startup funnel (spec §8c). Non-PII:
    // only cli_type/agent_type/launcher + opaque ids are emitted.
    const startupAnalyticsProps = {
      ...(this.options.agentConfig?.cliType ? { cliType: this.options.agentConfig.cliType } : {}),
      ...(this.options.agentConfig?.agentType
        ? { agentType: this.options.agentConfig.agentType }
        : {}),
      ...(this.options.launcher ? { launcher: this.options.launcher } : {}),
      isResume: !!resumeSessionId,
      sessionId: this.options.sessionId,
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
    };
    const startupStart = performance.now();

    const initStart = performance.now();
    this.options.onStartupStage?.({ type: 'initialize_start' });

    // connection.initialize() internally spawns the CLI process and waits for it to respond.
    // Missing dependencies or local runtime issues can hang this operation indefinitely.
    // Apply a hard timeout so startup fails fast.
    const ACP_INIT_TIMEOUT_MS = Math.max(0, timeoutOptions.initTimeoutMs ?? 120_000); // 2 minutes default

    let initResponse: acp.InitializeResponse;
    try {
      initResponse = await withTimeout(
        withAbort(
          connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              terminal: this.terminalEnabled,
              plan: {},
              auth: {
                terminal: true,
              },
              session: {
                configOptions: {
                  boolean: {},
                },
              },
              // Advertise file tools so agents can use structured reads/writes instead of shelling out.
              fs: {
                readTextFile: true,
                writeTextFile: true,
              },
              // Form elicitation is how acp-extension-claude >= 0.44.0 surfaces
              // AskUserQuestion; without it the agent disables the tool entirely.
              // Handled in `unstable_createElicitation` by bridging onto the
              // existing AskUserQuestion permission UI.
              elicitation: {
                form: {},
              },
              _meta: {
                // Legacy AskUserQuestion-via-permission capability for Claude
                // < 0.44.0; ignored by newer builds (which key off `elicitation`).
                claudeCode: {
                  askUserQuestion: true,
                },
                codex: {
                  requestUserInput: true,
                },
              },
            },
          }),
          startupAbort
        ),
        this.logger,
        'connection.initialize',
        this.options.sessionId,
        ACP_INIT_TIMEOUT_MS
      );
    } catch (error) {
      const reason = classifyAcpProtocolReason(error);
      captureAcpProtocolInitFailed({ ...startupAnalyticsProps, reason });
      if (reason === 'timeout') {
        captureAcpStartupTimeout({ ...startupAnalyticsProps, timedOutOperation: 'initialize' });
      }
      throw error;
    }
    const initDurationMs = performance.now() - initStart;
    this.options.onStartupStage?.({ type: 'initialize_end', durationMs: initDurationMs });
    this.logger.debug(
      `[${this.options.sessionId}] ACP initialize finished in ${Math.round(initDurationMs)}ms`
    );
    this.logger.debug(`[${this.options.sessionId}] ACP initialize response received`);
    this.authMethods = [...(initResponse.authMethods ?? [])];

    const loadSessionCapability = initResponse.agentCapabilities?.loadSession;
    this.supportsLoadSession = !!loadSessionCapability;
    const hasLoadSessionMethod = typeof connection.loadSession === 'function';

    const resumeCapability = initResponse.agentCapabilities?.sessionCapabilities?.resume;
    this.supportsResume = !!resumeCapability;
    captureAcpProtocolInitCompleted({
      ...startupAnalyticsProps,
      initDurationMs,
      supportsResume: this.supportsResume || this.supportsLoadSession,
    });
    const hasResumeMethod = typeof connection.resumeSession === 'function';
    const closeCapability = initResponse.agentCapabilities?.sessionCapabilities?.close;
    this.supportsClose = !!closeCapability;
    const forkCapability = initResponse.agentCapabilities?.sessionCapabilities?.fork;
    this.supportsFork = !!forkCapability;
    const forkAtTurnCapability = z
      .object({
        _meta: z
          .object({
            lody: z
              .object({
                forkAtTurn: z.object({
                  version: z.literal(1),
                }),
              })
              .partial(),
          })
          .partial(),
      })
      .safeParse(initResponse.agentCapabilities);
    this.supportsForkAtTurn =
      forkAtTurnCapability.success &&
      forkAtTurnCapability.data._meta?.lody?.forkAtTurn?.version === 1;
    this.acknowledgedSteerCapability = parseAcknowledgedSteerCapability(
      initResponse.agentCapabilities?._meta as Record<string, unknown> | null | undefined
    );
    const hasCloseMethod = typeof connection.closeSession === 'function';
    const hasForkMethod = typeof connection.unstable_forkSession === 'function';
    this.logger.debug(
      `[${this.options.sessionId}] ACP capabilities (loadSession=${
        this.supportsLoadSession ? 'yes' : 'no'
      } loadSessionMethod=${hasLoadSessionMethod ? 'yes' : 'no'} resume=${
        this.supportsResume ? 'yes' : 'no'
      } resumeMethod=${hasResumeMethod ? 'yes' : 'no'} close=${
        this.supportsClose ? 'yes' : 'no'
      } closeMethod=${hasCloseMethod ? 'yes' : 'no'} acknowledgedSteer=${
        this.acknowledgedSteerCapability ? 'yes' : 'no'
      } fork=${this.supportsFork ? 'yes' : 'no'} forkMethod=${hasForkMethod ? 'yes' : 'no'})`
    );

    if (resolveSessionStart) {
      const target = await withAbort(resolveSessionStart(), startupAbort);
      workdir = target.workdir;
      resumeSessionId = target.resumeSessionId;
    }

    this.logger.debug(`[${this.options.sessionId}] About to establish ACP session`);
    const newSessionStart = performance.now();
    this.options.onStartupStage?.({ type: 'new_session_start' });
    let sessionResponse: acp.NewSessionResponse;
    const mcpServers = this.buildMcpServers(workdir);

    const canLoadSession = this.supportsLoadSession && hasLoadSessionMethod;
    const canResumeSession = this.supportsResume && hasResumeMethod;
    const canForkSession = this.supportsFork && hasForkMethod;

    const preferResumeOverLoad =
      this.options.agentConfig?.cliType === 'builtin' &&
      this.options.agentConfig.agentType === 'kimi';
    const shouldResume = Boolean(
      resumeSessionId && canResumeSession && (preferResumeOverLoad || !canLoadSession)
    );
    const shouldLoad = Boolean(resumeSessionId && canLoadSession && !shouldResume);
    const sessionPath: AcpSessionPath = forkSessionId
      ? 'fork'
      : shouldLoad
        ? 'load'
        : shouldResume
          ? 'resume'
          : 'new';

    if (forkSessionId && !canForkSession) {
      const reasons: string[] = [];
      if (!this.supportsFork) {
        reasons.push('agent_did_not_advertise_session_fork');
      }
      if (!hasForkMethod) {
        reasons.push('sdk_missing_forkSession');
      }
      const reason = reasons.join(', ');
      this.logger.error(
        `[${this.options.sessionId}] ACP fork unsupported (${reason}): ${forkSessionId}`
      );
      captureAcpSessionEstablishFailed({
        ...startupAnalyticsProps,
        sessionPath: 'fork',
        reason: 'protocol_error',
      });
      throw new Error(`[ACP_FORK_UNSUPPORTED] ${reason}`);
    }
    if (forkSessionId && forkSessionTurnId && !this.supportsForkAtTurn) {
      throw new Error('[ACP_FORK_AT_TURN_UNSUPPORTED] agent_did_not_advertise_lody_forkAtTurn');
    }

    if (resumeSessionId) {
      if (!canLoadSession && !canResumeSession) {
        const reasons: string[] = [];
        if (!this.supportsLoadSession && !this.supportsResume) {
          reasons.push('agent_did_not_advertise_resume_or_loadSession');
        }
        if (!hasLoadSessionMethod && !hasResumeMethod) {
          reasons.push('sdk_missing_loadSession_and_resumeSession');
        }
        const reason = reasons.join(', ');
        this.logger.error(
          `[${this.options.sessionId}] ACP resume unsupported (${reason}): ${resumeSessionId}`
        );
        captureAcpSessionEstablishFailed({
          ...startupAnalyticsProps,
          sessionPath: 'resume',
          reason: 'protocol_error',
        });
        throw new Error(`[ACP_RESUME_UNSUPPORTED] ${reason}`);
      }
    }

    if (forkSessionId) {
      const forkStart = performance.now();
      try {
        const ACP_FORK_SESSION_TIMEOUT_MS = Math.max(
          0,
          timeoutOptions.newSessionTimeoutMs ?? 120_000
        );
        sessionResponse = await withTimeout(
          withAbort(
            connection.unstable_forkSession({
              sessionId: forkSessionId as unknown as acp.SessionId,
              cwd: workdir,
              mcpServers,
              ...(forkSessionTurnId
                ? {
                    _meta: {
                      lody: {
                        forkAtTurn: {
                          version: 1,
                          turnId: forkSessionTurnId,
                        },
                      },
                    },
                  }
                : {}),
            }),
            startupAbort
          ),
          this.logger,
          'connection.unstable_forkSession',
          this.options.sessionId,
          ACP_FORK_SESSION_TIMEOUT_MS
        );
        this.logger.debug(
          `[${this.options.sessionId}] ACP fork succeeded in ${Math.round(
            performance.now() - forkStart
          )}ms (sourceAcpSessionId=${forkSessionId}, acpSessionId=${sessionResponse.sessionId})`
        );
      } catch (error) {
        if (isAcpAuthenticationRequired(error)) {
          this.authenticationRequired = true;
          throw new AcpAuthenticationRequiredError(this.authMethods, { cause: error });
        }
        const reason = classifyAcpProtocolReason(error);
        captureAcpSessionEstablishFailed({
          ...startupAnalyticsProps,
          sessionPath: 'fork',
          reason,
        });
        if (reason === 'timeout') {
          captureAcpStartupTimeout({
            ...startupAnalyticsProps,
            timedOutOperation: 'fork_session',
          });
        }
        throw new Error(`[ACP_FORK_FAILED] ${formatErrorMessage(error)}`, { cause: error });
      }
    } else if (resumeSessionId && shouldLoad) {
      // Prefer the stable loadSession API (ACP 0.17+).
      const loadStart = performance.now();
      try {
        this.logger.debug(
          `[${this.options.sessionId}] Attempting ACP loadSession (acpSessionId=${resumeSessionId})`
        );
        const ACP_LOAD_SESSION_TIMEOUT_MS = Math.max(
          0,
          timeoutOptions.loadSessionTimeoutMs ?? timeoutOptions.newSessionTimeoutMs ?? 120_000
        );
        const loadResponse = await withTimeout(
          withAbort(
            connection.loadSession({
              sessionId: resumeSessionId,
              cwd: workdir,
              mcpServers,
            }),
            startupAbort
          ),
          this.logger,
          'connection.loadSession',
          this.options.sessionId,
          ACP_LOAD_SESSION_TIMEOUT_MS
        );
        const loadDurationMs = performance.now() - loadStart;
        sessionResponse = {
          ...loadResponse,
          sessionId: resumeSessionId as unknown as acp.SessionId,
        };
        this.logger.debug(
          `[${this.options.sessionId}] ACP loadSession succeeded in ${Math.round(
            loadDurationMs
          )}ms (acpSessionId=${resumeSessionId})`
        );
      } catch (error) {
        if (isAcpAuthenticationRequired(error)) {
          this.authenticationRequired = true;
          throw new AcpAuthenticationRequiredError(this.authMethods, { cause: error });
        }
        const loadDurationMs = performance.now() - loadStart;
        this.logger.debug(
          `[${this.options.sessionId}] ACP loadSession failed in ${Math.round(
            loadDurationMs
          )}ms (acpSessionId=${resumeSessionId}): ${formatErrorMessage(error)}`
        );
        const reason = classifyAcpProtocolReason(error);
        captureAcpSessionEstablishFailed({ ...startupAnalyticsProps, sessionPath: 'load', reason });
        if (reason === 'timeout') {
          captureAcpStartupTimeout({
            ...startupAnalyticsProps,
            timedOutOperation: 'load_session',
          });
        }
        throw new Error(`[ACP_RESUME_FAILED] loadSession: ${formatErrorMessage(error)}`, {
          cause: error,
        });
      }
    } else if (resumeSessionId && shouldResume) {
      // Fallback to session/resume when the agent can resume without replaying prior messages.
      const resumeStart = performance.now();
      try {
        this.logger.debug(
          `[${this.options.sessionId}] Attempting ACP resume (acpSessionId=${resumeSessionId})`
        );
        const ACP_RESUME_SESSION_TIMEOUT_MS = Math.max(
          0,
          timeoutOptions.resumeSessionTimeoutMs ?? timeoutOptions.newSessionTimeoutMs ?? 120_000
        );
        const resumeResponse = await withTimeout(
          withAbort(
            connection.resumeSession({
              sessionId: resumeSessionId,
              cwd: workdir,
              mcpServers,
            }),
            startupAbort
          ),
          this.logger,
          'connection.resumeSession',
          this.options.sessionId,
          ACP_RESUME_SESSION_TIMEOUT_MS
        );
        const resumeDurationMs = performance.now() - resumeStart;
        // Resume responses don't include `sessionId`, so we stitch it back in for uniform handling.
        sessionResponse = {
          ...resumeResponse,
          sessionId: resumeSessionId as unknown as acp.SessionId,
        };
        this.logger.debug(
          `[${this.options.sessionId}] ACP resume succeeded in ${Math.round(
            resumeDurationMs
          )}ms (acpSessionId=${resumeSessionId})`
        );
      } catch (error) {
        if (isAcpAuthenticationRequired(error)) {
          this.authenticationRequired = true;
          throw new AcpAuthenticationRequiredError(this.authMethods, { cause: error });
        }
        const resumeDurationMs = performance.now() - resumeStart;
        this.logger.debug(
          `[${this.options.sessionId}] ACP resume failed in ${Math.round(
            resumeDurationMs
          )}ms (acpSessionId=${resumeSessionId}): ${formatErrorMessage(error)}`
        );
        const reason = classifyAcpProtocolReason(error);
        captureAcpSessionEstablishFailed({
          ...startupAnalyticsProps,
          sessionPath: 'resume',
          reason,
        });
        if (reason === 'timeout') {
          captureAcpStartupTimeout({
            ...startupAnalyticsProps,
            timedOutOperation: 'resume_session',
          });
        }
        throw new Error(`[ACP_RESUME_FAILED] ${formatErrorMessage(error)}`, { cause: error });
      }
    } else {
      this.logger.debug(
        `[${this.options.sessionId}] Calling connection.newSession (cwd=${workdir})`
      );

      // newSession() waits for the Claude Code CLI to:
      // 1. Initialize settings from multiple config files
      // 2. Start the internal query system which spawns another subprocess
      // 3. Call query.supportedModels() and query.supportedCommands()
      // Any of these can hang due to runtime/environment issues. Apply a hard timeout.
      const ACP_NEW_SESSION_TIMEOUT_MS = Math.max(0, timeoutOptions.newSessionTimeoutMs ?? 120_000); // 2 minutes default

      try {
        sessionResponse = await withTimeout(
          withAbort(connection.newSession({ cwd: workdir, mcpServers }), startupAbort),
          this.logger,
          'connection.newSession',
          this.options.sessionId,
          ACP_NEW_SESSION_TIMEOUT_MS
        );
      } catch (error) {
        if (isAcpAuthenticationRequired(error)) {
          this.authenticationRequired = true;
          throw new AcpAuthenticationRequiredError(this.authMethods, { cause: error });
        }
        const reason = classifyAcpProtocolReason(error);
        captureAcpSessionEstablishFailed({ ...startupAnalyticsProps, sessionPath: 'new', reason });
        if (reason === 'timeout') {
          captureAcpStartupTimeout({
            ...startupAnalyticsProps,
            timedOutOperation: 'new_session',
          });
        }
        throw error;
      }
      this.logger.debug(`[${this.options.sessionId}] connection.newSession returned`);
    }
    this.authenticationRequired = false;
    const newSessionDurationMs = performance.now() - newSessionStart;
    this.options.onStartupStage?.({ type: 'new_session_end', durationMs: newSessionDurationMs });
    this.logger.debug(
      `[${this.options.sessionId}] ACP session start finished in ${Math.round(
        newSessionDurationMs
      )}ms (acpSessionId=${sessionResponse.sessionId} resumed=${
        resumeSessionId && sessionResponse.sessionId === resumeSessionId ? 'yes' : 'no'
      })`
    );
    this.logger.debug('ACP Session started:', sessionResponse);
    this.applySessionResponseState(sessionResponse);

    const availableModesCount = sessionResponse.modes?.availableModes?.length ?? 0;
    captureAcpSessionEstablished({
      ...startupAnalyticsProps,
      sessionPath,
      availableModesCount,
      establishDurationMs: newSessionDurationMs,
    });
    captureAcpStartupCompleted({
      ...startupAnalyticsProps,
      sessionPath,
      totalStartupMs: performance.now() - startupStart,
      initDurationMs,
      sessionEstablishDurationMs: newSessionDurationMs,
    });

    this.acpSessionId = sessionResponse.sessionId;
    this.logger.debug(
      `[${this.options.sessionId}] ACP session id set: ${sessionResponse.sessionId}`
    );
    this.sessionWorkdir = workdir;
    this.logger.debug(`ACP Session mode set to agent: ${sessionResponse.sessionId}`);
    return sessionResponse;
  }

  /**
   * Establish the provider session used by edit-and-resend without changing the
   * currently active ACP session. The caller can therefore fail before cancel
   * and leave the old turn untouched.
   */
  async prepareReplacementSession(
    forkSessionTurnId?: string,
    timeoutMs: number = 120_000
  ): Promise<acp.NewSessionResponse> {
    const connection = this.connection;
    const workdir = this.sessionWorkdir;
    const sourceSessionId = this.acpSessionId;
    if (!connection || !workdir || !sourceSessionId) {
      throw new Error('[ACP_SESSION_UNAVAILABLE] Current ACP session is not ready');
    }

    const mcpServers = this.buildMcpServers(workdir);
    if (!forkSessionTurnId) {
      try {
        return await withTimeout(
          connection.newSession({ cwd: workdir, mcpServers }),
          this.logger,
          'connection.newSession.editAndResend',
          this.options.sessionId,
          timeoutMs
        );
      } catch (error) {
        throw new Error(`[ACP_SESSION_PREPARE_FAILED] ${formatErrorMessage(error)}`, {
          cause: error,
        });
      }
    }

    if (
      !this.supportsFork ||
      !this.supportsForkAtTurn ||
      typeof connection.unstable_forkSession !== 'function'
    ) {
      throw new Error('[ACP_FORK_AT_TURN_UNSUPPORTED] Provider cannot fork at this turn');
    }

    try {
      return await withTimeout(
        connection.unstable_forkSession({
          sessionId: sourceSessionId as unknown as acp.SessionId,
          cwd: workdir,
          mcpServers,
          _meta: {
            lody: {
              forkAtTurn: {
                version: 1,
                turnId: forkSessionTurnId,
              },
            },
          },
        }),
        this.logger,
        'connection.unstable_forkSession.editAndResend',
        this.options.sessionId,
        timeoutMs
      );
    } catch (error) {
      throw new Error(`[ACP_FORK_FAILED] ${formatErrorMessage(error)}`, { cause: error });
    }
  }

  adoptPreparedSession(sessionResponse: acp.NewSessionResponse): void {
    this.applySessionResponseState(sessionResponse);
    this.acpSessionId = sessionResponse.sessionId;
    this.authenticationRequired = false;
    this.logger.debug(
      `[${this.options.sessionId}] Adopted replacement ACP session: ${sessionResponse.sessionId}`
    );
  }

  supportsSessionFork(): boolean {
    return this.supportsFork;
  }

  supportsActiveTurnFork(): boolean {
    return this.supportsFork && this.supportsForkAtTurn;
  }

  steerPrompt(
    sessionId: ACPSessionId,
    prompt: acp.ContentBlock[],
    options?: { signal?: AbortSignal }
  ): SteerPromptRun {
    const capability = this.acknowledgedSteerCapability;
    if (!capability) {
      throw new Error('Agent does not support acknowledged steer');
    }
    const steerId = randomUUID();
    let resolveApplication!: (lease: SteerApplicationLease) => void;
    let rejectApplication!: (error: unknown) => void;
    const applied = new Promise<SteerApplicationLease>((resolve, reject) => {
      resolveApplication = resolve;
      rejectApplication = reject;
    });
    let resolveRelease!: () => void;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      resolveRelease();
    };
    const waiter: SteerApplicationWaiter = {
      sessionId,
      applied: false,
      resolve: resolveApplication,
      reject: rejectApplication,
      released: new Promise<void>((resolve) => {
        resolveRelease = resolve;
      }),
      release,
    };
    this.steerApplicationWaiters.set(steerId, waiter);

    let completion: Promise<acp.PromptResponse | undefined>;
    let submission: Promise<unknown>;
    if (capability.requestMethod) {
      const activePrompt = this.activePromptCompletion;
      if (!activePrompt || activePrompt.sessionId !== sessionId) {
        this.steerApplicationWaiters.delete(steerId);
        waiter.release();
        throw new Error('No active ACP prompt completion is available for steer handoff');
      }
      completion = activePrompt.promise;
      submission = this.requestSteeringExtension(
        capability.requestMethod,
        sessionId,
        prompt,
        steerId,
        options?.signal
      );
    } else {
      completion = this.prompt(sessionId, prompt, {
        signal: options?.signal,
        _meta: buildSteerRequestMeta(capability, steerId),
      });
      submission = completion;
    }
    const failUnapplied = (error: unknown) => {
      if (!waiter.applied && this.steerApplicationWaiters.get(steerId) === waiter) {
        this.steerApplicationWaiters.delete(steerId);
        waiter.reject(error);
        waiter.release();
      }
    };
    if (submission !== completion) {
      // A refusal ends the steer immediately; the turn it was aimed at may run on.
      void submission.catch(failUnapplied);
    }
    // Otherwise wait for BOTH. The upstream turn's own response can beat the
    // agent's answer to the steer request onto the wire (the Codex adapter drains
    // session notifications before it refuses), and that answer is the verdict
    // that says whether the prompt was taken — losing it to the turn's response
    // would downgrade a provable refusal to an ambiguous failure and strand the
    // user's message. Both settle: the turn completes, and the request is either
    // answered or rejected when the connection closes.
    void Promise.allSettled([submission, completion]).then(([submitted]) => {
      failUnapplied(
        submitted.status === 'rejected'
          ? submitted.reason
          : new Error(`Steer ${steerId} completed before application`)
      );
    });
    return { completion, applied };
  }

  private async requestSteeringExtension(
    method: string,
    sessionId: ACPSessionId,
    prompt: acp.ContentBlock[],
    steerId: string,
    signal?: AbortSignal
  ): Promise<void> {
    let request: Promise<unknown>;
    try {
      this.ensureSessionMatch(sessionId);
      const connection = this.connection;
      if (!connection) {
        throw new Error('ACP connection is not available');
      }
      if (signal?.aborted) {
        throw new Error('Agent steer aborted');
      }
      request = connection.request<
        unknown,
        {
          sessionId: string;
          prompt: acp.ContentBlock[];
          steerId: string;
        }
      >(method, { sessionId, prompt, steerId });
    } catch (error) {
      // Nothing was written to the agent, so the prompt is provably still ours.
      throw new AgentSteerNotDeliveredError(
        `Could not submit acknowledged steer ${steerId}: ${formatErrorMessage(error)}`,
        error
      );
    }
    let abortListener: (() => void) | undefined;
    const abort = signal
      ? new Promise<never>((_, reject) => {
          abortListener = () => reject(new Error('Agent steer aborted'));
          signal.addEventListener('abort', abortListener, { once: true });
        })
      : undefined;
    try {
      const response = await withAbort(request, abort).catch((error: unknown) => {
        // Only the agent's own `invalid request` answer proves it declined the
        // prompt (Codex answers `No active Codex turn to steer`). A closed
        // connection, a dead agent process, or an internal error may have left
        // the prompt inside the live turn, so those stay ambiguous — re-sending
        // one of those would deliver the user's message twice.
        throw isAcpInvalidRequestError(error)
          ? new AgentSteerNotDeliveredError(
              `Agent refused the acknowledged steer request ${method}: ${formatErrorMessage(error)}`,
              error
            )
          : error;
      });
      const parsed = z.object({ outcome: z.literal('injected') }).safeParse(response);
      if (!parsed.success) {
        throw new Error(`Agent returned an invalid acknowledged steer response for ${method}`);
      }
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  async prompt(
    sessionId: ACPSessionId,
    prompt: acp.ContentBlock[],
    options?: { signal?: AbortSignal; _meta?: acp.PromptRequest['_meta'] }
  ) {
    const span = startTraceSpan(this.logger, 'agent_client.prompt', {
      sessionId: this.options.sessionId,
      acpSessionId: sessionId,
      promptBlocks: prompt.length,
    });
    this.logger.debug(
      `[${this.options.sessionId}] AgentClient.prompt called (acpSessionId=${sessionId})`
    );
    try {
      this.ensureSessionMatch(sessionId);
      const abortSignal = options?.signal;
      if (abortSignal?.aborted) {
        throw new Error('Agent prompt aborted');
      }
      this.logger.debug(
        `[${this.options.sessionId}] Session match verified, calling connection.prompt`
      );
      const promptPromise = this.connection?.prompt({
        sessionId,
        prompt,
        ...(options?._meta ? { _meta: options._meta } : {}),
      });
      if (!promptPromise) {
        this.logger.error(
          `[${this.options.sessionId}] connection.prompt returned undefined - connection may be closed`
        );
        span.end({ outcome: 'undefined-promise' });
        return undefined;
      }

      let abortListener: (() => void) | undefined;
      let trackedPromptCompletion: ActivePromptCompletion | undefined;

      try {
        const abortPromise = abortSignal
          ? new Promise<never>((_, reject) => {
              abortListener = () => {
                this.logger.debug(
                  `[${this.options.sessionId}] AgentClient.prompt aborted; sending ACP cancel (acpSessionId=${sessionId})`
                );
                void this.cancel(sessionId).catch((error: unknown) => {
                  this.logger.debug(
                    `[${this.options.sessionId}] Failed to cancel aborted prompt: ${formatErrorMessage(error)}`
                  );
                });
                reject(new Error('Agent prompt aborted'));
              };
              abortSignal.addEventListener('abort', abortListener, { once: true });
            })
          : null;
        const completion = abortPromise
          ? Promise.race([promptPromise, abortPromise])
          : promptPromise;
        trackedPromptCompletion = { sessionId, promise: completion };
        this.activePromptCompletion = trackedPromptCompletion;
        const result = await completion;
        span.end({ outcome: 'returned' });
        this.logger.debug(`[${this.options.sessionId}] connection.prompt returned`);
        return result;
      } catch (error) {
        this.logger.error(
          `[${this.options.sessionId}] connection.prompt failed (${this.describePromptDiagnosticContext()}): ${formatErrorMessage(
            error,
            { includeStack: true }
          )}`
        );
        throw error;
      } finally {
        if (this.activePromptCompletion === trackedPromptCompletion) {
          this.activePromptCompletion = null;
        }
        if (abortSignal && abortListener) {
          abortSignal.removeEventListener('abort', abortListener);
        }
      }
    } catch (error) {
      span.fail(error);
      throw error;
    } finally {
      this.completeCodexRetryStatus();
    }
  }

  async cancel(sessionId: ACPSessionId) {
    this.ensureSessionMatch(sessionId);
    return await this.connection?.cancel({ sessionId });
  }

  async closeSession(sessionId: ACPSessionId, timeoutMs: number = 5000): Promise<boolean> {
    this.ensureSessionMatch(sessionId);

    return await this.closeDetachedSession(sessionId, timeoutMs);
  }

  async closeDetachedSession(sessionId: ACPSessionId, timeoutMs: number = 5000): Promise<boolean> {
    if (!this.supportsClose) {
      this.logger.debug(
        `[${this.options.sessionId}] Skipping ACP session close: agent did not advertise session.close`
      );
      return false;
    }

    const closeSession = this.connection?.closeSession;
    if (typeof closeSession !== 'function') {
      this.logger.debug(
        `[${this.options.sessionId}] Skipping ACP session close: SDK connection has no closeSession`
      );
      return false;
    }

    this.logger.debug(
      `[${this.options.sessionId}] Closing ACP session (acpSessionId=${sessionId} timeoutMs=${timeoutMs})`
    );
    await withTimeout(
      closeSession.call(this.connection, { sessionId }),
      this.logger,
      'connection.closeSession',
      this.options.sessionId,
      timeoutMs,
      Math.min(timeoutMs, 1000)
    );
    this.logger.debug(
      `[${this.options.sessionId}] ACP session close finished (acpSessionId=${sessionId})`
    );
    return true;
  }
  /**
   * Set a session configuration option via the new configOptions API.
   * Returns the updated configOptions array, or undefined on failure.
   */
  async setSessionConfigOption(
    sessionId: ACPSessionId,
    configId: string,
    value: AcpConfigOptionValue
  ): Promise<acp.SessionConfigOption[] | undefined> {
    const request =
      typeof value === 'boolean'
        ? { sessionId, configId, type: 'boolean' as const, value }
        : { sessionId, configId, value };
    this.logger.debug(
      `[${this.options.sessionId}] setSessionConfigOption called (configId=${configId} value=${value})`
    );
    this.ensureSessionMatch(sessionId);

    const result = await withTransportRetry(
      async () => {
        const promise = this.connection?.setSessionConfigOption(request);
        if (promise) {
          return await withSlowOperationWarning(
            promise,
            this.logger,
            'connection.setSessionConfigOption',
            this.options.sessionId
          );
        }
        return undefined;
      },
      this.logger,
      'setSessionConfigOption',
      this.options.sessionId
    );

    if (result?.configOptions) {
      // The agent returns the full option list, which re-includes any filtered
      // option (e.g. `agent`); drop it again here. See BC doc entry
      // BC-2026-06-24-ACP-CONFIG-OPTION-AGENT-FILTERED.
      this.configOptions = filterAcpConfigOptions(result.configOptions);
      // Keep the thought-level label carried on currentModel in sync when the
      // user changes the thinking level (or any config option) mid-session.
      if (this.currentModel) {
        this.currentModel = this.resolveModelInfo(this.currentModel.modelId);
      }
    }

    this.logger.debug(
      `[${this.options.sessionId}] ACP session config option set: ${configId}=${value}`
    );
    return result?.configOptions;
  }

  /** Returns the config options currently known for this session. */
  getConfigOptions(): acp.SessionConfigOption[] {
    return this.configOptions;
  }

  /**
   * Find the configOption with the given category, if available.
   */
  private findConfigOptionByCategory(category: string): acp.SessionConfigOption | undefined {
    return this.configOptions.find((opt) => opt.category === category);
  }

  /**
   * Resolve a model id to its full `ModelInfo` (with the agent's human-readable
   * `name`) and attach the active thinking level. Uses the "model" config
   * option's label, falling back to the raw id when the agent reported no name.
   */
  private resolveModelInfo(modelId: string): ModelInfo {
    const base: ModelInfo = {
      modelId,
      name:
        this.findModelConfigOptionName(modelId) ??
        this.legacySessionModelState?.availableModels.find((model) => model.modelId === modelId)
          ?.name ??
        modelId,
    };
    return this.attachThoughtLevel(base);
  }

  /**
   * Stash the active thinking/reasoning level label under `ModelInfo._meta` so
   * the chat UI can render it after the model name. No-op (and does not copy the
   * object) when the agent exposes no thought-level option.
   */
  private attachThoughtLevel(model: ModelInfo): ModelInfo {
    const label = this.getCurrentThoughtLevelLabel();
    if (!label) return model;
    return {
      ...model,
      _meta: { ...(model._meta ?? {}), [MODEL_THOUGHT_LEVEL_META_KEY]: label },
    };
  }

  /** Human-readable label of the currently selected thought-level / reasoning-effort option. */
  private getCurrentThoughtLevelLabel(): string | undefined {
    const opt = this.configOptions.find(
      (o) => o.category === 'thought_level' || o.id === 'reasoning_effort'
    );
    if (!opt || opt.type !== 'select') return undefined;
    return this.findSelectOptionName(opt.options, opt.currentValue);
  }

  /** Look up the human-readable label for a model value in the "model" select config option. */
  private findModelConfigOptionName(value: string): string | undefined {
    const modelConfigOption = this.findConfigOptionByCategory('model');
    if (!modelConfigOption || modelConfigOption.type !== 'select') return undefined;
    return this.findSelectOptionName(modelConfigOption.options, value);
  }

  /** Find the `name` of the matching option `value` in a select option list (flat or grouped). */
  private findSelectOptionName(
    options: acp.SessionConfigSelectOptions,
    value: acp.SessionConfigValueId
  ): string | undefined {
    for (const entry of options) {
      if ('value' in entry) {
        if (entry.value === value) return entry.name;
      } else {
        const found = entry.options.find((opt) => opt.value === value);
        if (found) return found.name;
      }
    }
    return undefined;
  }

  /**
   * Whether permission/sandbox mode changes should call protocol
   * session/set_mode directly instead of the generic config option API.
   */
  private shouldUseProtocolSetModeRouting(): boolean {
    return this.options.agentConfig?.agentType === 'codex';
  }

  async setSessionMode(sessionId: ACPSessionId, modeId: string) {
    this.logger.debug(`[${this.options.sessionId}] setSessionMode called (modeId=${modeId})`);
    this.ensureSessionMatch(sessionId);

    // `session/set_mode` is reserved for permission/sandbox mode. For agents
    // that expose permission mode as a config option, route through
    // setSessionConfigOption; Codex still exposes the protocol set_mode request directly.
    const modeConfigOption = !this.shouldUseProtocolSetModeRouting()
      ? this.findConfigOptionByCategory('mode')
      : undefined;
    if (modeConfigOption) {
      this.logger.debug(
        `[${this.options.sessionId}] Using setSessionConfigOption for mode (configId=${modeConfigOption.id} value=${modeId})`
      );
      try {
        await this.setSessionConfigOption(sessionId, modeConfigOption.id, modeId);
        this.logger.debug(
          `[${this.options.sessionId}] ACP session mode set via configOption: ${modeId}`
        );
        return;
      } catch (err) {
        this.logger.debug(
          `[${this.options.sessionId}] setSessionConfigOption failed for mode, falling back to legacy setSessionMode: ${err}`
        );
        // Fall through to legacy setSessionMode path below
      }
    }

    this.logger.debug(
      `[${this.options.sessionId}] Calling connection.setSessionMode (modeId=${modeId})`
    );
    await withTransportRetry(
      async () => {
        const setModePromise = this.connection?.setSessionMode({ sessionId, modeId });
        if (setModePromise) {
          await withSlowOperationWarning(
            setModePromise,
            this.logger,
            'connection.setSessionMode',
            this.options.sessionId
          );
        }
      },
      this.logger,
      'setSessionMode',
      this.options.sessionId
    );
    this.logger.debug(`[${this.options.sessionId}] ACP session mode set: ${modeId}`);
  }

  async unstable_setSessionModel(sessionId: ACPSessionId, modelId: string) {
    this.logger.debug(
      `[${this.options.sessionId}] unstable_setSessionModel called (modelId=${modelId})`
    );
    this.ensureSessionMatch(sessionId);

    // Prefer the current configOptions API. A session that explicitly reports
    // the legacy top-level `models` state may instead support `session/set_model`.
    const modelConfigOption = this.findConfigOptionByCategory('model');
    if (modelConfigOption) {
      this.logger.debug(
        `[${this.options.sessionId}] Using setSessionConfigOption for model (configId=${modelConfigOption.id} value=${modelId})`
      );
      try {
        const updatedConfigOptions = await this.setSessionConfigOption(
          sessionId,
          modelConfigOption.id,
          modelId
        );
        if (!updatedConfigOptions) return;
        this.currentModel = this.resolveModelInfo(modelId);
        this.logger.debug(
          `[${this.options.sessionId}] ACP session model set via configOption: ${modelId}`
        );
        return;
      } catch (error) {
        if (!this.legacySessionModelState || !isAcpMethodNotFoundError(error)) {
          throw error;
        }
        this.logger.debug(
          `[${this.options.sessionId}] setSessionConfigOption is unavailable; falling back to legacy session/set_model`
        );
      }
    }

    if (!this.legacySessionModelState) {
      throw new Error(
        `[ACP_MODEL_SWITCH_UNSUPPORTED] Agent reported neither a model config option nor legacy session models`
      );
    }

    const connection = this.connection;
    if (!connection) {
      throw new Error('[ACP_MODEL_SWITCH_UNSUPPORTED] ACP connection is not available');
    }
    const switched = await withTransportRetry(
      async () => {
        const requestPromise = connection.request<unknown, { sessionId: string; modelId: string }>(
          'session/set_model',
          { sessionId, modelId }
        );
        await withSlowOperationWarning(
          requestPromise,
          this.logger,
          'connection.request(session/set_model)',
          this.options.sessionId
        );
        return true;
      },
      this.logger,
      'setSessionModel',
      this.options.sessionId
    );
    if (!switched) return;
    this.currentModel = this.resolveModelInfo(modelId);
    this.logger.debug(
      `[${this.options.sessionId}] ACP session model set via legacy session/set_model: ${modelId}`
    );
  }

  private ensureSessionMatch(sessionId: ACPSessionId) {
    if (!this.acpSessionId) {
      throw new Error('ACP session has not been initialized yet.');
    }
    if (sessionId !== this.acpSessionId) {
      throw new Error(`Mismatched ACP session. Expected ${this.acpSessionId} but got ${sessionId}`);
    }
  }

  private resolvePath(inputPath: string): string {
    // Resolve relative paths against the session workdir so tools behave like the terminal.
    // `path.resolve(base, absolute)` returns the absolute path, so this works for both cases.
    const base = this.sessionWorkdir ?? process.cwd();
    return path.resolve(base, inputPath);
  }
}

function isUsageUpdate(
  update: unknown
): update is { sessionUpdate: 'usage_update'; size?: unknown; used?: unknown } {
  return (
    typeof update === 'object' &&
    update !== null &&
    'sessionUpdate' in update &&
    (update as { sessionUpdate?: unknown }).sessionUpdate === 'usage_update'
  );
}

const sliceTextByLines = (content: string, line: number | null, limit: number | null): string => {
  if (line === null && limit === null) return content;
  // ACP uses 1-based line numbers. We treat `line` as the first line to include.
  const lines = content.split(/\r?\n/);
  const start = Math.max((line ?? 1) - 1, 0);
  const end = limit !== null ? start + Math.max(limit, 0) : undefined;
  return lines.slice(start, end).join('\n');
};
