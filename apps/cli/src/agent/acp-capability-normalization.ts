import {
  deriveModelReasoningEffortsFromLegacyModelIds,
  type AcpCommandSummary,
  type AcpConfigOptionSummary,
  type DeclaredModelCapabilities,
} from '@lody/shared';
import type { SessionConfigOption, SessionConfigSelectGroup } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { filterAcpConfigOptions } from '@/agent/acp-config-option-filter';

/**
 * Bounds for the agent's self-declared model catalog.
 *
 * `_meta` is whatever the other side put there, and this one gets persisted and
 * fanned out to every client of the workspace, so it is bounded before it is
 * believed. Numbers are generous for a real catalog and small for a payload:
 * an agent publishing more models than this is not describing itself.
 */
const DECLARED_MODEL_LIMITS = {
  models: 64,
  modelIdLength: 128,
  effortValues: 16,
  effortValueLength: 64,
} as const;

const zDeclaredModelCapabilities = z.object({
  _meta: z
    .object({
      lody: z
        .object({
          modelCapabilities: z
            .object({
              version: z.literal(1),
              producerRevision: z.string().trim().min(1).max(128).optional(),
              models: z
                .record(
                  z.string().trim().min(1).max(DECLARED_MODEL_LIMITS.modelIdLength),
                  z.object({
                    effortValues: z
                      .array(z.string().trim().min(1).max(DECLARED_MODEL_LIMITS.effortValueLength))
                      .max(DECLARED_MODEL_LIMITS.effortValues)
                      .optional(),
                    fastMode: z.boolean().optional(),
                  })
                )
                .refine((models) => Object.keys(models).length <= DECLARED_MODEL_LIMITS.models),
            })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/**
 * Reads the agent's own per-model statement, or nothing.
 *
 * An unknown `version`, a shape that does not parse, or a catalog past the
 * bounds is ignored WHOLE rather than partially: half a catalog would answer
 * "this model has no fast mode" for models the agent simply could not fit.
 */
export function readDeclaredModelCapabilities(
  sessionResponse: unknown,
  receivedAt: number
): DeclaredModelCapabilities | undefined {
  const parsed = zDeclaredModelCapabilities.safeParse(sessionResponse);
  const declared = parsed.success ? parsed.data._meta?.lody?.modelCapabilities : undefined;
  if (!declared || Object.keys(declared.models).length === 0) {
    return undefined;
  }
  return {
    version: 1,
    models: declared.models,
    receivedAt,
    ...(declared.producerRevision ? { producerRevision: declared.producerRevision } : {}),
  };
}

export type AcpCapabilitiesResult = {
  modes: Array<{ id: string; name: string; description?: string }>;
  models: Array<{ modelId: string; name?: string; description?: string }>;
  configOptions?: AcpConfigOptionSummary[];
  availableCommands?: AcpCommandSummary[];
  sessionFork: boolean;
  acknowledgedSteer: boolean;
  modelReasoningEfforts?: Record<string, string[]>;
  measuredForModelId?: string;
  declaredModelCapabilities?: DeclaredModelCapabilities;
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
};

/** Extract cacheable capabilities from a real ACP new/load/resume session response. */
export function normalizeAcpSessionCapabilities(
  sessionResponse: AcpSessionCapabilitiesResponse,
  lifecycleCapabilities: {
    sessionFork?: boolean;
    acknowledgedSteer?: boolean;
    receivedAt?: number;
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
  // rebuild the effort/fast options on every model switch. The legacy model list
  // is the only place some agents (Codex) expose every `model[effort]`
  // combination, so keep reading it even when configOptions supersede it.
  const modelReasoningEfforts = deriveModelReasoningEffortsFromLegacyModelIds(
    legacyModels.map((model) => model.modelId)
  );

  // What the snapshot is a snapshot OF, stored rather than left to each reader
  // to infer from the model option's `currentValue`.
  const modelOptionValue = modelOption?.currentValue;
  const measuredForModelId =
    typeof modelOptionValue === 'string'
      ? modelOptionValue
      : (readLegacySessionModelState(sessionResponse)?.currentModelId ?? undefined);
  const declaredModelCapabilities = readDeclaredModelCapabilities(
    sessionResponse,
    lifecycleCapabilities.receivedAt ?? Date.now()
  );

  return {
    modes,
    models,
    configOptions,
    availableCommands,
    sessionFork: lifecycleCapabilities.sessionFork === true,
    acknowledgedSteer: lifecycleCapabilities.acknowledgedSteer === true,
    ...(modelReasoningEfforts ? { modelReasoningEfforts } : {}),
    ...(measuredForModelId ? { measuredForModelId } : {}),
    ...(declaredModelCapabilities ? { declaredModelCapabilities } : {}),
  };
}
