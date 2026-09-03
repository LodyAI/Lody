import {
  AGENT_ROLE_VERSION,
  ACP_CONFIG_OPTION_OFF_VALUE,
  getAgentRoleMentionSlug,
  isAcpThoughtLevelConfigOption,
  isAgentRoleContentEqual,
  isSensitiveAgentRoleConfigOptionKey,
  normalizeAgentRoleEmoji,
  normalizeAgentRoleMentionSlug,
  normalizeAgentRoleRunConfig,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type AgentRoleRunConfig,
  type MachineId,
} from '@lody/shared';
import {
  isConfigOptionValueValid,
  type AcpSelectorOptions,
} from '@/components/shared/acp-selector-options';

/**
 * The authoring state of one Agent Role, and the pure rules around it.
 *
 * Separated from the dialog so the parts that must not be got wrong — what a
 * Role may store, when `revision` moves, and whether a saved Role still matches
 * its agent's capabilities — are testable without rendering anything.
 */
export type AgentRoleFormValue = {
  name: string;
  emoji: string;
  machineId: MachineId | null;
  agentConfigId: AgentConfigId | null;
  modeId: string | null;
  modelId: string | null;
  configOptionValues: Record<string, string | boolean>;
  promptPrefix: string;
  /** Off by default: a new Role is private until its owner says otherwise. */
  shareWithWorkspace: boolean;
};

export const EMPTY_AGENT_ROLE_FORM_VALUE: AgentRoleFormValue = {
  name: '',
  emoji: '',
  machineId: null,
  agentConfigId: null,
  modeId: null,
  modelId: null,
  configOptionValues: {},
  promptPrefix: '',
  shareWithWorkspace: false,
};

/**
 * Seed a new Role from a run configuration the user already has in front of
 * them — the composer's current selection.
 *
 * Creating a Role out of "what I am about to run" is the whole point of
 * offering it from the composer, so the form opens on that configuration with
 * only the name left to write. The values pass through the shared normalizer,
 * so the seed refuses exactly the option keys a Role may never store.
 */
export const buildAgentRoleFormValueFromRunConfig = (input: {
  machineId: MachineId | null | undefined;
  agentConfigId: AgentConfigId | null | undefined;
  modeId?: string | null;
  modelId?: string | null;
  configOptionValues?: Record<string, string | boolean | undefined>;
}): AgentRoleFormValue => {
  const runConfig = normalizeAgentRoleRunConfig({
    modeId: input.modeId ?? undefined,
    modelId: input.modelId ?? undefined,
    configOptionValues: input.configOptionValues,
  });
  return {
    ...EMPTY_AGENT_ROLE_FORM_VALUE,
    machineId: input.machineId ?? null,
    agentConfigId: input.agentConfigId ?? null,
    modeId: runConfig.modeId ?? null,
    modelId: runConfig.modelId ?? null,
    configOptionValues: { ...(runConfig.configOptionValues ?? {}) },
  };
};

export const buildAgentRoleFormValue = (role: AgentRole): AgentRoleFormValue => ({
  name: role.name,
  emoji: role.emoji ?? '',
  machineId: role.machineId,
  agentConfigId: role.agentConfigId,
  modeId: role.runConfig.modeId ?? null,
  modelId: role.runConfig.modelId ?? null,
  configOptionValues: { ...(role.runConfig.configOptionValues ?? {}) },
  promptPrefix: role.promptPrefix ?? '',
  shareWithWorkspace: role.visibility === 'workspace',
});

export type AgentRoleFormError =
  | 'name_required'
  | 'name_taken'
  | 'machine_required'
  | 'agent_config_required';

/**
 * The name is the only authored label, so it carries both jobs: it is what the
 * list shows and what `@` completes. Uniqueness is therefore checked on the
 * DERIVED mention token — "Code Reviewer" and "Code-Reviewer" are the same
 * `@Code-Reviewer` — and only against the Roles this user can see. It is a
 * readability rule, not an identity one: the mention range always carries the
 * Role id, so another member's private Role neither can nor needs to be checked.
 */
export const validateAgentRoleForm = (
  value: AgentRoleFormValue,
  options: { accessibleRoles: readonly AgentRole[]; editingRoleId?: AgentRoleId | null }
): AgentRoleFormError[] => {
  const errors: AgentRoleFormError[] = [];
  const slug = normalizeAgentRoleMentionSlug(value.name);
  if (!slug) {
    // Covers both an empty name and one that is all punctuation the mention
    // token strips: either way there is nothing to type after `@`.
    errors.push('name_required');
  } else if (
    options.accessibleRoles.some(
      (role) => role.id !== options.editingRoleId && getAgentRoleMentionSlug(role) === slug
    )
  ) {
    errors.push('name_taken');
  }

  if (!value.machineId) errors.push('machine_required');
  if (!value.agentConfigId) errors.push('agent_config_required');
  return errors;
};

