import type { AcpConfigOptionValue, AgentConfigCliType } from './ai';
import type { McpServerId } from './ids';
import { normalizeProjectRefForDedup } from './project';
import { normalizeMcpServerIdsForDedup } from './workspace-mcp';

const SENSITIVE_ACP_CONFIG_ID_PATTERN =
  /(?:api[_-]?key|auth|bearer|credential|password|passwd|secret|token)/i;

export type SessionPreparationRunConfig = {
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  mcpServerIds?: McpServerId[];
  taskToolsEnabled?: boolean;
  scheduleToolsEnabled?: boolean;
};

export type SessionPreparationClaimIdentity = {
  requestedByUserId: string;
  agentConfigId: string;
  cliType: AgentConfigCliType;
  agentType: string;
  project?: NonNullable<Parameters<typeof normalizeProjectRefForDedup>[0]>;
};

export type SessionPreparationRequestIdentity = SessionPreparationClaimIdentity & {
  runConfig?: SessionPreparationRunConfig;
};

export function isSensitiveAcpConfigOptionId(configId: string): boolean {
  return SENSITIVE_ACP_CONFIG_ID_PATTERN.test(configId);
}

function trimOptionalId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * Preparation requests are retained transport data, so they may carry only
 * non-sensitive selector values. Durable dispatch remains authoritative for
 * every option, including values intentionally omitted here.
 */
export function buildSessionPreparationRunConfig(input: {
  modeId?: string | null;
  modelId?: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue> | null;
  mcpServerIds?: readonly McpServerId[] | null;
  taskToolsEnabled?: boolean;
  scheduleToolsEnabled?: boolean;
}): SessionPreparationRunConfig | undefined {
  const modeId = trimOptionalId(input.modeId);
  const modelId = trimOptionalId(input.modelId);
  const configOptionValues = input.configOptionValues
    ? Object.fromEntries(
        Object.entries(input.configOptionValues).filter(
          ([configId]) => !isSensitiveAcpConfigOptionId(configId)
        )
      )
    : undefined;
  const nonEmptyConfigOptionValues =
    configOptionValues && Object.keys(configOptionValues).length > 0
      ? configOptionValues
      : undefined;
  const mcpServerIds = input.mcpServerIds ? [...input.mcpServerIds] : undefined;
  const taskToolsEnabled = input.taskToolsEnabled === true ? true : undefined;
  const scheduleToolsEnabled = input.scheduleToolsEnabled === true ? true : undefined;

  if (
    !modeId &&
    !modelId &&
    !nonEmptyConfigOptionValues &&
    !mcpServerIds &&
    !taskToolsEnabled &&
    !scheduleToolsEnabled
  ) {
    return undefined;
  }
  return {
    ...(modeId ? { modeId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(nonEmptyConfigOptionValues ? { configOptionValues: nonEmptyConfigOptionValues } : {}),
    ...(mcpServerIds ? { mcpServerIds } : {}),
    ...(taskToolsEnabled ? { taskToolsEnabled } : {}),
    ...(scheduleToolsEnabled ? { scheduleToolsEnabled } : {}),
  };
}

export function normalizeSessionPreparationRunConfigForDedup(
  config: SessionPreparationRunConfig | null | undefined
): unknown {
  if (!config) return null;
  return [
    config.modeId ?? null,
    config.modelId ?? null,
    config.configOptionValues
      ? Object.entries(config.configOptionValues).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      : null,
    ...(config.mcpServerIds === undefined
      ? []
      : [normalizeMcpServerIdsForDedup(config.mcpServerIds)]),
    ...(config.taskToolsEnabled === true ? [true] : []),
    ...(config.scheduleToolsEnabled === true ? [{ schedules: true }] : []),
  ];
}

function normalizeSessionPreparationClaimIdentity(input: SessionPreparationClaimIdentity): unknown {
  return [
    input.requestedByUserId,
    input.agentConfigId,
    input.cliType,
    input.agentType,
    normalizeProjectRefForDedup(input.project),
  ];
}

export function buildSessionPreparationClaimKey(input: SessionPreparationClaimIdentity): string {
  return JSON.stringify(normalizeSessionPreparationClaimIdentity(input));
}

export function buildSessionPreparationRequestKey(
  input: SessionPreparationRequestIdentity
): string {
  return JSON.stringify([
    normalizeSessionPreparationClaimIdentity(input),
    normalizeSessionPreparationRunConfigForDedup(input.runConfig),
  ]);
}
