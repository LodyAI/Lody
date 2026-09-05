import { z } from 'zod';
import { getAgentRoleEmoji, type AgentConfigMeta, type AgentRole } from '@lody/shared';
import type { RecentRunConfigItem } from '@/components/sessions/recent-run-config-menu-group';
import {
  isConfigOptionValueValid,
  isThoughtLevelSelector,
  resolveConfigOptionValue,
  resolveOnOffConfigOptionEnabled,
  resolvePlanModeSelectorEnabled,
  type AcpConfigOptionSelector,
  type AcpConfigOptionValue,
  type AcpSelectConfigOptionSelector,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';

/**
 * "Recently used" run configurations behind `RecentRunConfigMenuGroup`.
 *
 * A record is one whole combination the user actually STARTED a chat with —
 * agent + model + every config option (reasoning, plan, fast, provider
 * selects). It is device-local by design: this is "what I ran on this machine
 * lately", not shared workspace state, so it lives in localStorage next to
 * `chat-landing-defaults.ts` and is keyed per workspace.
 *
 * Records carry BOTH the raw values needed to re-apply the combination and the
 * labels needed to render it. The labels are a snapshot: a recent entry may
 * belong to an agent that is not currently selected, and we have that agent's
 * model/reasoning option lists only while it IS selected. A relabeled model
 * therefore keeps its old label in the list until the combination is used
 * again — which beats rendering a raw id or hiding the row entirely.
 */

export const RECENT_RUN_CONFIGS_KEY = 'lody:recentRunConfigs';

export const getRecentRunConfigsStorageKey = (workspaceId: string): string =>
  `${RECENT_RUN_CONFIGS_KEY}:${workspaceId}`;

/** Stored deeper than the menu shows: dropping to exactly three would let one
 * one-off run evict a combination the user alternates with every day. */
export const MAX_STORED_RECENT_RUN_CONFIGS = 12;
/** Rows in the menu. The group sits above Agent/Model/Reasoning, so it has to
 * stay short enough that the actual knobs are still the first thing seen. */
export const MAX_VISIBLE_RECENT_RUN_CONFIGS = 3;

const configOptionValueSchema = z.union([z.string(), z.boolean()]);

const recentRunConfigRecordSchema = z.object({
  agentId: z.string().min(1),
  machineId: z.string().min(1),
  /** Free-standing model id (`modelOptions`), null when the provider exposes
   * its model as a config option instead — that value rides in
   * `configOptionValues` and is applied with the rest of them. */
  modelId: z.string().nullable(),
  modelLabel: z.string().nullable(),
  reasoningLabel: z.string().nullable(),
  planOn: z.boolean(),
  fastOn: z.boolean(),
  configOptionValues: z.record(z.string(), configOptionValueSchema),
  /**
   * The Agent Role this run was started as, when it was started as one.
   *
   * A Role is one whole run configuration, so it belongs in this list like any
   * other — but it is not INTERCHANGEABLE with the same values picked by hand:
   * a Role also carries its instruction and its provenance, so the two are
   * different entries and the id is part of the identity key.
   */
  agentRoleId: z.string().nullable().optional(),
  usedAt: z.number(),
});

export type RecentRunConfigRecord = z.infer<typeof recentRunConfigRecordSchema>;
export type RecentRunConfigInput = Omit<RecentRunConfigRecord, 'usedAt'>;

const recentRunConfigsSchema = z.array(recentRunConfigRecordSchema);

/** Drop values the selection state carries as `undefined` (a selector with no
 * resolved value yet) so they never reach storage or the identity key. */
export const sanitizeConfigOptionValues = (
  values: Record<string, AcpConfigOptionValue | undefined> | undefined
): Record<string, AcpConfigOptionValue> => {
  const next: Record<string, AcpConfigOptionValue> = {};
  for (const [configId, value] of Object.entries(values ?? {})) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      next[configId] = value;
    }
  }
  return next;
};

const configOptionSignature = (values: Record<string, AcpConfigOptionValue>): string =>
  JSON.stringify(
    Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  );