/**
 * The run config a form value implies.
 *
 * Runs through the shared normalizer rather than copying the fields, so the
 * authoring surface refuses exactly the option keys the reader would later
 * refuse — a Role never becomes a place a secret is stored.
 */
export const buildAgentRoleRunConfig = (value: AgentRoleFormValue): AgentRoleRunConfig =>
  normalizeAgentRoleRunConfig({
    modeId: value.modeId ?? undefined,
    modelId: value.modelId ?? undefined,
    configOptionValues: value.configOptionValues,
  });

/**
 * Turn an authored form into the row to persist.
 *
 * `revision` only moves when something actually changed: accepted Operations
 * and Session provenance record it, so a no-op save must not invent a new one.
 */
export const buildAgentRoleFromForm = (
  value: AgentRoleFormValue,
  options: {
    existing?: AgentRole;
    ownerUserId: string;
    now: number;
    createId: () => AgentRoleId;
  }
): AgentRole => {
  const { existing, ownerUserId, now } = options;
  const emoji = normalizeAgentRoleEmoji(value.emoji);
  const promptPrefix = value.promptPrefix.trim();
  const next: AgentRole = {
    v: AGENT_ROLE_VERSION,
    id: existing?.id ?? options.createId(),
    ownerUserId: existing?.ownerUserId ?? ownerUserId,
    visibility: value.shareWithWorkspace ? 'workspace' : 'private',
    name: value.name.trim(),
    ...(emoji ? { emoji } : {}),
    machineId: value.machineId as MachineId,
    agentConfigId: value.agentConfigId as AgentConfigId,
    runConfig: buildAgentRoleRunConfig(value),
    ...(promptPrefix ? { promptPrefix } : {}),
    revision: existing?.revision ?? 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
  };

  if (!existing) return next;
  if (isAgentRoleContentEqual(existing, next)) return existing;
  return { ...next, revision: existing.revision + 1, updatedAt: now };
};

/**
 * Seed a form value with what the selected agent actually defaults to.
 *
 * A Role has no "inherit" state: every run-config control shows a concrete
 * value, because "Agent default" tells a user nothing about what will run and
 * pushes the decision to a later surface. So the first time a config is
 * selected the agent's own defaults are written in, and from there the user is
 * choosing, not accepting a blank.
 *
 * Only unset fields are filled: a saved Role keeps its stored selection even
 * when it differs from the agent's current default, which is what makes an
 * incompatible value visible instead of silently replaced.
 *
 * A Role is a durable promise about how a Session will run, so it may only be
 * seeded from capabilities the agent itself reported. `provisional` ones are
 * the built-in static tables — a hand-maintained copy of a catalog the agent
 * fetches per account — and writing those in would persist a GUESS as the
 * Role's commitment. That is how a Role came to promise Fast mode for an agent
 * whose probe never published the option. Unseeded fields stay unset and the
 * user chooses them.
 */
export const applyAgentRoleRunConfigDefaults = (
  value: AgentRoleFormValue,
  selectorOptions: AcpSelectorOptions | null
): AgentRoleFormValue => {
  if (!selectorOptions || selectorOptions.capabilityAuthority !== 'authoritative') return value;

  const modelId =
    value.modelId ??
    (selectorOptions.modelOptions.length > 0
      ? (selectorOptions.defaultModelId ?? selectorOptions.modelOptions[0]?.value ?? null)
      : null);
  const modeId =
    value.modeId ??
    (selectorOptions.modeOptions.length > 0
      ? (selectorOptions.defaultModeId ?? selectorOptions.modeOptions[0]?.value ?? null)
      : null);

  const configOptionValues = { ...value.configOptionValues };
  for (const selector of selectAuthorableAgentRoleConfigOptions(
    selectorOptions.configOptionSelectors
  )) {
    if (configOptionValues[selector.configId] !== undefined) continue;
    configOptionValues[selector.configId] = selector.currentValue;
  }

  if (
    modelId === value.modelId &&
    modeId === value.modeId &&
    Object.keys(configOptionValues).length === Object.keys(value.configOptionValues).length
  ) {
    return value;
  }
  return { ...value, modelId, modeId, configOptionValues };
};

