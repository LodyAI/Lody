import {
  AGENT_ROLE_VERSION,
  ACP_CONFIG_OPTION_OFF_VALUE,
  getAgentRoleMentionSlug,
  isAcpThoughtLevelConfigOption,
  isAgentRoleContentEqual,
  isSensitiveAgentRoleConfigOptionKey,
  normalizeAgentRoleEmoji,
  normalizeAgentRoleDescription,
  normalizeAgentRoleMentionSlug,
  normalizeAgentRoleAlias,
  normalizeAgentRoleRunConfig,
  getAgentRoleTargets,
  withAgentRoleTargets,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type AgentRoleRunConfig,
  type AgentRoleTarget,
  type MachineId,
  type MemoryBinding,
} from '@lody/shared';
import {
  isConfigOptionValueValid,
  type AcpConfigOptionSelector,
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
  description: string;
  emoji: string;
  promptPrefix: string;
  /** Off by default: a new Role is private until its owner says otherwise. */
  shareWithWorkspace: boolean;
  /** One per machine the Role runs on, in authoring order. */
  targets: AgentRoleTargetFormValue[];
  /** The machine tab being edited; it may have no target yet. */
  activeMachineId: MachineId | null;
};

/** How one machine runs the Role, while it is being authored. */
export type AgentRoleTargetFormValue = {
  machineId: MachineId;
  agentConfigId: AgentConfigId | null;
  modeId: string | null;
  modelId: string | null;
  configOptionValues: Record<string, string | boolean>;
  memory?: AgentRoleRunConfig['memory'];
  /** Only shown and stored while the Role has more than one target. */
  alias: string;
};

export const EMPTY_AGENT_ROLE_FORM_VALUE: AgentRoleFormValue = {
  name: '',
  description: '',
  emoji: '',
  promptPrefix: '',
  shareWithWorkspace: false,
  targets: [],
  activeMachineId: null,
};

export const createAgentRoleTargetFormValue = (machineId: MachineId): AgentRoleTargetFormValue => ({
  machineId,
  agentConfigId: null,
  modeId: null,
  modelId: null,
  configOptionValues: {},
  alias: '',
});

/** A new Role whose first target is on `machineId`, or with no target yet. */
export const createAgentRoleFormValue = (machineId: MachineId | null): AgentRoleFormValue => ({
  ...EMPTY_AGENT_ROLE_FORM_VALUE,
  targets: machineId ? [createAgentRoleTargetFormValue(machineId)] : [],
  activeMachineId: machineId,
});

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
  if (!input.machineId) return EMPTY_AGENT_ROLE_FORM_VALUE;
  const runConfig = normalizeAgentRoleRunConfig({
    modeId: input.modeId ?? undefined,
    modelId: input.modelId ?? undefined,
    configOptionValues: input.configOptionValues,
  });
  return {
    ...EMPTY_AGENT_ROLE_FORM_VALUE,
    targets: [
      {
        ...createAgentRoleTargetFormValue(input.machineId),
        agentConfigId: input.agentConfigId ?? null,
        modeId: runConfig.modeId ?? null,
        modelId: runConfig.modelId ?? null,
        configOptionValues: { ...(runConfig.configOptionValues ?? {}) },
      },
    ],
    activeMachineId: input.machineId,
  };
};

const buildTargetFormValue = (target: AgentRoleTarget): AgentRoleTargetFormValue => ({
  machineId: target.machineId,
  agentConfigId: target.agentConfigId,
  modeId: target.runConfig.modeId ?? null,
  modelId: target.runConfig.modelId ?? null,
  configOptionValues: { ...(target.runConfig.configOptionValues ?? {}) },
  memory: target.runConfig.memory,
  alias: target.alias ?? '',
});

export const buildAgentRoleFormValue = (
  role: AgentRole,
  activeMachineId: MachineId = role.machineId
): AgentRoleFormValue => ({
  name: role.name,
  description: role.description ?? '',
  emoji: role.emoji ?? '',
  promptPrefix: role.promptPrefix ?? '',
  shareWithWorkspace: role.visibility === 'workspace',
  targets: getAgentRoleTargets(role).map(buildTargetFormValue),
  activeMachineId,
});

export const getAgentRoleFormTarget = (
  value: AgentRoleFormValue,
  machineId: MachineId | null = value.activeMachineId
): AgentRoleTargetFormValue | undefined =>
  machineId ? value.targets.find((target) => target.machineId === machineId) : undefined;

/** Replace the target on `target.machineId`, or append it when the machine has none. */
export const putAgentRoleFormTarget = (
  value: AgentRoleFormValue,
  target: AgentRoleTargetFormValue
): AgentRoleFormValue => ({
  ...value,
  targets: value.targets.some((existing) => existing.machineId === target.machineId)
    ? value.targets.map((existing) => (existing.machineId === target.machineId ? target : existing))
    : [...value.targets, target],
});

