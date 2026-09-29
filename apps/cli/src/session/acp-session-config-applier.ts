import {
  ACP_REASONING_EFFORT_CONFIG_ID,
  ACP_COLLABORATION_MODE_PLAN_VALUE,
  comparePermissionModes,
  isRestrictivePermissionMode,
  isAcpFastModeConfigId,
  isAcpPlanModeConfigOption,
  isAcpThoughtLevelConfigOption,
  isSensitiveAcpConfigOptionId,
  type ACPSessionId,
  type AcpConfigOptionValue,
  type AgentConfigCliType,
  type SessionId,
  type SessionAcpRuntimeConfigPatch,
  type SessionSafetyIntent,
} from '@lody/shared';
import type { AcpModeSetEvidence, AgentClient } from '@/agent/agent-client';
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
  /**
   * Permission mode and Plan in force from earlier turns
   * (`resolveSessionSafetyIntent`), used when this turn's config omits them.
   */
  inheritedSafetyIntent?: SessionSafetyIntent;
};

/**
 * The agent could not be shown to run this turn with the permission mode or
 * Plan setting it was asked for, and running anyway could act with more
 * permission than the user chose. The turn stops before the prompt.
 */
export class AcpRunConfigSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpRunConfigSafetyError';
  }
}

const isPlanOn = (value: AcpConfigOptionValue): boolean =>
  value === true || value === ACP_COLLABORATION_MODE_PLAN_VALUE;

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
  signal?: AbortSignal;
}): Promise<AcpSessionRunConfigApplyResult> {
  const { session, config, logger, signal } = args;
  const assertNotAborted = (): void => {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('ACP run configuration was aborted');
  };
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
  const agentConfigOptions = agentClient.getConfigOptions?.() ?? [];
  const suppressKnownRunConfigWarnings = isCodexOrClaudeRunConfig(config);
  const recordRejection = (selection: string, suppressWarning: boolean): void => {
    rejectedSelections.push(selection);
    if (!suppressWarning) {
      warningSelections.push(selection);
    }
  };
  const agent = { cliType: config.cliType, agentType: config.agentType };
  const modeConfigId =
    agentConfigOptions.find((option) => option.category === 'mode')?.id ?? 'mode';
  const modelConfigId =
    agentConfigOptions.find((option) => option.category === 'model')?.id ?? 'model';
  const permissionConfigIds = new Set(
    agentConfigOptions.filter((option) => option.category === '_permission').map((o) => o.id)
  );
  const configOptionModelId = configOptionValues?.[modelConfigId];
  const requestedModelId =
    config.modelId ?? (typeof configOptionModelId === 'string' ? configOptionModelId : undefined);
  const targetModelId = requestedModelId;

  // 1. Model first. Switching it can rebuild the agent's other options,
  // including its permission modes, so everything else is set against the
  // target model and permission is set last.
  let confirmedLegacyModelId: string | undefined;
  let modelSwitched = false;
  if (requestedModelId) {
    assertNotAborted();
    try {
      await agentClient.unstable_setSessionModel?.(acpSessionId, requestedModelId);
      confirmedLegacyModelId = requestedModelId;
      modelSwitched = true;
    } catch (error) {
      assertNotAborted();
      recordRejection(`model=${JSON.stringify(requestedModelId)}`, suppressKnownRunConfigWarnings);
      logger.debug(
        `[${sessionId}] Failed to set ACP model ${JSON.stringify(requestedModelId)}: ${String(error)}`
      );
    }
    assertNotAborted();
  }

  // 2. Ordinary options (effort, fast, ...).
  const planEntries: Array<[string, AcpConfigOptionValue]> = [];
  const permissionEntries: Array<[string, AcpConfigOptionValue]> = [];
  for (const [configId, value] of configOptionEntries) {
    assertNotAborted();
    if (configId === modelConfigId || configId === modeConfigId) continue;
    if (isAcpPlanModeConfigOption({ id: configId })) {
      planEntries.push([configId, value]);
      continue;
    }
    if (permissionConfigIds.has(configId)) {
      permissionEntries.push([configId, value]);
      continue;
    }
    if (shouldSkipFableFastModeDisable({ modelId: targetModelId, configId, value })) {
      continue;
    }
    try {
      await agentClient.setSessionConfigOption(acpSessionId, configId, value);
    } catch (error) {
      assertNotAborted();
      recordRejection(
        `${configId}=${formatAcpConfigValueForLog(configId, value)}`,
        suppressKnownRunConfigWarnings && isKnownRunConfigOption(configId, agentConfigOptions)
      );
      logger.debug(`[${sessionId}] Failed to set ACP config option ${configId}: ${String(error)}`);
    }
    assertNotAborted();
  }

  // 3. Safety settings last: Plan, then permission. A turn that omits them
  // runs under the ones inherited from earlier turns.
  const inherited = config.inheritedSafetyIntent;
  const explicitModeOption = configOptionValues?.[modeConfigId];
  const explicitModeId =
    config.modeId ?? (typeof explicitModeOption === 'string' ? explicitModeOption : undefined);
  const reportedModeId = (): string | undefined => {
    const option = agentClient.getConfigOptions?.().find((o) => o.category === 'mode');
    return typeof option?.currentValue === 'string'
      ? option.currentValue
      : agentClient.getLastReportedModeId?.();
  };
  const reportedValue = (configId: string): AcpConfigOptionValue | undefined =>
    agentClient.getConfigOptions?.().find((option) => option.id === configId)?.currentValue;
  // An inherited setting is sent again only when this turn switched model (the
  // switch may have rebuilt it) or the agent does not already report it.
  const resendInheritedMode =
    !explicitModeId &&
    inherited?.modeId !== undefined &&
    (modelSwitched || reportedModeId() !== inherited.modeId);
  const inheritedPlan =
    planEntries.length === 0 && inherited?.plan !== undefined ? inherited.plan : undefined;
  if (
    inheritedPlan &&
    (modelSwitched || reportedValue(inheritedPlan.configId) !== inheritedPlan.value)
  ) {
    planEntries.push([inheritedPlan.configId, inheritedPlan.value]);
  }

  type SafetyCheck = {
    label: string;
    requested: AcpConfigOptionValue;
    restrictive: boolean;
    /** Result confirmed by this setting's own response, or undefined. */
    confirmed: AcpConfigOptionValue | undefined;
    /** Generation after the setting; later reports can only contradict it. */
    generation: number;
    failed: boolean;
    readLater: () => AcpConfigOptionValue | undefined;
    compare: (requested: AcpConfigOptionValue, actual: AcpConfigOptionValue) => string;
  };
  const checks: SafetyCheck[] = [];
  const generation = (): number => agentClient.getAgentStateReportGeneration?.() ?? 0;

  for (const [configId, value] of planEntries) {
    assertNotAborted();
    let confirmed: AcpConfigOptionValue | undefined;
    let failed = false;
    try {
      const reported = await agentClient.setSessionConfigOption(acpSessionId, configId, value);
      confirmed = reported?.find((option) => option.id === configId)?.currentValue;
    } catch (error) {
      assertNotAborted();
      failed = true;
      logger.debug(`[${sessionId}] Failed to set ACP Plan option ${configId}: ${String(error)}`);
    }
    checks.push({
      label: configId,
      requested: value,
      restrictive: isPlanOn(value),
      confirmed,
      generation: generation(),
      failed,
      readLater: () => reportedValue(configId),
      compare: (requested, actual) =>
        requested === actual ? 'same' : isPlanOn(requested) ? 'wider' : 'narrower',
    });
    assertNotAborted();
  }

  for (const [configId, value] of permissionEntries) {
    assertNotAborted();
    try {
      await agentClient.setSessionConfigOption(acpSessionId, configId, value);
    } catch (error) {
      assertNotAborted();
      recordRejection(`${configId}=${formatAcpConfigValueForLog(configId, value)}`, false);
      logger.debug(
        `[${sessionId}] Failed to set ACP permission option ${configId}: ${String(error)}`
      );
    }
    assertNotAborted();
  }

  const modeToSet = explicitModeId ?? (resendInheritedMode ? inherited?.modeId : undefined);
  let modeEvidence: AcpModeSetEvidence | undefined;
  if (modeToSet) {
    assertNotAborted();
    let failed = false;
    try {
      modeEvidence = (await agentClient.setSessionMode?.(acpSessionId, modeToSet)) ?? {
        kind: 'none',
      };
    } catch (error) {
      assertNotAborted();
      failed = true;
      logger.debug(
        `[${sessionId}] Failed to set ACP mode ${JSON.stringify(modeToSet)}: ${String(error)}`
      );
    }
    checks.push({
      label: 'mode',
      requested: modeToSet,
      restrictive: isRestrictivePermissionMode(agent, modeToSet),
      confirmed:
        modeEvidence?.kind === 'config-response'
          ? modeEvidence.modeId
          : modeEvidence?.kind === 'set-mode-ack'
            ? modeToSet
            : undefined,
      generation: generation(),
      failed,
      readLater: reportedModeId,
      compare: (requested, actual) =>
        typeof requested === 'string' && typeof actual === 'string'
          ? comparePermissionModes(agent, requested, actual)
          : 'incomparable',
    });
    assertNotAborted();
  } else if (inherited?.modeId !== undefined && !explicitModeId) {
    // Not re-sent because the agent already reports the inherited mode.
    const current = reportedModeId();
    checks.push({
      label: 'mode',
      requested: inherited.modeId,
      restrictive: isRestrictivePermissionMode(agent, inherited.modeId),
      confirmed: current,
      generation: generation(),
      failed: false,
      readLater: reportedModeId,
      compare: (requested, actual) =>
        typeof requested === 'string' && typeof actual === 'string'
          ? comparePermissionModes(agent, requested, actual)
          : 'incomparable',
    });
  }

  // 4. Before the prompt, judge each safety setting by what the agent itself
  // reported for it. A report after the setting may contradict it but never
  // stands in for a missing confirmation: asynchronous notifications carry no
  // request id.
  const failures: string[] = [];
  for (const check of checks) {
    const later = generation() > check.generation ? check.readLater() : undefined;
    const actual = later !== undefined ? later : check.confirmed;
    const describe = `${check.label} requested ${String(check.requested)}, agent reports ${
      actual === undefined ? 'no confirmed state' : String(actual)
    }${targetModelId ? ` on model ${targetModelId}` : ''}`;
    if (check.failed || actual === undefined) {
      if (check.restrictive) failures.push(describe);
      else recordRejection(describe, false);
      continue;
    }
    const comparison = check.compare(check.requested, actual);
    if (comparison === 'same' || comparison === 'narrower') continue;
    if (comparison === 'wider' || check.restrictive) {
      failures.push(describe);
    } else {
      recordRejection(describe, false);
    }
  }
  if (failures.length > 0) {
    throw new AcpRunConfigSafetyError(
      `The agent did not confirm the requested permission settings, so this turn was not sent: ${failures.join(
        '; '
      )}. Change the permission or Plan setting and send again.`
    );
  }

  assertNotAborted();
  logger.debug(`[${sessionId}] applyAcpSessionRunConfig completed`);
  const runtimeConfigPatch = getAcpRuntimeConfigPatchFromOptions(
    acpSessionId,
    agentClient.getConfigOptions()
  );
  // A successful `session/set_mode` acknowledgement fills the mode only when
  // the agent reports no mode state at all; it never overwrites a reported one.
  if (
    modeToSet &&
    modeEvidence?.kind === 'set-mode-ack' &&
    runtimeConfigPatch.modeId === undefined
  ) {
    runtimeConfigPatch.modeId = reportedModeId() ?? modeToSet;
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