/**
 * Identity of a whole combination. Two runs are "the same configuration" only
 * when every knob matches, so switching one of them records a new entry rather
 * than moving the old one.
 */
export const getRecentRunConfigKey = (
  record: Pick<
    RecentRunConfigRecord,
    'agentId' | 'machineId' | 'modelId' | 'configOptionValues' | 'agentRoleId'
  >
): string =>
  [
    record.machineId,
    record.agentId,
    record.modelId ?? '',
    configOptionSignature(record.configOptionValues),
    record.agentRoleId ?? '',
  ].join('\u0000');

export type RunConfigFace = {
  modelId: string | null;
  modelLabel: string | null;
  reasoningLabel: string | null;
  planOn: boolean;
  fastOn: boolean;
};

/**
 * The run-config trigger face for a selection — the same derivation
 * `DesktopRunConfigMenu` renders, so a recorded row reads exactly like the
 * button did when the chat was started.
 */
export function describeRunConfigSelection({
  modelOptions,
  selectedModelId,
  configOptionSelectors,
  configOptionValues,
}: {
  modelOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModelId: string | null;
  configOptionSelectors: ReadonlyArray<AcpConfigOptionSelector>;
  configOptionValues: Record<string, AcpConfigOptionValue | undefined> | undefined;
}): RunConfigFace {
  const { modelSelectors, thoughtLevelSelectors, planModeSelectors, fastModeSelectors } =
    orderAcpConfigOptionSelectors([...configOptionSelectors]);
  const modelConfigSelector = modelSelectors[0];
  const pickerOptions =
    modelOptions.length > 0 ? modelOptions : (modelConfigSelector?.options ?? []);
  const effectiveModelValue =
    modelOptions.length > 0
      ? selectedModelId
      : modelConfigSelector
        ? ((resolveConfigOptionValue(
            modelConfigSelector,
            configOptionValues?.[modelConfigSelector.configId]
          ) as string) ?? null)
        : null;
  const thinkingSelector = thoughtLevelSelectors.find(
    (selector): selector is AcpSelectConfigOptionSelector => selector.type === 'select'
  );
  const thinkingValue = thinkingSelector
    ? ((resolveConfigOptionValue(
        thinkingSelector,
        configOptionValues?.[thinkingSelector.configId]
      ) as string) ?? null)
    : null;
  const planSelector = planModeSelectors[0];
  const fastSelector = fastModeSelectors[0];
  return {
    modelId: modelOptions.length > 0 ? selectedModelId : null,
    modelLabel:
      pickerOptions.find((option) => option.value === effectiveModelValue)?.label ??
      effectiveModelValue,
    reasoningLabel:
      thinkingSelector?.options.find((option) => option.value === thinkingValue)?.label ??
      thinkingValue,
    planOn: planSelector
      ? resolvePlanModeSelectorEnabled(planSelector, configOptionValues?.[planSelector.configId])
      : false,
    fastOn: fastSelector
      ? resolveOnOffConfigOptionEnabled(fastSelector, configOptionValues?.[fastSelector.configId])
      : false,
  };
}

/** Most-recent-first, deduped by combination identity, capped. Pure. */
export function appendRecentRunConfig(
  records: ReadonlyArray<RecentRunConfigRecord>,
  record: RecentRunConfigRecord
): RecentRunConfigRecord[] {
  const key = getRecentRunConfigKey(record);
  return [record, ...records.filter((entry) => getRecentRunConfigKey(entry) !== key)].slice(
    0,
    MAX_STORED_RECENT_RUN_CONFIGS
  );
}

export function readRecentRunConfigs(
  workspaceId: string | null | undefined
): RecentRunConfigRecord[] {
  if (!workspaceId) return [];
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(getRecentRunConfigsStorageKey(workspaceId));
    if (!raw) return [];
    const parsed = recentRunConfigsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function writeRecentRunConfigs(
  workspaceId: string | null | undefined,
  records: ReadonlyArray<RecentRunConfigRecord>
): void {
  if (!workspaceId) return;
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(getRecentRunConfigsStorageKey(workspaceId), JSON.stringify(records));
  } catch {
    // ignore
  }
}

