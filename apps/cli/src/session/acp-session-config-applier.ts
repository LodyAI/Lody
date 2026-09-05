import {
  ACP_PLAN_PERMISSION_MODE_ID,
  ACP_REASONING_EFFORT_CONFIG_ID,
  isAcpFastModeConfigId,
  isAcpPlanModeConfigOption,
  isAcpThoughtLevelConfigOption,
  isSensitiveAcpConfigOptionId,
  type ACPSessionId,
  type AcpConfigOptionValue,
  type AgentConfigCliType,
  type SessionId,
  type SessionAcpRuntimeConfigPatch,
} from '@lody/shared';
import type { AgentClient } from '@/agent/agent-client';
import { getAcpRuntimeConfigPatchFromOptions } from '@/lib/acp/runtime-config';
import type { Logger } from '@/utils/logger';

const MAX_ACP_CONFIG_VALUE_LOG_LENGTH = 160;

function formatAcpConfigValueForLog(configId: string, value: AcpConfigOptionValue): string {
  if (isSensitiveAcpConfigOptionId(configId)) {
    return '<redacted>';
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, ' ').trim();
    const truncated =
      normalized.length > MAX_ACP_CONFIG_VALUE_LOG_LENGTH
        ? `${normalized.slice(0, MAX_ACP_CONFIG_VALUE_LOG_LENGTH)}...`
        : normalized;
    return JSON.stringify(truncated);
  }
  return String(value);
}

function shouldSkipFableFastModeDisable(args: {
  modelId: string | undefined;
  configId: string;
  value: AcpConfigOptionValue;
}): boolean {
  return (
    args.modelId?.toLowerCase().includes('fable') === true &&
    isAcpFastModeConfigId(args.configId) &&
    args.value === false
  );
}

export type AcpSessionConfigTarget = {
  sessionId: SessionId;
  acpSessionId: ACPSessionId | null;
  agentClient: AgentClient | null;
};

