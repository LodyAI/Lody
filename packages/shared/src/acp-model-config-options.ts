import type { AcpConfigOptionSummary } from './ai';

/**
 * The option list an agent itself reported for one model.
 *
 * A capability snapshot's `configOptions` describe only the model that was
 * current when it was taken. A refresh a person asks for switches the probe
 * session to every model and records each model's own list, so selectors
 * compose the selected model's options instead of reusing another model's
 * ladder and toggles. The model selector is not stored: the snapshot owns the
 * model list.
 *
 * Most models of one agent share the same list, so a list is stored once as a
 * shape and each model points at its shape:
 * - `['acpModelConfigOptionsShape', configId, shapeId]` → {@link AcpModelConfigOptionsShape}
 * - `['acpModelConfigOptions', configId, modelId]` → {@link AcpModelConfigOptions}
 */
export type AcpModelConfigOptions = {
  version: 1;
  /** Source version of the launch inputs that produced the answer. */
  sourceVersion: string;
  /** Id of the config's shape row holding this model's list. */
  shape: string;
};

export type AcpModelConfigOptionsShape = {
  version: 1;
  configOptions: AcpConfigOptionSummary[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isConfigOptionValueSummary = (value: unknown): boolean =>
  isRecord(value) && typeof value.value === 'string' && typeof value.name === 'string';

const isConfigOptionSummary = (value: unknown): value is AcpConfigOptionSummary =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  (value.type === 'select' || value.type === 'boolean') &&
  (typeof value.currentValue === 'string' || typeof value.currentValue === 'boolean') &&
  Array.isArray(value.options) &&
  value.options.every(isConfigOptionValueSummary);

export const isAcpModelConfigOptions = (value: unknown): value is AcpModelConfigOptions =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.sourceVersion === 'string' &&
  typeof value.shape === 'string' &&
  value.shape.length > 0;

export const isAcpModelConfigOptionsShape = (value: unknown): value is AcpModelConfigOptionsShape =>
  isRecord(value) &&
  value.version === 1 &&
  Array.isArray(value.configOptions) &&
  value.configOptions.every(isConfigOptionSummary);

/**
 * A short content id for a stored list (two 32-bit FNV-1a passes over its
 * JSON). Writers still compare content before reusing an id, so a collision
 * costs a suffixed id, never another model's options.
 */
export const getAcpConfigOptionsShapeId = (
  configOptions: readonly AcpConfigOptionSummary[]
): string => {
  const text = JSON.stringify(configOptions);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
};

const isModelSelector = (option: AcpConfigOptionSummary): boolean =>
  option.category === 'model' && option.type === 'select';

/** The model an option list was reported for: its model selector's current value. */
export const getAcpConfigOptionsModelId = (
  configOptions: readonly AcpConfigOptionSummary[] | undefined
): string | undefined => {
  const value = configOptions?.find(isModelSelector)?.currentValue;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** The part of a reported list that is stored per model: everything but the model selector. */
export const toAcpModelConfigOptions = (
  configOptions: readonly AcpConfigOptionSummary[]
): AcpConfigOptionSummary[] => configOptions.filter((option) => !isModelSelector(option));

/**
 * Compares what an option list offers, ignoring current values. Selecting a
 * different effort changes only `currentValue`, which must not cost a write.
 */
export const getAcpConfigOptionStructureKey = (
  configOptions: readonly AcpConfigOptionSummary[]
): string =>
  JSON.stringify(
    configOptions.map((option) => [
      option.id,
      option.name,
      option.description ?? null,
      option.category ?? null,
      option.type,
      option.options.map((choice) => [
        choice.value,
        choice.name,
        choice.description ?? null,
        choice.group ?? null,
      ]),
    ])
  );

/**
 * Where the selected model's options came from:
 * - `snapshot`: the snapshot describes this model, or no model is selected;
 * - `observed`: the agent reported this model's own list;
 * - `borrowed`: neither, so the snapshot's options belong to another model.
 */
export type AcpModelConfigOptionsSource = 'snapshot' | 'observed' | 'borrowed';

export type ResolvedAcpModelConfigOptions = {
  configOptions: AcpConfigOptionSummary[] | undefined;
  source: AcpModelConfigOptionsSource;
};

/**
 * The options to show and validate for `modelId`. The snapshot keeps its model
 * selector and order; every other option comes from the model's observed list,
 * so a control that model lacks disappears and one it adds is appended.
 */
export const resolveAcpConfigOptionsForModel = (
  snapshot: AcpConfigOptionSummary[] | undefined,
  observedByModel: Record<string, AcpConfigOptionSummary[]> | undefined,
  modelId: string | null | undefined
): ResolvedAcpModelConfigOptions => {
  const snapshotModelId = getAcpConfigOptionsModelId(snapshot);
  if (!modelId || modelId === snapshotModelId) {
    return { configOptions: snapshot, source: 'snapshot' };
  }
  const observed = observedByModel?.[modelId];
  if (!observed) {
    return { configOptions: snapshot, source: 'borrowed' };
  }
  const observedById = new Map(observed.map((option) => [option.id, option]));
  const composed: AcpConfigOptionSummary[] = [];
  const used = new Set<string>();
  for (const option of snapshot ?? []) {
    if (isModelSelector(option)) {
      composed.push(option);
      continue;
    }
    const replacement = observedById.get(option.id);
    if (replacement) {
      composed.push(replacement);
      used.add(option.id);
    }
  }
  for (const option of observed) {
    if (!used.has(option.id) && !isModelSelector(option)) composed.push(option);
  }
  return { configOptions: composed, source: 'observed' };
};
