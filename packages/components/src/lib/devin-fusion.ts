import type { AcpModelConfigOptionsSource, AcpModelControls } from '@lody/shared';
import {
  DEVIN_SPEED_CONFIG_ID,
  DEVIN_SPEED_FAST_VALUE,
  isThoughtLevelSelector,
  type AcpConfigOptionSelector,
  type AcpConfigOptionValue,
  type AcpSelectConfigOptionSelector,
} from '@/components/shared/acp-selector-options';

/**
 * Devin's Fusion models: one advertised model value per lead+sidekick pair.
 *
 * Devin's ACP exposes no independent Lead/Sidekick pickers — `configOptions`
 * carries a flat `model` select whose `fusion-<lead>-sidekick-<sidekick>`
 * values each name a pair, and `thought_level`/`speed` then describe that
 * pair's own controls. This module parses that list into a catalog and turns a
 * builder draft back into composer edits. It never constructs a model value:
 * every applied value is one Devin advertised.
 */

export type FusionModelOption = { value: string; label: string; disabled?: boolean };
export type FusionLead = { key: string; label: string };
export type FusionSidekick = { key: string; label: string };
export type FusionPair = {
  modelValue: string;
  leadKey: string;
  sidekickKey: string;
  label: string;
};
export type FusionCatalog = {
  leads: FusionLead[];
  sidekicks: FusionSidekick[];
  pairs: FusionPair[];
};

const FUSION_VALUE_RE = /^fusion-([a-z0-9]+(?:-[a-z0-9]+)*?)-sidekick-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const FUSION_LABEL_RE = /^Fusion \((.+?) \+ (.+)\)$/;
const EFFORT_WORDS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const alnum = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A lead's display name drops its trailing default-effort word (and an optional
 * " Thinking") only when the value token's last segment is an effort word and
 * the name's last word equals it — `GPT-6 Astra High Thinking` under
 * `gpt-6-astra-high` becomes `GPT-6 Astra`. `XHigh`/`X-High` ≡ `xhigh`.
 */
const stripLeadEffort = (leadToken: string, leadPart: string): string => {
  const lastSegment = leadToken.split('-').at(-1) ?? '';
  if (!EFFORT_WORDS.has(lastSegment)) return leadPart;
  const withoutThinking = /^(.*?)\s+Thinking$/.exec(leadPart)?.[1] ?? leadPart;
  const words = /^(.*?)\s+(\S+)$/.exec(withoutThinking);
  if (!words || alnum(words[2]) !== lastSegment) return leadPart;
  return words[1];
};

export const parseFusionCatalog = (options: readonly FusionModelOption[]): FusionCatalog | null => {
  const leads: FusionLead[] = [];
  const leadIndex = new Map<string, FusionLead>();
  const sidekicks: FusionSidekick[] = [];
  const sidekickIndex = new Map<string, FusionSidekick>();
  const pairs: FusionPair[] = [];
  // Two-pass: a stripped label colliding with another lead's label (stripped
  // or not) reverts every lead involved to its full lead part, so collect
  // candidates first and assign labels at the end.
  const candidates: { lead: FusionLead; label: string }[] = [];
  for (const option of options) {
    if (option.disabled) continue;
    const valueMatch = FUSION_VALUE_RE.exec(option.value);
    const labelMatch = FUSION_LABEL_RE.exec(option.label);
    if (!valueMatch || !labelMatch) continue;
    const [, leadKey, sidekickKey] = valueMatch;
    const [, leadPart, sidekickPart] = labelMatch;
    let lead = leadIndex.get(leadKey);
    if (!lead) {
      lead = { key: leadKey, label: leadPart };
      leadIndex.set(leadKey, lead);
      leads.push(lead);
      candidates.push({ lead, label: stripLeadEffort(leadKey, leadPart) });
    }
    if (!sidekickIndex.has(sidekickKey)) {
      const sidekick: FusionSidekick = { key: sidekickKey, label: sidekickPart };
      sidekickIndex.set(sidekickKey, sidekick);
      sidekicks.push(sidekick);
    }
    pairs.push({ modelValue: option.value, leadKey, sidekickKey, label: option.label });
  }
  if (pairs.length === 0) return null;
  for (const candidate of candidates) {
    const collides = candidates.some(
      (other) => other !== candidate && other.label === candidate.label
    );
    candidate.lead.label = collides ? candidate.lead.label : candidate.label;
  }
  return { leads, sidekicks, pairs };
};

