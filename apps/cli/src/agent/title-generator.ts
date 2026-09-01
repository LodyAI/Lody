import { execFile } from 'child_process';
import path from 'path';
import os from 'os';
import * as fs from 'fs';
import { promisify } from 'util';

import {
  type AcpConfigOptionSummary,
  type AcpSessionNotification,
  type ACPSessionId,
  type AcpConfigOptionValue,
  DEFAULT_TITLE_GENERATION_PROMPT,
  type AgentConfigCliType,
  type AgentType,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
  type TitleGenerationConfig,
  computeTitleGenerationDefaults,
  sanitizeLodyInternalInstructions,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { TerminalManager } from '@/session/terminal-manager';
import { shutdownLocalAcpAgent, startLocalAcpAgent } from './acp-runner';
import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelectGroup,
} from '@agentclientprotocol/sdk';
import { extractTextFromAgentResponse } from './response-utils';
import { formatErrorMessage } from '@/utils/format-error';
import { normalizeConfigOptions } from './acp-capabilities';
import { readLegacySessionModelState } from './acp-capability-normalization';
import { parseLodyMessagePhase } from './lody-acp-extension';

const execFileAsync = promisify(execFile);
const TITLE_GIT_TIMEOUT_MS = 5_000;
export const TITLE_TASK_PROMPT_MAX_CHARS = 4_000;

const truncateTitleTaskPrompt = (taskPrompt: string): string => {
  if (taskPrompt.length <= TITLE_TASK_PROMPT_MAX_CHARS) {
    return taskPrompt;
  }

  const marker = `\n\n[Title input truncated to ${TITLE_TASK_PROMPT_MAX_CHARS} chars]`;
  return `${taskPrompt.slice(0, TITLE_TASK_PROMPT_MAX_CHARS - marker.length).trimEnd()}${marker}`;
};

export const buildTitlePrompt = (taskPrompt: string): ContentBlock[] => {
  const text = DEFAULT_TITLE_GENERATION_PROMPT.replace(
    /\$\{prompt\}/g,
    truncateTitleTaskPrompt(taskPrompt)
  );
  return [{ type: 'text', text }];
};

type SessionConfigSelectEntry = Extract<SessionConfigOption, { type: 'select' }>['options'][number];

const isSelectGroup = (option: SessionConfigSelectEntry): option is SessionConfigSelectGroup =>
  'group' in option;

const selectOptionValues = (option: SessionConfigOption): string[] => {
  if (option.type !== 'select') {
    return [];
  }
  return option.options.flatMap((entry) =>
    isSelectGroup(entry) ? entry.options.map((child) => child.value) : [entry.value]
  );
};

const canApplyConfigOptionValue = (
  option: SessionConfigOption,
  value: string | boolean
): boolean => {
  if (option.type === 'boolean') {
    return typeof value === 'boolean';
  }
  return typeof value === 'string' && selectOptionValues(option).includes(value);
};

type TitleConfigClient = {
  setSessionConfigOption(
    sessionId: ACPSessionId,
    configId: string,
    value: AcpConfigOptionValue
  ): Promise<SessionConfigOption[] | undefined>;
  unstable_setSessionModel(sessionId: ACPSessionId, modelId: string): Promise<void>;
};

