import {
  deriveModelReasoningEffortsFromLegacyModelIds,
  type AcpCommandSummary,
  type AcpConfigOptionSummary,
} from '@lody/shared';
import type { SessionConfigOption, SessionConfigSelectGroup } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { filterAcpConfigOptions } from '@/agent/acp-config-option-filter';

export type AcpCapabilitiesResult = {
  modes: Array<{ id: string; name: string; description?: string }>;
  models: Array<{ modelId: string; name?: string; description?: string }>;
  configOptions?: AcpConfigOptionSummary[];
  availableCommands?: AcpCommandSummary[];
  sessionFork: boolean;
  acknowledgedSteer: boolean;
  modelReasoningEfforts?: Record<string, string[]>;
};

function isSelectGroup(item: unknown): item is SessionConfigSelectGroup {
  return typeof item === 'object' && item !== null && 'group' in item;
}

/** Normalize ACP session config options into the flattened cache representation. */
export function normalizeConfigOptions(
  raw: SessionConfigOption[] | null | undefined
): AcpConfigOptionSummary[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  const supported = filterAcpConfigOptions(raw);
  if (supported.length === 0) {
    return undefined;
  }
  return supported.map((opt) => {
    if (opt.type === 'boolean') {
      return {
        id: opt.id,
        name: opt.name,
        description: opt.description ?? undefined,
        category: opt.category ?? undefined,
        type: 'boolean' as const,
        currentValue: opt.currentValue,
        options: [],
      };
    }

    const flatOptions: AcpConfigOptionSummary['options'] = [];
    for (const entry of opt.options) {
      if (isSelectGroup(entry)) {
        for (const child of entry.options) {
          flatOptions.push({
            value: child.value,
            name: child.name,
            description: child.description ?? undefined,
            group: entry.name,
          });
        }
      } else {
        flatOptions.push({
          value: entry.value,
          name: entry.name,
          description: entry.description ?? undefined,
        });
      }
    }
    return {
      id: opt.id,
      name: opt.name,
      description: opt.description ?? undefined,
      category: opt.category ?? undefined,
      type: 'select' as const,
      currentValue: opt.currentValue,
      options: flatOptions,
    };
  });
}

const zLegacySessionModels = z.object({
  models: z
    .object({
      currentModelId: z.string().nullish(),
      availableModels: z
        .array(
          z.object({
            modelId: z.string(),
            name: z.string().nullish(),
            description: z.string().nullish(),
          })
        )
        .nullish(),
    })
    .nullish(),
});

export type LegacySessionModelState = {
  currentModelId?: string;
  availableModels: AcpCapabilitiesResult['models'];
};

const zSessionAvailableCommands = z.object({
  availableCommands: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().nullish(),
      })
    )
    .nullish(),
});

/** Read the pre-configOptions model state without accepting vendor-specific metadata. */
export function readLegacySessionModelState(
  sessionResponse: unknown
): LegacySessionModelState | undefined {
  const parsed = zLegacySessionModels.safeParse(sessionResponse);
  const modelState = parsed.success ? parsed.data.models : undefined;
  if (!modelState) {
    return undefined;
  }
  return {
    currentModelId: modelState.currentModelId ?? undefined,
    availableModels: (modelState.availableModels ?? []).map((model) => ({
      modelId: model.modelId,
      name: model.name ?? undefined,
      description: model.description ?? undefined,
    })),
  };
}

function readSessionAvailableCommands(
  sessionResponse: unknown
): AcpCapabilitiesResult['availableCommands'] {
  const parsed = zSessionAvailableCommands.safeParse(sessionResponse);
  if (!parsed.success || parsed.data.availableCommands == null) {
    return undefined;
  }
  return parsed.data.availableCommands.map((command) => ({
    name: command.name,
    description: command.description ?? undefined,
  }));
}

type AcpSessionCapabilitiesResponse = {
  modes?: {
    availableModes?: Array<{ id: string; name: string; description?: string | null }> | null;
  } | null;
  configOptions?: SessionConfigOption[] | null;
  /** Session-response meta; adapters publish Lody-owned contracts here. */
  _meta?: Record<string, unknown> | null;
};

const zLodySessionResponseMeta = z.object({
  _meta: z
    .object({
      lody: z
        .object({
          modelReasoningEfforts: z.record(z.string(), z.array(z.string())),
        })
        .nullish(),
    })
    .nullish(),
});

/**
 * Per-model reasoning-effort ladders an adapter published under the Lody-owned
 * "_meta.lody" session-response namespace (the Grok adapter does; agents that
 * publish no per-model information have none and stay undefined).
 */
export function readLodyModelReasoningEfforts(
  sessionResponse: unknown
): Record<string, string[]> | undefined {
  const parsed = zLodySessionResponseMeta.safeParse(sessionResponse);
  const map = parsed.success ? parsed.data._meta?.lody?.modelReasoningEfforts : undefined;
  return map && Object.keys(map).length > 0 ? map : undefined;
}

/**
 * Only builtin Codex encodes reasoning effort into its legacy model ids
 * (`gpt-5.6-sol[xhigh]`). Other agents use the same bracket syntax for
 * unrelated variants — Claude's `opus[1m]` is a context window — so the
 * legacy derivation must not read those as effort ladders.
 */
const usesCodexModelEffortIds = (agent?: { cliType: string; agentType: string }): boolean =>
  agent?.cliType === 'builtin' && agent.agentType === 'codex';

/** Extract cacheable capabilities from a real ACP new/load/resume session response. */
export function normalizeAcpSessionCapabilities(
  sessionResponse: AcpSessionCapabilitiesResponse,
  lifecycleCapabilities: {
    sessionFork?: boolean;
    acknowledgedSteer?: boolean;
    /** The agent that answered; decides whether legacy `model[effort]` ids apply. */
    agent?: { cliType: string; agentType: string };
  } = {}
): AcpCapabilitiesResult {
  const modes = (sessionResponse.modes?.availableModes ?? []).map((mode) => ({
    id: mode.id,
    name: mode.name,
    description: mode.description ?? undefined,
  }));
  const configOptions = normalizeConfigOptions(sessionResponse.configOptions);
  const modelOption = configOptions?.find((option) => option.category === 'model');
  const modelsFromConfigOptions = (modelOption?.options ?? []).map((option) => ({
    modelId: option.value,
    name: option.name,
    description: option.description,
  }));
  const legacyModels = readLegacySessionModelState(sessionResponse)?.availableModels ?? [];
  const models = modelsFromConfigOptions.length > 0 ? modelsFromConfigOptions : legacyModels;
  const availableCommands = readSessionAvailableCommands(sessionResponse);
  // `configOptions` only describes the model that is current right now — agents
  // rebuild the effort/fast options on every model switch. Two sources expose
  // the model-independent view: the legacy `model[effort]` list (Codex) and the
  // Lody "_meta.lody" map the adapter translates vendor metadata into (Grok).
  const modelReasoningEfforts = {
    ...readLodyModelReasoningEfforts(sessionResponse),
    ...(usesCodexModelEffortIds(lifecycleCapabilities.agent)
      ? deriveModelReasoningEffortsFromLegacyModelIds(legacyModels.map((model) => model.modelId))
      : undefined),
  };

  return {
    modes,
    models,
    configOptions,
    availableCommands,
    sessionFork: lifecycleCapabilities.sessionFork === true,
    acknowledgedSteer: lifecycleCapabilities.acknowledgedSteer === true,
    ...(Object.keys(modelReasoningEfforts).length > 0 ? { modelReasoningEfforts } : {}),
  };
}