export const findFusionPair = (
  catalog: FusionCatalog,
  leadKey: string,
  sidekickKey: string
): FusionPair | undefined =>
  catalog.pairs.find((pair) => pair.leadKey === leadKey && pair.sidekickKey === sidekickKey);

export const findFusionPairForModel = (
  catalog: FusionCatalog,
  modelValue: string | null | undefined
): FusionPair | undefined => catalog.pairs.find((pair) => pair.modelValue === modelValue);

export type FusionEffortControl = {
  configId: string;
  options: { value: string; label: string }[];
  defaultValue: string;
};
export type FusionFastControl = { configId: string; onValue: string; offValue: string };
export type FusionControls = {
  effort: FusionEffortControl | null;
  fast: FusionFastControl | null;
  /**
   * True when the adapter declares a control the current options cannot
   * express — e.g. the snapshot model is `adaptive` so its selectors carry no
   * `thought_level`/`speed` while the pair's declaration says it has both.
   * Unknown never claims Devin lacks the control.
   */
  unknown: { effort: boolean; fast: boolean };
};
export type FusionControlsResolver = (modelValue: string) => FusionControls;

const NO_CONTROLS: FusionControls = {
  effort: null,
  fast: null,
  unknown: { effort: true, fast: true },
};

/**
 * Reads one pair's `thought_level`/`speed` selectors as advertised for its
 * model. `borrowed` means the list belongs to another model — the controls are
 * unknown rather than this pair's. The adapter's per-model declaration
 * distinguishes "declared but not expressible here" from "absent".
 */
export const resolveFusionControls = (
  selectors: readonly AcpConfigOptionSelector[],
  source: AcpModelConfigOptionsSource | undefined,
  declared?: AcpModelControls
): FusionControls => {
  if (source === 'borrowed') {
    return NO_CONTROLS;
  }
  const effortSelector = selectors.find(
    (selector): selector is AcpSelectConfigOptionSelector =>
      selector.type === 'select' && isThoughtLevelSelector(selector) && selector.options.length >= 1
  );
  const effortValues = effortSelector?.options.map((option) => option.value) ?? [];
  const effort: FusionEffortControl | null = effortSelector
    ? {
        configId: effortSelector.configId,
        options: effortSelector.options.map((option) => ({
          value: option.value,
          label: option.label,
        })),
        defaultValue: effortValues.includes(effortSelector.currentValue)
          ? effortSelector.currentValue
          : (effortValues[0] ?? ''),
      }
    : null;
  const speedSelector = selectors.find(
    (selector): selector is AcpSelectConfigOptionSelector =>
      selector.type === 'select' &&
      selector.configId === DEVIN_SPEED_CONFIG_ID &&
      selector.options.some((option) => option.value === DEVIN_SPEED_FAST_VALUE) &&
      selector.options.some((option) => option.value !== DEVIN_SPEED_FAST_VALUE)
  );
  const speedOffValue = speedSelector?.options.find(
    (option) => option.value !== DEVIN_SPEED_FAST_VALUE
  )?.value;
  const fast: FusionFastControl | null =
    speedSelector && speedOffValue !== undefined
      ? {
          configId: speedSelector.configId,
          onValue: DEVIN_SPEED_FAST_VALUE,
          offValue: speedOffValue,
        }
      : null;
  return {
    effort,
    fast,
    unknown: {
      effort: !effort && (declared?.effortValues?.length ?? 0) > 0,
      fast: !fast && declared?.fastMode === true,
    },
  };
};

export type FusionDraft = {
  leadKey: string;
  sidekickKey: string;
  effort: string | null;
  fast: boolean;
};
export type FusionNotice = { kind: 'effortReset'; from: string; to: string } | { kind: 'fastOff' };

const draftEffort = (
  effort: FusionEffortControl | null,
  current: AcpConfigOptionValue | undefined
): string | null => {
  if (!effort) return null;
  return typeof current === 'string' && effort.options.some((option) => option.value === current)
    ? current
    : effort.defaultValue;
};