export async function applyTitleConfigOptions(options: {
  client: TitleConfigClient;
  acpSessionId: ACPSessionId;
  sessionResponse: unknown;
  configOptionValues: Record<string, AcpConfigOptionValue>;
  logger: Logger;
}): Promise<void> {
  const sessionResponse = options.sessionResponse as {
    configOptions?: SessionConfigOption[] | null;
  };
  let currentConfigOptions = sessionResponse.configOptions ?? [];
  const modelConfigOption = currentConfigOptions.find((option) => option.category === 'model');
  const legacyModelState = readLegacySessionModelState(options.sessionResponse);
  const entries = Object.entries(options.configOptionValues).sort(([left], [right]) => {
    const modelKey = modelConfigOption?.id ?? (legacyModelState ? 'model' : undefined);
    return Number(right === modelKey) - Number(left === modelKey);
  });

  for (const [key, value] of entries) {
    const currentOption = currentConfigOptions.find((option) => option.id === key);
    if (currentOption && canApplyConfigOptionValue(currentOption, value)) {
      const updatedConfigOptions = await options.client.setSessionConfigOption(
        options.acpSessionId,
        key,
        value
      );
      currentConfigOptions = updatedConfigOptions ?? currentConfigOptions;
      continue;
    }

    const isAdvertisedLegacyModel =
      !modelConfigOption &&
      key === 'model' &&
      typeof value === 'string' &&
      legacyModelState?.availableModels.some((model) => model.modelId === value);
    if (isAdvertisedLegacyModel) {
      await options.client.unstable_setSessionModel(options.acpSessionId, value);
      continue;
    }

    options.logger.debug(
      `[title-generator] Skipping unavailable title config option ${key}=${String(value)}`
    );
  }
}

export const extractTitleFromAgentResponse = (response: unknown): string | null =>
  extractTextFromAgentResponse(response);

export const extractTitleChunkFromNotification = (
  notification: AcpSessionNotification,
  agentType?: AgentType
): string | null => {
  const update = notification.update;
  if (update.sessionUpdate !== 'agent_message_chunk') {
    return null;
  }
  const content = update.content;
  if (!content || content.type !== 'text') {
    return null;
  }

  const phase = parseLodyMessagePhase(update._meta);
  if (agentType === 'codex') {
    if (phase !== 'final_answer') {
      return null;
    }
    return content.text;
  }
  if (phase !== undefined && phase !== 'final_answer') {
    return null;
  }

  return content.text;
};