export const removeAgentRoleFormTarget = (
  value: AgentRoleFormValue,
  machineId: MachineId
): AgentRoleFormValue => ({
  ...value,
  targets: value.targets.filter((target) => target.machineId !== machineId),
});

type AgentConfigCandidate = Pick<AgentConfigMeta, 'id' | 'cliType' | 'agentType' | 'name'>;

/**
 * The target a Role gets when it is added to another machine.
 *
 * The Agent Config is matched by agent type — the same agent, configured on
 * that machine — preferring one with the same name; a custom agent's type is
 * unique per config, so for those the name alone decides. The run config is
 * copied as authored: what the target agent does not support surfaces as an
 * issue in the editor before save, never silently dropped. Memory carries over
 * only when that machine has the same identity linked, because memories live on
 * the machine.
 */
export const suggestAgentRoleTarget = (input: {
  machineId: MachineId;
  source: AgentRoleTargetFormValue | undefined;
  sourceConfig: AgentConfigCandidate | undefined;
  machineConfigs: readonly AgentConfigCandidate[];
  memories: readonly MemoryBinding[];
}): AgentRoleTargetFormValue => {
  const empty = createAgentRoleTargetFormValue(input.machineId);
  const { source, sourceConfig } = input;
  if (!source || !sourceConfig) return empty;
  const sameAgent = input.machineConfigs.filter((config) =>
    sourceConfig.cliType === 'custom'
      ? config.cliType === 'custom' && config.name === sourceConfig.name
      : config.cliType === sourceConfig.cliType && config.agentType === sourceConfig.agentType
  );
  const config =
    sameAgent.find((candidate) => candidate.name === sourceConfig.name) ?? sameAgent[0];
  const memory = source.memory;
  const memoryLinked =
    memory !== undefined &&
    input.memories.some(
      (entry) => entry.providerId === memory.providerId && entry.memoryId === memory.memoryId
    );
  return {
    ...empty,
    ...(config
      ? {
          agentConfigId: config.id,
          modeId: source.modeId,
          modelId: source.modelId,
          configOptionValues: { ...source.configOptionValues },
        }
      : {}),
    ...(memoryLinked ? { memory } : {}),
  };
};

export type AgentRoleFormError =
  | 'name_required'
  | 'name_taken'
  | 'alias_taken'
  | 'machine_required'
  | 'agent_config_required';

/** Every `@` token a Role answers to: its name, plus each target's alias. */
const getAgentRoleMentionSlugs = (role: AgentRole): string[] => [
  getAgentRoleMentionSlug(role),
  ...getAgentRoleTargets(role).flatMap((target) =>
    target.alias ? [normalizeAgentRoleMentionSlug(target.alias)] : []
  ),
];

/**
 * The name is the authored label, so it carries both jobs: it is what the list
 * shows and what `@` completes. Uniqueness is therefore checked on the DERIVED
 * mention token — "Code Reviewer" and "Code-Reviewer" are the same
 * `@Code-Reviewer` — and only against the Roles this user can see. Aliases are
 * tokens too, so they join the same check. It is a readability rule, not an
 * identity one: the mention range always carries the Role id, so another
 * member's private Role neither can nor needs to be checked.
 */
export const validateAgentRoleForm = (
  value: AgentRoleFormValue,
  options: { accessibleRoles: readonly AgentRole[]; editingRoleId?: AgentRoleId | null }
): AgentRoleFormError[] => {
  const errors: AgentRoleFormError[] = [];
  const taken = new Set(
    options.accessibleRoles
      .filter((role) => role.id !== options.editingRoleId)
      .flatMap(getAgentRoleMentionSlugs)
  );
  const slug = normalizeAgentRoleMentionSlug(value.name);
  if (!slug) {
    // Covers both an empty name and one that is all punctuation the mention
    // token strips: either way there is nothing to type after `@`.
    errors.push('name_required');
  } else if (taken.has(slug)) {
    errors.push('name_taken');
  }
  if (value.targets.length > 1) {
    const own = new Set(slug ? [slug] : []);
    for (const target of value.targets) {
      const aliasSlug = normalizeAgentRoleMentionSlug(target.alias);
      if (!aliasSlug) continue;
      if (taken.has(aliasSlug) || own.has(aliasSlug)) {
        errors.push('alias_taken');
        break;
      }
      own.add(aliasSlug);
    }
  }

  if (value.targets.length === 0) errors.push('machine_required');
  if (value.targets.some((target) => !target.agentConfigId)) errors.push('agent_config_required');
  return errors;
};

