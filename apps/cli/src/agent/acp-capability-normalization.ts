import {
  deriveModelReasoningEffortsFromLegacyModelIds,
  type AcpCommandSummary,
  type AcpConfigOptionSummary,
  type AcpConfigOptionValueSummary,
} from '@lody/shared';
import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk';
import { LODY_MODEL_OPTION_META_KEY, type LodyModelOptionMeta } from 'acp-extension-core';
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

const LodyModelOptionMetaSchema: z.ZodType<LodyModelOptionMeta> = z.object({
  version: z.literal(1),
  provider: z.string().trim().min(1).optional(),
});
const LodyModelOptionEnvelopeSchema = z.object({
  lody: z.object({
    [LODY_MODEL_OPTION_META_KEY]: LodyModelOptionMetaSchema,
  }),
});

function normalizeSelectOption(
  option: SessionConfigSelectOption,
  category: string | undefined,
  group?: string
): AcpConfigOptionValueSummary {
  const parsedMeta =
    category === 'model' ? LodyModelOptionEnvelopeSchema.safeParse(option._meta) : undefined;
  const provider = parsedMeta?.success
    ? parsedMeta.data.lody[LODY_MODEL_OPTION_META_KEY].provider
    : undefined;
  return {
    value: option.value,
    name: option.name,
    description: option.description ?? undefined,
    ...(provider ? { provider } : {}),
    ...(group !== undefined ? { group } : {}),
  };
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
          flatOptions.push(normalizeSelectOption(child, opt.category ?? undefined, entry.name));
        }
      } else {
        flatOptions.push(normalizeSelectOption(entry, opt.category ?? undefined));
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
};

/** Extract cacheable capabilities from a real ACP new/load/resume session response. */
export function normalizeAcpSessionCapabilities(
  sessionResponse: AcpSessionCapabilitiesResponse,
  lifecycleCapabilities: { sessionFork?: boolean; acknowledgedSteer?: boolean } = {}
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
  // rebuild the effort/fast options on every model switch. The legacy model list
  // is the only place some agents (Codex) expose every `model[effort]`
  // combination, so keep reading it even when configOptions supersede it.
  const modelReasoningEfforts = deriveModelReasoningEffortsFromLegacyModelIds(
    legacyModels.map((model) => model.modelId)
  );

  return {
    modes,
    models,
    configOptions,
    availableCommands,
    sessionFork: lifecycleCapabilities.sessionFork === true,
    acknowledgedSteer: lifecycleCapabilities.acknowledgedSteer === true,
    ...(modelReasoningEfforts ? { modelReasoningEfforts } : {}),
  };
}
