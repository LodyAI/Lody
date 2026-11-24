import { z } from 'zod';
import {
  isModelScopedSessionDefaultConfigId,
  resolveSessionDefaultConfigOptionValues,
  WorktreeSetupScriptConfigSchema,
  type AcpConfigOptionValue,
  type AgentConfigId,
  type AgentConfigMeta,
  type WorktreeSetupScriptConfig,
} from '@lody/shared';

/**
 * Generic localStorage cache utility.
 * Provides type-safe read/write operations with Zod validation.
 */
export function createLocalStorageCache<T>(key: string, schema: z.ZodType<T>) {
  const mapSchema = z.record(z.string(), schema);

  function readAll(): Record<string, T> {
    if (typeof window === 'undefined') return {};
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const parsed = mapSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  function get(id: string): T | null {
    return readAll()[id] ?? null;
  }

  function set(id: string, value: T): void {
    if (typeof window === 'undefined') return;
    try {
      const all = readAll();
      all[id] = value;
      localStorage.setItem(key, JSON.stringify(all));
    } catch {
      // ignore
    }
  }

  function update(id: string, patch: Partial<T>, defaultValue: T): void {
    const current = get(id);
    set(id, { ...(current ?? defaultValue), ...patch } as T);
  }

  function remove(id: string): void {
    if (typeof window === 'undefined') return;
    try {
      const all = readAll();
      if (!(id in all)) return;
      delete all[id];
      localStorage.setItem(key, JSON.stringify(all));
    } catch {
      // ignore
    }
  }

  return { readAll, get, set, update, remove };
}

// Mode/Model/ConfigOption defaults schema for new sessions, keyed by agent.
const configOptionValueSchema = z.union([z.string(), z.boolean()]);

const agentSessionDefaultsSchema = z.object({
  modeId: z.string().nullable(),
  modelId: z.string().nullable(),
  configOptionValues: z.record(z.string(), configOptionValueSchema).optional(),
  modelConfigOptionValues: z
    .record(z.string(), z.record(z.string(), configOptionValueSchema))
    .optional(),
});

export type AgentSessionDefaults = z.infer<typeof agentSessionDefaultsSchema>;

const resolveStoredDefaultsModelId = (
  defaults:
    | {
        modelId?: string | null;
        configOptionValues?: Record<string, AcpConfigOptionValue> | null;
      }
    | null
    | undefined
): string | undefined =>
  defaults?.modelId ??
  (typeof defaults?.configOptionValues?.model === 'string'
    ? defaults.configOptionValues.model
    : undefined);

export function persistAgentSessionDefaults(
  agentId: AgentConfigId | null | undefined,
  defaults: {
    modeId?: string | null;
    modelId?: string | null;
    configOptionValues?: Record<string, AcpConfigOptionValue> | null;
  }
): void {
  if (!agentId) return;
  const previous = agentDefaultsCache.get(agentId);
  const effectiveModelId = resolveStoredDefaultsModelId(defaults);
  const nextModelConfigOptionValues: Record<string, Record<string, AcpConfigOptionValue>> = {
    ...previous?.modelConfigOptionValues,
  };

  const previousModelId = resolveStoredDefaultsModelId(previous);
  if (previousModelId && previous?.configOptionValues) {
    for (const [configId, value] of Object.entries(previous.configOptionValues)) {
      if (
        isModelScopedSessionDefaultConfigId(configId) &&
        nextModelConfigOptionValues[previousModelId]?.[configId] === undefined
      ) {
        nextModelConfigOptionValues[previousModelId] = {
          ...nextModelConfigOptionValues[previousModelId],
          [configId]: value,
        };
      }
    }
  }

  let sessionWideValues: Record<string, AcpConfigOptionValue> | undefined;
  if (effectiveModelId) {
    const common: Record<string, AcpConfigOptionValue> = {};
    const perModel: Record<string, AcpConfigOptionValue> = {};
    for (const [configId, value] of Object.entries(defaults.configOptionValues ?? {})) {
      if (isModelScopedSessionDefaultConfigId(configId)) {
        perModel[configId] = value;
      } else {
        common[configId] = value;
      }
    }
    if (Object.keys(perModel).length > 0) {
      nextModelConfigOptionValues[effectiveModelId] = perModel;
    } else {
      delete nextModelConfigOptionValues[effectiveModelId];
    }
    sessionWideValues = Object.keys(common).length > 0 ? common : undefined;
  } else if (defaults.configOptionValues && Object.keys(defaults.configOptionValues).length > 0) {
    sessionWideValues = defaults.configOptionValues;
  }

  agentDefaultsCache.set(agentId, {
    modeId: defaults.modeId ?? null,
    modelId: defaults.modelId ?? null,
    ...(sessionWideValues ? { configOptionValues: sessionWideValues } : {}),
    ...(Object.keys(nextModelConfigOptionValues).length > 0
      ? { modelConfigOptionValues: nextModelConfigOptionValues }
      : {}),
  });
}

// Agent session defaults cache
export const agentDefaultsCache = createLocalStorageCache<AgentSessionDefaults>(
  'lody:agentSessionDefaults',
  agentSessionDefaultsSchema
);

/**
 * What a new conversation with a Provider starts from: the combination the
 * person last ran with it on this device, under the Provider's own session
 * defaults (Settings > Lody Agent). Those are an explicit setting, so for the
 * values they name they win over what was merely used last.
 */
export function readAgentStartDefaults(
  config: Pick<AgentConfigMeta, 'id' | 'sessionDefaults'> | undefined
): AgentSessionDefaults | null {
  if (!config) return null;
  const cached = agentDefaultsCache.get(config.id) ?? null;
  const provider = config.sessionDefaults;
  if (!provider) return cached;

  const modelId = provider.modelId ?? cached?.modelId ?? null;
  const providerModelId = resolveStoredDefaultsModelId(provider);
  const cachedModelId = resolveStoredDefaultsModelId(cached);
  const effectiveModelId = modelId ?? providerModelId ?? cachedModelId;

  const configOptionValues = {
    ...resolveSessionDefaultConfigOptionValues(
      cached
        ? {
            ...(cached.modelId ? { modelId: cached.modelId } : {}),
            configOptionValues: cached.configOptionValues ?? {},
          }
        : undefined,
      effectiveModelId
    ),
    ...resolveSessionDefaultConfigOptionValues(
      {
        ...(provider.modelId ? { modelId: provider.modelId } : {}),
        configOptionValues: provider.configOptionValues ?? {},
      },
      effectiveModelId
    ),
  };

  const modelConfigOptionValues: Record<string, Record<string, AcpConfigOptionValue>> = {};
  for (const key of new Set([
    ...Object.keys(cached?.modelConfigOptionValues ?? {}),
    ...Object.keys(provider.modelConfigOptionValues ?? {}),
  ])) {
    const merged = {
      ...cached?.modelConfigOptionValues?.[key],
      ...provider.modelConfigOptionValues?.[key],
    };
    if (Object.keys(merged).length > 0) {
      modelConfigOptionValues[key] = merged;
    }
  }
  if (cachedModelId && cached?.configOptionValues) {
    for (const [configId, value] of Object.entries(cached.configOptionValues)) {
      if (
        isModelScopedSessionDefaultConfigId(configId) &&
        modelConfigOptionValues[cachedModelId]?.[configId] === undefined
      ) {
        modelConfigOptionValues[cachedModelId] = {
          ...modelConfigOptionValues[cachedModelId],
          [configId]: value,
        };
      }
    }
  }
  if (providerModelId && provider.configOptionValues) {
    for (const [configId, value] of Object.entries(provider.configOptionValues)) {
      if (isModelScopedSessionDefaultConfigId(configId)) {
        modelConfigOptionValues[providerModelId] = {
          ...modelConfigOptionValues[providerModelId],
          [configId]: value,
        };
      }
    }
  }

  return {
    modeId: cached?.modeId ?? null,
    modelId,
    ...(Object.keys(configOptionValues).length ? { configOptionValues } : {}),
    ...(Object.keys(modelConfigOptionValues).length ? { modelConfigOptionValues } : {}),
  };
}

// GitHub repos cache
export const cachedGitHubRepoSchema = z.object({
  fullName: z.string(),
  description: z.string().nullable().optional(),
});

export type CachedGitHubRepo = z.infer<typeof cachedGitHubRepoSchema>;

export const workspaceReposCacheSchema = z.object({
  repositories: z.array(cachedGitHubRepoSchema),
  updatedAt: z.number(),
});

export type WorkspaceReposCache = z.infer<typeof workspaceReposCacheSchema>;

export const githubReposCache = createLocalStorageCache<WorkspaceReposCache>(
  'lody:githubReposCache',
  workspaceReposCacheSchema
);

// GitHub repository branches cache
// Maps `${workspaceId}:${repoFullName}` -> recently fetched branch metadata.
export const githubBranchesCacheSchema = z.object({
  branches: z.array(z.string()),
  defaultBranch: z.string().nullable(),
  // Cursor for the next unloaded page; entries written before paging are complete lists.
  nextPageUrl: z.string().nullable().optional(),
  updatedAt: z.number(),
});

export type GitHubBranchesCache = z.infer<typeof githubBranchesCacheSchema>;

export const githubBranchesCache = createLocalStorageCache<GitHubBranchesCache>(
  'lody:githubBranchesCache',
  githubBranchesCacheSchema
);

// Workspace info cache
// Maps workspaceSlug -> {workspaceId, workspaceName} for offline-first access.
// When a user visits a workspace, we cache the info so that subsequent visits
// can use it immediately before the server responds.
export const workspaceInfoCacheSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  updatedAt: z.number(),
});