// ---------------------------------------------------------------------------
// Capability compatibility
// ---------------------------------------------------------------------------

export type AgentRoleRunConfigIssue =
  /** The agent's capabilities are unknown, so nothing can be judged compatible. */
  | { kind: 'capabilities_unknown' }
  | { kind: 'mode_unsupported'; value: string }
  | { kind: 'model_unsupported'; value: string }
  | { kind: 'option_unsupported'; configId: string }
  | { kind: 'option_value_unsupported'; configId: string; value: string };

/**
 * Which parts of a saved run config the selected agent no longer supports.
 *
 * Reported rather than repaired. A Role whose model disappeared must say so and
 * stay unavailable until its owner picks a new one — quietly substituting the
 * agent's default is the failure mode this feature exists to avoid.
 */
export const findAgentRoleRunConfigIssues = (
  runConfig: AgentRoleRunConfig,
  selectorOptions: AcpSelectorOptions
): AgentRoleRunConfigIssue[] => {
  const hasSelection =
    Boolean(runConfig.modeId) ||
    Boolean(runConfig.modelId) ||
    Object.keys(runConfig.configOptionValues ?? {}).length > 0;
  if (selectorOptions.capabilityAuthority === 'unavailable') {
    return hasSelection ? [{ kind: 'capabilities_unknown' }] : [];
  }

  const issues: AgentRoleRunConfigIssue[] = [];
  if (
    runConfig.modeId &&
    !selectorOptions.modeOptions.some((option) => option.value === runConfig.modeId)
  ) {
    issues.push({ kind: 'mode_unsupported', value: runConfig.modeId });
  }
  if (
    runConfig.modelId &&
    !selectorOptions.modelOptions.some((option) => option.value === runConfig.modelId)
  ) {
    issues.push({ kind: 'model_unsupported', value: runConfig.modelId });
  }

  for (const [configId, value] of Object.entries(runConfig.configOptionValues ?? {})) {
    const selector = selectorOptions.configOptionSelectors.find(
      (candidate) => candidate.configId === configId
    );
    if (!selector) {
      issues.push({ kind: 'option_unsupported', configId });
      continue;
    }
    if (!isConfigOptionValueValid(selector, value)) {
      issues.push({ kind: 'option_value_unsupported', configId, value: String(value) });
    }
  }
  return issues;
};

/**
 * The option selectors a Role may author.
 *
 * The same refusal as the reader: an agent is free to publish an option with
 * any id, so a secret-shaped one is never offered as something to store.
 */
export const selectAuthorableAgentRoleConfigOptions = <T extends { configId: string }>(
  selectors: readonly T[]
): T[] => selectors.filter((selector) => !isSensitiveAgentRoleConfigOptionKey(selector.configId));

// ---------------------------------------------------------------------------
// Row summary
// ---------------------------------------------------------------------------

/**
 * What a Role's row says it will run, in reading order: model, reasoning, then
 * whatever else it pins.
 *
 * Values only, no `key=value`: the machine is in the group heading and the agent
 * is its icon, so this line is the part a user scans to tell two Roles on one
 * agent apart. An option left at the agent's own default still appears — a Role
 * pins concrete values, and hiding one would make two different Roles read the
 * same. A boolean that is OFF is dropped instead, because "fast mode: false"
 * says nothing a missing chip does not.
 */
export const buildAgentRoleRunConfigSummary = (runConfig: AgentRoleRunConfig): string[] => {
  // A Role stores option IDS only — the capability's `category` is not part of
  // the row — so the id is tested as both, which also matches an agent whose
  // reasoning option is literally named after the category.
  const isReasoning = (configId: string) =>
    isAcpThoughtLevelConfigOption({ id: configId, category: configId });
  const options = Object.entries(runConfig.configOptionValues ?? {});
  const reasoning = options.filter(([configId]) => isReasoning(configId));
  const rest = options.filter(([configId]) => !isReasoning(configId));

  const describe = (entries: [string, string | boolean][]): string[] =>
    entries.flatMap(([configId, value]) => {
      if (typeof value === 'boolean') return value ? [configId] : [];
      if (value === ACP_CONFIG_OPTION_OFF_VALUE) return [];
      return [value];
    });

  return [
    ...(runConfig.modelId ? [runConfig.modelId] : []),
    ...describe(reasoning),
    ...(runConfig.modeId ? [runConfig.modeId] : []),
    ...describe(rest),
  ];
};