export const sanitizeTitle = (candidate?: string | null): string | null => {
  if (!candidate) return null;
  const normalized = candidate
    .replace(/\\[rnt]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const unquoted = normalized
    .replace(/^["'\u201C\u201D\u2018\u2019`]+|["'\u201C\u201D\u2018\u2019`]+$/g, '')
    .trim();
  if (!unquoted) return null;

  const withoutMarkdown = unquoted
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^__(.+)__$/, '$1')
    .trim();

  if (!withoutMarkdown) return null;
  return withoutMarkdown.slice(0, 80);
};

const looksLikeProviderControlPayload = (candidate: string): boolean => {
  const trimmed = candidate.trim();
  if (
    /^\{\s*['"]?(?:type|status|error)['"]?\s*:/i.test(trimmed) ||
    /["']type["']\s*:\s*["'](?:error|warning)["']/i.test(trimmed) ||
    /\binvalid_request_error\b/i.test(trimmed) ||
    /^HTTP\s+[45]\d\d\b/i.test(trimmed) ||
    /^(?:internal server error|bad request|too many requests)\s*(?:[:({-]|$)/i.test(trimmed) ||
    /^(?:error|warning|failed|failure)\s*(?:[:{]|\[)/i.test(trimmed)
  ) {
    return true;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    return (
      record.type === 'error' ||
      record.type === 'warning' ||
      (typeof record.status === 'number' && record.status >= 400) ||
      typeof record.error === 'string' ||
      (typeof record.error === 'object' && record.error !== null)
    );
  } catch {
    return false;
  }
};

export const sanitizeGeneratedTitle = (candidate?: string | null): string | null => {
  if (!candidate) {
    return null;
  }
  const withoutInternalInstructions = sanitizeLodyInternalInstructions(candidate);
  if (
    !withoutInternalInstructions ||
    looksLikeProviderControlPayload(withoutInternalInstructions)
  ) {
    return null;
  }
  return sanitizeTitle(withoutInternalInstructions);
};

const ensureWorkdirIsGitRepo = async (workdir: string, logger: Logger): Promise<boolean> => {
  const isGitRepo = async (): Promise<boolean> => {
    try {
      const result = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: workdir,
        encoding: 'utf8',
        timeout: TITLE_GIT_TIMEOUT_MS,
      });
      return String(result.stdout ?? '').trim() === 'true';
    } catch {
      return false;
    }
  };

  if (await isGitRepo()) {
    return true;
  }

  try {
    await execFileAsync('git', ['init', '--quiet'], {
      cwd: workdir,
      encoding: 'utf8',
      timeout: TITLE_GIT_TIMEOUT_MS,
    });
  } catch (error) {
    logger.debug(
      `[title-generator] Failed to init git repo in ${workdir}: ${formatErrorMessage(error)}`
    );
    return false;
  }

  return await isGitRepo();
};

const noopTerminalManager: TerminalManager = {
  createTerminal: async () => {
    throw new Error('Terminal not supported in isolated title agent');
  },
  terminalOutput: async () => {
    throw new Error('Terminal not supported in isolated title agent');
  },
  releaseTerminal: async () => {},
  waitForTerminalExit: async () => ({ exitCode: null }),
  killTerminal: async () => {},
};

export type GenerateTitleOptions = {
  cliType: AgentConfigCliType;
  agentType: AgentType;
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  taskPrompt: string;
  logger: Logger;
  env?: Record<string, string>;
  titleConfig?: TitleGenerationConfig;
};

export const resolveTitleConfigOptionValues = (
  cliType: AgentConfigCliType,
  agentType: AgentType,
  configOptions: AcpConfigOptionSummary[],
  configuredValues?: Record<string, AcpConfigOptionValue>
): Record<string, AcpConfigOptionValue> => {
  const automaticValues = computeTitleGenerationDefaults(cliType, agentType, configOptions);
  const resolvedValues = { ...automaticValues };
  for (const [key, value] of Object.entries(configuredValues ?? {})) {
    const automaticValue = automaticValues[key];
    const option = configOptions.find((candidate) => candidate.id === key);
    const configuredValueIsAvailable =
      option?.type === 'boolean'
        ? typeof value === 'boolean'
        : option?.type === 'select'
          ? typeof value === 'string' &&
            option.options.some((candidate) => candidate.value === value)
          : false;
    if (automaticValue === undefined || configuredValueIsAvailable) {
      resolvedValues[key] = value;
    }
  }
  return resolvedValues;
};

export async function applyResolvedTitleConfigOptions(options: {
  client: TitleConfigClient;
  acpSessionId: ACPSessionId;
  cliType: AgentConfigCliType;
  agentType: AgentType;
  sessionResponse: unknown;
  configuredValues?: Record<string, AcpConfigOptionValue>;
  logger: Logger;
}): Promise<void> {
  const sessionResponse = options.sessionResponse as {
    configOptions?: SessionConfigOption[] | null;
  };
  const initialConfigOptions = sessionResponse.configOptions ?? [];
  const modelConfigOption = initialConfigOptions.find((option) => option.category === 'model');
  const legacyModelState = readLegacySessionModelState(options.sessionResponse);
  const modelKey = modelConfigOption?.id ?? (legacyModelState ? 'model' : undefined);
  const configuredModelValue = modelKey ? options.configuredValues?.[modelKey] : undefined;
  let configOptionsForDefaults = normalizeConfigOptions(initialConfigOptions) ?? [];
  let configOptionsForApplication = initialConfigOptions;
  let modelApplied = false;

  if (
    modelConfigOption &&
    configuredModelValue !== undefined &&
    canApplyConfigOptionValue(modelConfigOption, configuredModelValue)
  ) {
    const updatedConfigOptions = await options.client.setSessionConfigOption(
      options.acpSessionId,
      modelConfigOption.id,
      configuredModelValue
    );
    modelApplied = true;
    if (updatedConfigOptions) {
      configOptionsForDefaults = normalizeConfigOptions(updatedConfigOptions) ?? [];
      configOptionsForApplication = updatedConfigOptions;
    }
  } else if (
    !modelConfigOption &&
    modelKey === 'model' &&
    typeof configuredModelValue === 'string' &&
    legacyModelState?.availableModels.some((model) => model.modelId === configuredModelValue)
  ) {
    await options.client.unstable_setSessionModel(options.acpSessionId, configuredModelValue);
    modelApplied = true;
    // The legacy model API does not return the new model's option vocabulary.
    configOptionsForDefaults = [];
  }

  const configOptionValues = resolveTitleConfigOptionValues(
    options.cliType,
    options.agentType,
    configOptionsForDefaults,
    options.configuredValues
  );
  if (modelApplied && modelKey) {
    delete configOptionValues[modelKey];
  }
  if (Object.keys(configOptionValues).length === 0) {
    return;
  }

  await applyTitleConfigOptions({
    client: options.client,
    acpSessionId: options.acpSessionId,
    sessionResponse: { configOptions: configOptionsForApplication },
    configOptionValues,
    logger: options.logger,
  });
}

export const generateTitleIsolated = async (
  options: GenerateTitleOptions
): Promise<string | null> => {
  const fallbackTitle = sanitizeGeneratedTitle(options.taskPrompt);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-title-agent-'));

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const tryGenerateWithArgs = async (extraArgs: string[]): Promise<string | null> => {
    let collectedText = '';
    const startupStartedAt = Date.now();
    options.logger.debug(
      `[title-generator] Starting isolated title ACP agent (cliType=${options.cliType} agentType=${options.agentType})`
    );
    const { agentProcess, client, acpSessionId, sessionResponse } = await startLocalAcpAgent({
      cliType: options.cliType,
      agentType: options.agentType,
      customAcp: options.customAcp,
      runtimeOverrides: options.runtimeOverrides,
      workdir,
      env: { ...process.env, ...options.env, LODY_TITLE_AGENT: '1' },
      logger: options.logger,
      terminalManager: noopTerminalManager,
      terminalEnabled: false,
      onUpdateMessage: (msg) => {
        const text = extractTitleChunkFromNotification(msg, options.agentType);
        if (text) {
          collectedText += text;
        }
      },
      onRequestPermission: async (
        _requestId: string,
        _request: RequestPermissionRequest
      ): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'cancelled' } }),
      extraArgs,
    });
    options.logger.debug(
      `[title-generator] Isolated title ACP agent ready (acpSessionId=${acpSessionId} startupDuration=${
        Date.now() - startupStartedAt
      }ms)`
    );

    try {
      const prompt = buildTitlePrompt(options.taskPrompt);

      if (client) {
        await applyResolvedTitleConfigOptions({
          client,
          acpSessionId,
          cliType: options.cliType,
          agentType: options.agentType,
          sessionResponse,
          configuredValues: options.titleConfig?.configOptionValues,
          logger: options.logger,
        });
      }

      options.logger.debug(`[title-generator] Sending title prompt (acpSessionId=${acpSessionId})`);
      const response = await client?.prompt(acpSessionId, prompt);
      options.logger.debug(
        `[title-generator] Title prompt returned (acpSessionId=${acpSessionId})`
      );

      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && collectedText.trim() === '') {
        await sleep(100);
      }

      const fromStream = sanitizeGeneratedTitle(collectedText);
      if (fromStream) {
        return fromStream;
      }

      const rawTitle = extractTextFromAgentResponse(response);
      const sanitized = sanitizeGeneratedTitle(rawTitle);
      if (sanitized) {
        return sanitized;
      }
      return fallbackTitle;
    } finally {
      await shutdownLocalAcpAgent({
        agentProcess,
        client,
        acpSessionId,
        logger: options.logger,
        sessionLabel: `title-generator:${options.cliType}/${options.agentType}`,
      });
    }
  };

  try {
    if (options.agentType === 'codex' && !(await ensureWorkdirIsGitRepo(workdir, options.logger))) {
      return fallbackTitle;
    }

    try {
      return (await tryGenerateWithArgs([])) ?? fallbackTitle;
    } catch (error) {
      options.logger.debug('Failed to generate title with args:', error);
      return fallbackTitle;
    }
  } finally {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch (error) {
      options.logger.debug(
        `[title-generator] Failed to remove temporary workdir ${workdir}: ${formatErrorMessage(error)}`
      );
    }
  }
};