export type WorkspaceInfoCache = z.infer<typeof workspaceInfoCacheSchema>;

export const workspaceInfoCache = createLocalStorageCache<WorkspaceInfoCache>(
  'lody:workspaceInfo',
  workspaceInfoCacheSchema
);

/**
 * Get cached workspace info for a given slug.
 * Returns null if no cached info exists.
 */
export function getCachedWorkspaceInfo(
  slug: string
): { workspaceId: string; workspaceName: string } | null {
  const info = workspaceInfoCache.get(slug);
  if (!info) return null;
  return { workspaceId: info.workspaceId, workspaceName: info.workspaceName };
}

/**
 * Get cached workspaceId for a given slug.
 * Returns null if no cached mapping exists.
 */
export function getCachedWorkspaceId(slug: string): string | null {
  const info = workspaceInfoCache.get(slug);
  return info?.workspaceId ?? null;
}

/**
 * Get cached workspaceName for a given slug.
 * Returns null if no cached name exists.
 */
export function getCachedWorkspaceName(slug: string): string | null {
  const info = workspaceInfoCache.get(slug);
  return info?.workspaceName ?? null;
}

/**
 * Cache workspace info for a given slug.
 * Call this when server responds with workspace data.
 */
export function cacheWorkspaceInfo(slug: string, workspaceId: string, workspaceName: string): void {
  workspaceInfoCache.set(slug, {
    workspaceId,
    workspaceName,
    updatedAt: Date.now(),
  });
}