/**
 * Record one started chat's configuration and return the new list, so the
 * caller can render it without re-reading storage.
 */
export function recordRecentRunConfig(
  workspaceId: string | null | undefined,
  input: RecentRunConfigInput,
  usedAt: number
): RecentRunConfigRecord[] {
  const next = appendRecentRunConfig(readRecentRunConfigs(workspaceId), { ...input, usedAt });
  writeRecentRunConfigs(workspaceId, next);
  return next;
}

/**
 * Menu rows for the records the user can actually pick right now: the agent
 * still exists in the selectable pool (so a deleted agent or an out-of-scope
 * machine drops out), and the combination is not the one already selected.
 */
export function buildRecentRunConfigItems({
  records,
  agentConfigs,
  agentRoles,
  currentKey,
  limit = MAX_VISIBLE_RECENT_RUN_CONFIGS,
}: {
  records: ReadonlyArray<RecentRunConfigRecord>;
  agentConfigs: ReadonlyArray<AgentConfigMeta>;
  /**
   * Roles the composer can run RIGHT NOW. A recorded Role entry is offered only
   * while its Role is in here: a Role never falls back, so an entry whose Role
   * was deleted, unshared, or whose machine went offline must drop out rather
   * than quietly re-running its values without it.
   */
  agentRoles?: ReadonlyArray<AgentRole>;
  currentKey: string | null;
  limit?: number;
}): RecentRunConfigItem[] {
  const configByKey = new Map(
    agentConfigs.map((config) => [`${config.machineId} ${config.id}`, config])
  );
  const roleById = new Map((agentRoles ?? []).map((role) => [role.id as string, role]));
  const items: RecentRunConfigItem[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (items.length >= limit) break;
    const key = getRecentRunConfigKey(record);
    if (key === currentKey || seen.has(key)) continue;
    const config = configByKey.get(`${record.machineId} ${record.agentId}`);
    if (!config) continue;
    const role = record.agentRoleId ? roleById.get(record.agentRoleId) : undefined;
    if (record.agentRoleId && !role) continue;
    seen.add(key);
    items.push({
      id: key,
      agent: {
        name: config.name,
        cliType: config.cliType,
        agentType: config.agentType,
        brandId: config.brandId,
        env: config.env,
      },
      // A Role names itself; the row then reads as that Role rather than as the
      // agent it happens to be bound to.
      ...(role ? { role: { name: role.name, emoji: getAgentRoleEmoji(role) } } : {}),
      modelLabel: record.modelLabel,
      reasoningLabel: record.reasoningLabel,
      planOn: record.planOn,
      fastOn: record.fastOn,
    });
  }
  return items;
}

/**
 * The config-option values of a record that are still valid for the agent's
 * current selectors. An option the provider dropped (or whose value it no
 * longer offers) is skipped rather than forced back in.
 *
 * `switchesModel` says the record also moves the model. The selectors still
 * describe the OUTGOING model, and reasoning effort is per model, so validating
 * the recorded effort against them would drop a value the incoming model does
 * offer (Grok 4.5's ladder has no `xhigh`, Grok 4.6's does). It is taken
 * verbatim instead; the selection resolution re-validates it against the
 * resolved model.
 */
export function resolveApplicableConfigOptionValues(
  record: Pick<RecentRunConfigRecord, 'configOptionValues'>,
  configOptionSelectors: ReadonlyArray<AcpConfigOptionSelector>,
  options: { switchesModel?: boolean } = {}
): Array<{ configId: string; value: AcpConfigOptionValue }> {
  const applicable: Array<{ configId: string; value: AcpConfigOptionValue }> = [];
  for (const selector of configOptionSelectors) {
    const value = record.configOptionValues[selector.configId];
    if (value === undefined) continue;
    const modelDependent = options.switchesModel === true && isThoughtLevelSelector(selector);
    if (!modelDependent && !isConfigOptionValueValid(selector, value)) continue;
    applicable.push({ configId: selector.configId, value });
  }
  return applicable;
}