/**
 * The run config a target implies.
 *
 * Runs through the shared normalizer rather than copying the fields, so the
 * authoring surface refuses exactly the option keys the reader would later
 * refuse — a Role never becomes a place a secret is stored.
 */
export const buildAgentRoleRunConfig = (target: AgentRoleTargetFormValue): AgentRoleRunConfig =>
  normalizeAgentRoleRunConfig({
    memory: target.memory,
    modeId: target.modeId ?? undefined,
    modelId: target.modelId ?? undefined,
    configOptionValues: target.configOptionValues,
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
    /**
     * Current capabilities of the active tab's target; only explicit saves
     * reconcile retired options, and only for the target the user is looking at.
     */
    selectorOptions?: AcpSelectorOptions | null;
  }
): AgentRole => {
  const { existing, ownerUserId, now } = options;
  const emoji = normalizeAgentRoleEmoji(value.emoji);
  const promptPrefix = value.promptPrefix.trim();
  const multi = value.targets.length > 1;
  // An edit keeps the stored target order — a form opened from a Role bound to
  // another machine must not reorder the row — and appends new machines.
  const order = existing ? getAgentRoleTargets(existing).map((target) => target.machineId) : [];
  const rank = (machineId: MachineId) => {
    const index = order.indexOf(machineId);
    return index < 0 ? order.length : index;
  };
  const ordered = [...value.targets].sort(
    (left, right) => rank(left.machineId) - rank(right.machineId)
  );
  const targets = ordered.map((target): AgentRoleTarget => {
    const alias = multi ? normalizeAgentRoleAlias(target.alias) : '';
    const prepared =
      target.machineId === value.activeMachineId
        ? prepareAgentRoleTargetForSave(target, options.selectorOptions)
        : target;
    return {
      machineId: target.machineId,
      agentConfigId: target.agentConfigId as AgentConfigId,
      runConfig: buildAgentRoleRunConfig(prepared),
      ...(alias ? { alias } : {}),
    };
  });
  const [first, ...additional] = targets;
  if (!first) throw new Error('An Agent Role needs at least one machine target.');
  const next = withAgentRoleTargets(
    {
      v: AGENT_ROLE_VERSION,
      id: existing?.id ?? options.createId(),
      ownerUserId: existing?.ownerUserId ?? ownerUserId,
      visibility: value.shareWithWorkspace ? 'workspace' : 'private',
      name: value.name.trim(),
      description: normalizeAgentRoleDescription(value.description),
      ...(emoji ? { emoji } : {}),
      ...first,
      ...(promptPrefix ? { promptPrefix } : {}),
      revision: existing?.revision ?? 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
    },
    [first, ...additional]
  );

  if (!existing) return next;
  if (isAgentRoleContentEqual(existing, next)) return existing;
  return { ...next, revision: existing.revision + 1, updatedAt: now };
};

/** Keep the current editor's options on explicit save, without rewriting a draft on open. */
const prepareAgentRoleTargetForSave = (
  value: AgentRoleTargetFormValue,
  selectorOptions: AcpSelectorOptions | null | undefined
): AgentRoleTargetFormValue => {
  // Provisional static defaults cannot establish that a stored option was removed.
  if (selectorOptions?.capabilityAuthority !== 'authoritative') return value;
  return {
    ...value,
    configOptionValues: Object.fromEntries(
      selectAuthorableAgentRoleConfigOptions(selectorOptions.configOptionSelectors).map(
        (selector) => [
          selector.configId,
          isConfigOptionValueValid(selector, value.configOptionValues[selector.configId])
            ? value.configOptionValues[selector.configId]
            : selector.currentValue,
        ]
      )
    ),
  };
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
 */
export const applyAgentRoleRunConfigDefaults = (
  value: AgentRoleTargetFormValue,
  selectorOptions: AcpSelectorOptions | null
): AgentRoleTargetFormValue => {
  if (!selectorOptions || selectorOptions.capabilityAuthority === 'unavailable') return value;

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

export const carryAgentRoleOptionsToModel = (
  values: AgentRoleTargetFormValue['configOptionValues'],
  outgoing: readonly AcpConfigOptionSelector[],
  incoming: readonly AcpConfigOptionSelector[]
): AgentRoleTargetFormValue['configOptionValues'] =>
  Object.fromEntries(
    Object.entries(values).filter(([configId, value]) => {
      if (!outgoing.some((selector) => selector.configId === configId)) return true;
      const next = incoming.find((selector) => selector.configId === configId);
      return next !== undefined && isConfigOptionValueValid(next, value);
    })
  );

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
 * Opening the editor reports rather than repairs. Explicit Save reconciles option
 * controls; a missing model or mode stays pinned until the owner selects a new one.
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