/**
 * Drop cached workspace info for a slug.
 * Call this when the user leaves/deletes an org so the optimistic resolver
 * stops returning a workspaceId the user no longer has access to.
 */
export function clearCachedWorkspaceInfo(slug: string): void {
  workspaceInfoCache.remove(slug);
}

// Session header path launcher preference cache (global, not per-session).
export const builtinPathLauncherIdSchema = z.enum([
  'vscode',
  'cursor',
  'antigravity',
  'windsurf',
  'zed',
  'sublime',
  'warp',
  'xcode',
  'delta',
]);

export type BuiltinPathLauncherId = z.infer<typeof builtinPathLauncherIdSchema>;

export const customPathLauncherSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(48),
  commandTemplate: z.string().trim().min(1).max(1000),
});

export type CustomPathLauncher = z.infer<typeof customPathLauncherSchema>;

export type PathLauncherPreference = {
  selectedLauncherId: string;
  customLaunchers: CustomPathLauncher[];
};

export const pathLauncherPreferenceSchema = z.object({
  selectedLauncherId: z.string().trim().min(1).max(120),
  customLaunchers: z.array(customPathLauncherSchema).max(20).default([]),
});

export const DEFAULT_PATH_LAUNCHER_PREFERENCE: PathLauncherPreference = {
  selectedLauncherId: 'vscode',
  customLaunchers: [],
};

export type IdePreference = PathLauncherPreference;

export const PATH_LAUNCHER_PREFERENCE_STORAGE_KEY = 'lody:idePreference';

export const idePreferenceCache = createLocalStorageCache<IdePreference>(
  PATH_LAUNCHER_PREFERENCE_STORAGE_KEY,
  pathLauncherPreferenceSchema
);

// Worktree setup / cleanup script config cache.
// Maps `${machineId}:${localProjectId}` -> the last-known script config so the
// project settings page can render instantly from disk while it re-fetches the
// authoritative value from the CLI in the background. These configs change
// rarely, so the cached copy is almost always already correct.
export const worktreeSetupConfigCache = createLocalStorageCache<WorktreeSetupScriptConfig>(
  'lody:worktreeSetupConfig',
  WorktreeSetupScriptConfigSchema
);

export const worktreeCleanupConfigCache = createLocalStorageCache<WorktreeSetupScriptConfig>(
  'lody:worktreeCleanupConfig',
  WorktreeSetupScriptConfigSchema
);