const firstPair = (catalog: FusionCatalog): FusionPair => {
  const first = catalog.pairs[0];
  if (!first) throw new Error('fusion catalog has no pairs');
  return first;
};

export const initialFusionDraft = (
  catalog: FusionCatalog,
  current: {
    modelId: string | null;
    configOptionValues: Record<string, AcpConfigOptionValue>;
  },
  controlsFor: FusionControlsResolver
): FusionDraft => {
  const pair = findFusionPairForModel(catalog, current.modelId) ?? firstPair(catalog);
  const controls = controlsFor(pair.modelValue);
  const isCurrent = pair.modelValue === current.modelId;
  return {
    leadKey: pair.leadKey,
    sidekickKey: pair.sidekickKey,
    effort: draftEffort(
      controls.effort,
      isCurrent ? current.configOptionValues[controls.effort?.configId ?? ''] : undefined
    ),
    fast: isCurrent
      ? controls.fast != null &&
        current.configOptionValues[controls.fast.configId] === controls.fast.onValue
      : false,
  };
};

export const changeFusionPair = (
  draft: FusionDraft,
  next: { leadKey?: string; sidekickKey?: string },
  catalog: FusionCatalog,
  controlsFor: FusionControlsResolver
): { draft: FusionDraft; notices: FusionNotice[] } => {
  const leadKey = next.leadKey ?? draft.leadKey;
  const sidekickKey = next.sidekickKey ?? draft.sidekickKey;
  const pair = findFusionPair(catalog, leadKey, sidekickKey);
  if (!pair) {
    // Unadvertised combinations keep the rest of the draft but cannot apply.
    return { draft: { ...draft, leadKey, sidekickKey }, notices: [] };
  }
  const controls = controlsFor(pair.modelValue);
  const effortLabel = (control: FusionEffortControl | null | undefined, value: string): string =>
    control?.options.find((option) => option.value === value)?.label ?? value;
  const previousPair = findFusionPair(catalog, draft.leadKey, draft.sidekickKey);
  const previousEffort = previousPair ? controlsFor(previousPair.modelValue).effort : null;
  const notices: FusionNotice[] = [];
  let effort = draft.effort;
  if (!controls.effort) {
    effort = null;
  } else if (!effort || !controls.effort.options.some((option) => option.value === effort)) {
    const nextEffort = controls.effort.defaultValue;
    if (effort != null) {
      notices.push({
        kind: 'effortReset',
        from: effortLabel(previousEffort, effort),
        to: effortLabel(controls.effort, nextEffort),
      });
    }
    effort = nextEffort;
  }
  let fast = draft.fast;
  if (!controls.fast && fast) {
    fast = false;
    notices.push({ kind: 'fastOff' });
  }
  return { draft: { leadKey, sidekickKey, effort, fast }, notices };
};

export type FusionApplyEdits = {
  modelValue: string;
  configOptionValues: Record<string, AcpConfigOptionValue>;
};

export const fusionApplyEdits = (
  draft: FusionDraft,
  catalog: FusionCatalog,
  controlsFor: FusionControlsResolver
): FusionApplyEdits | null => {
  const pair = findFusionPair(catalog, draft.leadKey, draft.sidekickKey);
  if (!pair) return null;
  const controls = controlsFor(pair.modelValue);
  const configOptionValues: Record<string, AcpConfigOptionValue> = {};
  if (controls.effort) {
    configOptionValues[controls.effort.configId] = draft.effort ?? controls.effort.defaultValue;
  }
  if (controls.fast) {
    configOptionValues[controls.fast.configId] = draft.fast
      ? controls.fast.onValue
      : controls.fast.offValue;
  }
  return { modelValue: pair.modelValue, configOptionValues };
};

export const isFusionConfigConfirmed = (
  edits: FusionApplyEdits,
  runtime:
    | {
        modelId?: string | null;
        configOptionValues?: Record<string, AcpConfigOptionValue>;
      }
    | null
    | undefined
): boolean =>
  runtime != null &&
  runtime.modelId === edits.modelValue &&
  Object.entries(edits.configOptionValues).every(
    ([configId, value]) => runtime.configOptionValues?.[configId] === value
  );
