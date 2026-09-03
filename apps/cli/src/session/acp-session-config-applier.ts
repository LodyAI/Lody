import {
  ACP_CONFIG_OPTION_OFF_VALUE,
  ACP_CONFIG_OPTION_ON_VALUE,
  isAcpFastModeConfigId,
  isAcpPermissionWiderThanRequested,
  isAcpPlanModeConfigOption,
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
  /** One-time informed acceptance carried by this turn. */
  acceptWiderPermission?: boolean;
};

type AcpSessionRunConfigApplyResult = {
  /** Every selection rejected by the agent, retained for diagnostics. */
  rejectedSelections: string[];
  /** Rejections that should become a user-visible Agent warning. */
  warningSelections: string[];
  /** Agent-confirmed state after applying the requested selections. */
  runtimeConfigPatch: SessionAcpRuntimeConfigPatch | null;
  /**
   * The agent's own reported state says this turn would run with MORE
   * permission than it asked for. Present only on that contradiction — never
   * from a snapshot, never when either mode is unranked, never when the agent
   * reported nothing to compare.
   */
  permissionEscalation?: { requestedModeId: string; effectiveModeId: string };
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

  const applyMode = async (value: string, label: string): Promise<void> => {
    let rejected = false;
    try {
      await agentClient.setSessionMode?.(acpSessionId, value);
      confirmedLegacyModeId = value;
    } catch (error) {
      rejected = true;
      rejectedSelections.push(label);
      logger.debug(`[${sessionId}] Failed to set ACP mode ${label}: ${String(error)}`);
    }
    appliedSelections.push({ label, requested: value, source: { kind: 'mode' }, rejected });
  };

  const applyModel = async (value: string, label: string): Promise<void> => {
    let rejected = false;
    try {
      await agentClient.unstable_setSessionModel?.(acpSessionId, value);
      confirmedLegacyModelId = value;
    } catch (error) {
      rejected = true;
      rejectedSelections.push(label);
      logger.debug(`[${sessionId}] Failed to set ACP model ${label}: ${String(error)}`);
    }
    appliedSelections.push({ label, requested: value, source: { kind: 'model' }, rejected });
  };

  const applyConfigOption = async (
    configId: string,
    value: AcpConfigOptionValue
  ): Promise<void> => {
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
  };

  /**
   * Permission-bearing controls go LAST, and that ordering is load-bearing.
   *
   * Claude rebuilds the available permission modes on every model switch and
   * downgrades the current one to `default` when the new model does not support
   * it — so a mode applied before the model is silently widened by the model
   * that follows it. Applying the model and the ordinary options first, then the
   * permission-bearing ones, means the last word belongs to what the user asked
   * for. `applyPromptConfig` runs before `prompt`, so the state read below is
   * still taken before the agent can act on it.
   */
  const isPermissionBearing = (configId: string): boolean =>
    configId === modeConfigId || isAcpPlanModeConfigOption({ id: configId });
  const configOptionEntryFor = (configId: string): AcpConfigOptionValue | undefined =>
    configOptionEntries.find(([id]) => id === configId)?.[1];

  const duplicateModelValue = configOptionEntryFor(modelConfigId);
  if (config.modelId) {
    await applyModel(config.modelId, `model=${JSON.stringify(config.modelId)}`);
  } else if (typeof duplicateModelValue === 'string') {
    await applyModel(
      duplicateModelValue,
      `${modelConfigId}=${formatAcpConfigValueForLog(modelConfigId, duplicateModelValue)}`
    );
  }

  for (const [configId, value] of configOptionEntries) {
    if (configId === modeConfigId || configId === modelConfigId || isPermissionBearing(configId)) {
      continue;
    }
    if (shouldSkipFableFastModeDisable({ modelId: targetModelId, configId, value })) {
      continue;
    }
    await applyConfigOption(configId, value);
  }

  for (const [configId, value] of configOptionEntries) {
    if (configId === modeConfigId || !isPermissionBearing(configId)) {
      continue;
    }
    await applyConfigOption(configId, value);
  }

  // An explicit `config.modeId` outranks the duplicate config-option entry, and
  // is judged in its place: losing a precedence contest is not the agent
  // disagreeing.
  const duplicateModeValue = configOptionEntryFor(modeConfigId);
  if (config.modeId) {
    await applyMode(config.modeId, `mode=${JSON.stringify(config.modeId)}`);
  } else if (typeof duplicateModeValue === 'string') {
    await applyMode(
      duplicateModeValue,
      `${modeConfigId}=${formatAcpConfigValueForLog(modeConfigId, duplicateModeValue)}`
    );
  }

  logger.debug(`[${sessionId}] applyAcpSessionRunConfig completed`);
  const runtimeConfigPatch = getAcpRuntimeConfigPatchFromOptions(
    acpSessionId,
    agentClient.getConfigOptions()
  );
  // A `session/set_mode` that did not throw is an acknowledgement, not proof of
  // the resulting state: the agent may change the mode again while applying the
  // rest of the turn (Claude downgrades it on an unsupported model switch). So
  // it only FILLS a mode the agent's own state does not report — never
  // overwrites one, which would report the request back as if it were the
  // outcome and leave every mode divergence invisible.
  if (confirmedLegacyModeId && runtimeConfigPatch.modeId === undefined) {
    runtimeConfigPatch.modeId = confirmedLegacyModeId;
    if (
      !isSensitiveAcpConfigOptionId(modeConfigId) &&
      agentConfigOptions.some((option) => option.id === modeConfigId) &&
      runtimeConfigPatch.configOptionValues?.[modeConfigId] === undefined
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

  /* The permission the turn asked for, against the one the agent reports after
     everything has been applied. `runtimeConfigPatch.modeId` is the agent's own
     state — it is only filled from a `set_mode` acknowledgement when the agent
     reports no mode of its own, in which case the two are equal and nothing
     fires here. So this cannot be triggered by a snapshot, by a stale cache, or
     by an unconfirmed request. */
  const requestedModeId =
    config.modeId ??
    (typeof configOptionEntryFor(modeConfigId) === 'string'
      ? (configOptionEntryFor(modeConfigId) as string)
      : undefined);
  const permissionEscalation =
    requestedModeId !== undefined &&
    !config.acceptWiderPermission &&
    isAcpPermissionWiderThanRequested(requestedModeId, runtimeConfigPatch.modeId)
      ? { requestedModeId, effectiveModeId: runtimeConfigPatch.modeId as string }
      : undefined;
  if (permissionEscalation) {
    logger.debug(
      `[${sessionId}] Permission not applied: requested ${permissionEscalation.requestedModeId}, effective ${permissionEscalation.effectiveModeId}`
    );
  }

  return {
    rejectedSelections,
    warningSelections,
    runtimeConfigPatch,
    ...(permissionEscalation ? { permissionEscalation } : {}),
  };
}

/**
 * The agent's own state reports a wider permission than the turn requested.
 *
 * Thrown before `prompt`, so the turn never runs. Carries both mode ids so the
 * failure notice can name them and offer the one-time informed downgrade.
 */
export class AcpPermissionNotAppliedError extends Error {
  constructor(
    readonly requestedModeId: string,
    readonly effectiveModeId: string
  ) {
    super(
      `The agent did not apply the requested permission mode "${requestedModeId}" and would run with "${effectiveModeId}", which allows more than was asked for.`
    );
    this.name = 'AcpPermissionNotAppliedError';
  }
}