export type AcpSessionRunConfig = {
  cliType?: AgentConfigCliType;
  agentType?: string;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

type AcpSessionRunConfigApplyResult = {
  /** Every selection rejected by the agent, retained for diagnostics. */
  rejectedSelections: string[];
  /** Rejections that should become a user-visible Agent warning. */
  warningSelections: string[];
  /** Agent-confirmed state after applying the requested selections. */
  runtimeConfigPatch: SessionAcpRuntimeConfigPatch | null;
};

function isCodexOrClaudeRunConfig(config: AcpSessionRunConfig): boolean {
  return config.agentType === 'codex' || config.agentType === 'claude';
}

function isKnownRunConfigOption(
  configId: string,
  agentConfigOptions: ReadonlyArray<{ id: string; category?: string | null }>
): boolean {
  if (
    configId === ACP_REASONING_EFFORT_CONFIG_ID ||
    isAcpFastModeConfigId(configId) ||
    isAcpPlanModeConfigOption({ id: configId })
  ) {
    return true;
  }
  const option = agentConfigOptions.find((candidate) => candidate.id === configId);
  return option
    ? isAcpThoughtLevelConfigOption({ id: option.id, category: option.category ?? undefined })
    : false;
}

export async function applyAcpSessionRunConfig(args: {
  session: AcpSessionConfigTarget;
  config: AcpSessionRunConfig;
  logger: Logger;
}): Promise<AcpSessionRunConfigApplyResult> {
  const { session, config, logger } = args;
  const { sessionId, acpSessionId, agentClient } = session;
  const configOptionValues = config.configOptionValues;
  const configOptionEntries = configOptionValues ? Object.entries(configOptionValues) : [];
  const configOptionSummary =
    configOptionEntries.length > 0
      ? configOptionEntries
          .map(([configId, value]) => `${configId}=${formatAcpConfigValueForLog(configId, value)}`)
          .join(',')
      : 'none';
  logger.debug(
    `[${sessionId}] applyAcpSessionRunConfig called (cliType=${config.cliType ?? 'unknown'} agentType=${
      config.agentType ?? 'unknown'
    } modeId=${config.modeId ?? 'none'} modelId=${
      config.modelId ?? 'none'
    } configOptions=${configOptionEntries.length} configOptionValues=${configOptionSummary})`
  );
  if (!agentClient?.isCreated() || !acpSessionId) {
    logger.debug(`[${sessionId}] applyAcpSessionRunConfig skipped (agentClient not ready)`);
    return { rejectedSelections: [], warningSelections: [], runtimeConfigPatch: null };
  }

  const rejectedSelections: string[] = [];
  const warningSelections: string[] = [];
  let confirmedLegacyModeId: string | undefined;
  let confirmedLegacyModelId: string | undefined;
  const agentConfigOptions = agentClient.getConfigOptions?.() ?? [];
  const suppressKnownRunConfigWarnings = isCodexOrClaudeRunConfig(config);
  const recordRejection = (selection: string, suppressWarning: boolean): void => {
    rejectedSelections.push(selection);
    if (!suppressWarning) {
      warningSelections.push(selection);
    }
  };
  const modeConfigId =
    agentConfigOptions.find((option) => option.category === 'mode')?.id ?? 'mode';
  const modelConfigId =
    agentConfigOptions.find((option) => option.category === 'model')?.id ?? 'model';
  const configOptionModelId = configOptionValues?.[modelConfigId];
  const targetModelId =
    config.modelId ?? (typeof configOptionModelId === 'string' ? configOptionModelId : undefined);

  if (config.modeId) {
    try {
      await agentClient.setSessionMode?.(acpSessionId, config.modeId);
      confirmedLegacyModeId = config.modeId;
    } catch (error) {
      recordRejection(
        `mode=${JSON.stringify(config.modeId)}`,
        suppressKnownRunConfigWarnings && config.modeId === ACP_PLAN_PERMISSION_MODE_ID
      );
      logger.debug(
        `[${sessionId}] Failed to set ACP mode ${JSON.stringify(config.modeId)}: ${String(error)}`
      );
    }
  }
  if (config.modelId) {
    try {
      await agentClient.unstable_setSessionModel?.(acpSessionId, config.modelId);
      confirmedLegacyModelId = config.modelId;
    } catch (error) {
      recordRejection(`model=${JSON.stringify(config.modelId)}`, suppressKnownRunConfigWarnings);
      logger.debug(
        `[${sessionId}] Failed to set ACP model ${JSON.stringify(config.modelId)}: ${String(error)}`
      );
    }
  } else if (typeof configOptionModelId === 'string') {
    // The agent validates per-model options against the current model, so the model switch goes first.
    try {
      await agentClient.unstable_setSessionModel?.(acpSessionId, configOptionModelId);
      confirmedLegacyModelId = configOptionModelId;
    } catch (error) {
      logger.debug(
        `[${sessionId}] Failed to set ACP model option ${modelConfigId}=${formatAcpConfigValueForLog(
          modelConfigId,
          configOptionModelId
        )}: ${String(error)}`
      );
    }
  }

  for (const [configId, value] of configOptionEntries) {
    if (configId === modeConfigId) {
      if (!config.modeId && typeof value === 'string') {
        try {
          await agentClient.setSessionMode?.(acpSessionId, value);
          confirmedLegacyModeId = value;
        } catch (error) {
          logger.debug(
            `[${sessionId}] Failed to set ACP mode option ${configId}=${formatAcpConfigValueForLog(
              configId,
              value
            )}: ${String(error)}`
          );
        }
      }
      continue;
    }
    if (configId === modelConfigId) {
      continue;
    }
    if (shouldSkipFableFastModeDisable({ modelId: targetModelId, configId, value })) {
      continue;
    }
    try {
      await agentClient.setSessionConfigOption(acpSessionId, configId, value);
    } catch (error) {
      recordRejection(
        `${configId}=${formatAcpConfigValueForLog(configId, value)}`,
        suppressKnownRunConfigWarnings && isKnownRunConfigOption(configId, agentConfigOptions)
      );
      logger.debug(`[${sessionId}] Failed to set ACP config option ${configId}: ${String(error)}`);
    }
  }

  logger.debug(`[${sessionId}] applyAcpSessionRunConfig completed`);
  const runtimeConfigPatch = getAcpRuntimeConfigPatchFromOptions(
    acpSessionId,
    agentClient.getConfigOptions()
  );
  if (confirmedLegacyModeId) {
    runtimeConfigPatch.modeId = confirmedLegacyModeId;
    if (
      !isSensitiveAcpConfigOptionId(modeConfigId) &&
      agentConfigOptions.some((option) => option.id === modeConfigId)
    ) {
      runtimeConfigPatch.configOptionValues = {
        ...runtimeConfigPatch.configOptionValues,
        [modeConfigId]: confirmedLegacyModeId,
      };
    }
  }
  if (confirmedLegacyModelId && !runtimeConfigPatch.modelId) {
    runtimeConfigPatch.modelId = confirmedLegacyModelId;
  }
  return {
    rejectedSelections,
    warningSelections,
    runtimeConfigPatch,
  };
}
