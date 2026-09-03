import {
  ACP_CONFIG_OPTION_OFF_VALUE,
  ACP_CONFIG_OPTION_ON_VALUE,
  isAcpFastModeConfigId,
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

/** A boolean toggle and an `on`/`off` select express the same choice. */
function configValuesMatch(
  requested: AcpConfigOptionValue,
  effective: AcpConfigOptionValue | undefined
): boolean {
  if (requested === effective) {
    return true;
  }
  const toggle = (value: boolean): string =>
    value ? ACP_CONFIG_OPTION_ON_VALUE : ACP_CONFIG_OPTION_OFF_VALUE;
  if (typeof requested === 'boolean' && typeof effective === 'string') {
    return effective === toggle(requested);
  }
  if (typeof requested === 'string' && typeof effective === 'boolean') {
    return requested === toggle(effective);
  }
  return false;
}

/** One requested selection, judged against the agent's own answer for it. */
type AppliedSelection = {
  /** Diagnostic label, already redacted for sensitive ids. */
  label: string;
  requested: AcpConfigOptionValue;
  /** How to read the agent's state for this selection once everything is applied. */
  source: { kind: 'mode' } | { kind: 'model' } | { kind: 'configOption'; configId: string };
  /** The agent threw while applying it. */
  rejected: boolean;
};

/**
 * Whether the agent's post-apply state contradicts what the turn asked for.
 *
 * A rejection alone does not answer this, in either direction. Codex ACCEPTS
 * `fast-mode` on a model without a fast speed tier and then simply omits the
 * option from the state it publishes — the turn runs at normal speed and
 * nothing threw — so the published state is the only evidence Fast is not on.
 * Conversely a rejected selection that is already effective changed nothing and
 * is not worth a notice. Only where the agent published nothing to compare
 * against does the failed call remain the sole signal.
 */
function divergesFromAgentState(args: {
  requested: AcpConfigOptionValue;
  effective: AcpConfigOptionValue | undefined;
  known: boolean;
  rejected: boolean;
}): boolean {
  return args.known ? !configValuesMatch(args.requested, args.effective) : args.rejected;
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
  const appliedSelections: AppliedSelection[] = [];
  let confirmedLegacyModeId: string | undefined;
  let confirmedLegacyModelId: string | undefined;
  const agentConfigOptions = agentClient.getConfigOptions?.() ?? [];
  const modeConfigId =
    agentConfigOptions.find((option) => option.category === 'mode')?.id ?? 'mode';
  const modelConfigId =
    agentConfigOptions.find((option) => option.category === 'model')?.id ?? 'model';
  const configOptionModelId = configOptionValues?.[modelConfigId];
  const targetModelId =
    config.modelId ?? (typeof configOptionModelId === 'string' ? configOptionModelId : undefined);

  if (config.modeId) {
    const label = `mode=${JSON.stringify(config.modeId)}`;
    let rejected = false;
    try {
      await agentClient.setSessionMode?.(acpSessionId, config.modeId);
      confirmedLegacyModeId = config.modeId;
    } catch (error) {
      rejected = true;
      rejectedSelections.push(label);
      logger.debug(
        `[${sessionId}] Failed to set ACP mode ${JSON.stringify(config.modeId)}: ${String(error)}`
      );
    }
    appliedSelections.push({
      label,
      requested: config.modeId,
      source: { kind: 'mode' },
      rejected,
    });
  }
  if (config.modelId) {
    const label = `model=${JSON.stringify(config.modelId)}`;
    let rejected = false;
    try {
      await agentClient.unstable_setSessionModel?.(acpSessionId, config.modelId);
      confirmedLegacyModelId = config.modelId;
    } catch (error) {
      rejected = true;
      rejectedSelections.push(label);
      logger.debug(
        `[${sessionId}] Failed to set ACP model ${JSON.stringify(config.modelId)}: ${String(error)}`
      );
    }
    appliedSelections.push({
      label,
      requested: config.modelId,
      source: { kind: 'model' },
      rejected,
    });
  }

  for (const [configId, value] of configOptionEntries) {
    if (configId === modeConfigId) {
      // An explicit `config.modeId` outranks this duplicate, and is judged in
      // its place: losing a precedence contest is not the agent disagreeing.
      if (!config.modeId && typeof value === 'string') {
        let rejected = false;
        try {
          await agentClient.setSessionMode?.(acpSessionId, value);
          confirmedLegacyModeId = value;
        } catch (error) {
          rejected = true;
          logger.debug(
            `[${sessionId}] Failed to set ACP mode option ${configId}=${formatAcpConfigValueForLog(
              configId,
              value
            )}: ${String(error)}`
          );
        }
        appliedSelections.push({
          label: `${configId}=${formatAcpConfigValueForLog(configId, value)}`,
          requested: value,
          source: { kind: 'mode' },
          rejected,
        });
      }
      continue;
    }
    if (configId === modelConfigId) {
      if (!config.modelId && typeof value === 'string') {
        let rejected = false;
        try {
          await agentClient.unstable_setSessionModel?.(acpSessionId, value);
          confirmedLegacyModelId = value;
        } catch (error) {
          rejected = true;
          logger.debug(
            `[${sessionId}] Failed to set ACP model option ${configId}=${formatAcpConfigValueForLog(
              configId,
              value
            )}: ${String(error)}`
          );
        }
        appliedSelections.push({
          label: `${configId}=${formatAcpConfigValueForLog(configId, value)}`,
          requested: value,
          source: { kind: 'model' },
          rejected,
        });
      }
      continue;
    }
    if (shouldSkipFableFastModeDisable({ modelId: targetModelId, configId, value })) {
      continue;
    }
    const label = `${configId}=${formatAcpConfigValueForLog(configId, value)}`;
    let rejected = false;
    try {
      await agentClient.setSessionConfigOption(acpSessionId, configId, value);
    } catch (error) {
      rejected = true;
      rejectedSelections.push(label);
      logger.debug(`[${sessionId}] Failed to set ACP config option ${configId}: ${String(error)}`);
    }
    appliedSelections.push({
      label,
      requested: value,
      source: { kind: 'configOption', configId },
      rejected,
    });
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

  // An agent that publishes no config options at all answered nothing here, and
  // the effective table deliberately omits sensitive ids, so neither can be read
  // as "the agent dropped it".
  const publishesConfigOptions = agentConfigOptions.length > 0;
  const effectiveConfigOptionValues = runtimeConfigPatch.configOptionValues ?? {};
  const warningSelections = appliedSelections
    .filter((selection) => {
      const effective =
        selection.source.kind === 'mode'
          ? runtimeConfigPatch.modeId
          : selection.source.kind === 'model'
            ? runtimeConfigPatch.modelId
            : effectiveConfigOptionValues[selection.source.configId];
      const known =
        selection.source.kind === 'configOption'
          ? publishesConfigOptions && !isSensitiveAcpConfigOptionId(selection.source.configId)
          : effective !== undefined;
      return divergesFromAgentState({
        requested: selection.requested,
        effective,
        known,
        rejected: selection.rejected,
      });
    })
    .map((selection) => selection.label);

  return {
    rejectedSelections,
    warningSelections,
    runtimeConfigPatch,
  };
}
