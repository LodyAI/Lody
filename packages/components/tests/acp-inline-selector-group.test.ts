import { describe, expect, it } from 'vitest';

import {
  orderAcpConfigOptionSelectors,
  type OrderedAcpConfigOptionSelectors,
} from '../src/lib/acp-selector-order';
import type { AcpConfigOptionSelector } from '../src/components/shared/acp-selector-options';

const makeSelector = (
  configId: string,
  label: string,
  category?: string,
  type: AcpConfigOptionSelector['type'] = 'select'
): AcpConfigOptionSelector => {
  if (type === 'boolean') {
    return {
      configId,
      label,
      category,
      type,
      currentValue: true,
      options: [],
    };
  }
  return {
    configId,
    label,
    category,
    type,
    currentValue: 'current',
    options: [{ value: 'current', label: 'Current' }],
  };
};

/* Codex's one and only plan-mode shape: a select over `default` / `plan`. */
const makeCollaborationModeSelector = (): AcpConfigOptionSelector => ({
  configId: 'collaboration_mode',
  label: 'Collaboration mode',
  category: 'collaboration_mode',
  type: 'select',
  currentValue: 'default',
  options: [
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
  ],
});

const makeOnOffSelector = (configId: string, label: string): AcpConfigOptionSelector => ({
  configId,
  label,
  type: 'select',
  currentValue: 'on',
  options: [
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ],
});

const makeToggleSelect = (
  configId: string,
  values: readonly [string, string],
  category?: string
): AcpConfigOptionSelector => ({
  configId,
  label: configId,
  category,
  type: 'select',
  currentValue: values[0],
  options: [
    { value: values[0], label: values[0] },
    { value: values[1], label: values[1] },
  ],
});

const makeMultiSelect = (
  configId: string,
  values: readonly string[],
  category?: string
): AcpConfigOptionSelector => ({
  configId,
  label: configId,
  category,
  type: 'select',
  currentValue: values[0] ?? '',
  options: values.map((value) => ({ value, label: value })),
});

const mapIds = (value: OrderedAcpConfigOptionSelectors) => ({
  model: value.modelSelectors.map((selector) => selector.configId),
  thought: value.thoughtLevelSelectors.map((selector) => selector.configId),
  thoughtToggle: value.thoughtToggleSelectors.map((selector) => selector.configId),
  fastMode: value.fastModeSelectors.map((selector) => selector.configId),
  planMode: value.planModeSelectors.map((selector) => selector.configId),
  interactionMode: value.interactionModeSelectors.map((selector) => selector.configId),
  permissionMode: value.permissionModeSelectors.map((selector) => selector.configId),
  mode: value.modeSelectors.map((selector) => selector.configId),
  other: value.otherSelectors.map((selector) => selector.configId),
  boolean: value.booleanSelectors.map((selector) => selector.configId),
});

describe('orderAcpConfigOptionSelectors', () => {
  it('groups selectors into model, think level, fast mode, boolean, mode, and other buckets', () => {
    const selectors = [
      makeSelector('verbosity', 'Verbosity'),
      makeSelector('model', 'Model', 'model'),
      makeSelector('reasoning_effort', 'Think level', 'thought_level'),
      makeSelector('mode', 'Mode', 'mode'),
      makeSelector('fast-mode', 'Fast Mode', undefined, 'boolean'),
      makeCollaborationModeSelector(),
      makeSelector('safe_mode', 'Safe Mode', undefined, 'boolean'),
      makeSelector('temperature', 'Temperature'),
    ];

    expect(mapIds(orderAcpConfigOptionSelectors(selectors))).toEqual({
      model: ['model'],
      thought: ['reasoning_effort'],
      thoughtToggle: [],
      fastMode: ['fast-mode'],
      planMode: ['collaboration_mode'],
      interactionMode: [],
      permissionMode: [],
      mode: ['mode'],
      boolean: ['safe_mode'],
      other: ['verbosity', 'temperature'],
    });
  });

  it("routes Claude Code's `fast` option into the fast mode bucket", () => {
    const selectors = [
      makeSelector('fast', 'Fast', undefined, 'boolean'),
      makeSelector('mode', 'Mode', 'mode'),
    ];

    expect(mapIds(orderAcpConfigOptionSelectors(selectors))).toEqual({
      model: [],
      thought: [],
      thoughtToggle: [],
      fastMode: ['fast'],
      planMode: [],
      interactionMode: [],
      permissionMode: [],
      mode: ['mode'],
      boolean: [],
      other: [],
    });
  });

  it('routes on/off select fast options into the fast mode bucket', () => {
    const selectors = [
      makeOnOffSelector('fast', 'Fast'),
      makeSelector('temperature', 'Temperature'),
    ];

    expect(mapIds(orderAcpConfigOptionSelectors(selectors))).toEqual({
      model: [],
      thought: [],
      thoughtToggle: [],
      fastMode: ['fast'],
      planMode: [],
      interactionMode: [],
      permissionMode: [],
      mode: [],
      boolean: [],
      other: ['temperature'],
    });
  });

  it('recognizes reasoning_effort as think level even without a category', () => {
    const selectors = [
      makeSelector('reasoning_effort', 'Think level'),
      makeSelector('custom_mode', 'Mode', 'mode'),
    ];

    expect(mapIds(orderAcpConfigOptionSelectors(selectors))).toEqual({
      model: [],
      thought: ['reasoning_effort'],
      thoughtToggle: [],
      fastMode: [],
      planMode: [],
      interactionMode: [],
      permissionMode: [],
      mode: ['custom_mode'],
      boolean: [],
      other: [],
    });
  });

  it('separates Grok interaction and permission selectors from legacy modes', () => {
    const selectors = [
      makeSelector('interaction_mode', 'Interaction mode', 'mode'),
      makeSelector('permission_mode', 'Permission mode', '_permission'),
      makeSelector('mode', 'Legacy permission mode', 'mode'),
    ];

    expect(mapIds(orderAcpConfigOptionSelectors(selectors))).toEqual({
      model: [],
      thought: [],
      thoughtToggle: [],
      fastMode: [],
      planMode: [],
      interactionMode: ['interaction_mode'],
      permissionMode: ['permission_mode'],
      mode: ['mode'],
      boolean: [],
      other: [],
    });
  });

  it('splits Cursor thinking (true/false) from multi-level effort on the same list', () => {
    const selectors = [
      makeToggleSelect('thinking', ['false', 'true'], 'thought_level'),
      makeMultiSelect('effort', ['low', 'high'], 'thought_level'),
    ];

    expect(mapIds(orderAcpConfigOptionSelectors(selectors))).toEqual({
      model: [],
      thought: ['effort'],
      thoughtToggle: ['thinking'],
      fastMode: [],
      planMode: [],
      interactionMode: [],
      permissionMode: [],
      mode: [],
      boolean: [],
      other: [],
    });
  });

  it('routes boolean and Kimi off/on thinking to the toggle bucket', () => {
    expect(
      mapIds(
        orderAcpConfigOptionSelectors([
          makeSelector('thinking', 'Thinking', 'thought_level', 'boolean'),
        ])
      ).thoughtToggle
    ).toEqual(['thinking']);
    expect(
      mapIds(
        orderAcpConfigOptionSelectors([makeToggleSelect('thinking', ['off', 'on'], 'thought_level')])
      ).thoughtToggle
    ).toEqual(['thinking']);
  });

  it('keeps Kimi multi-level thinking and id-based reasoning_effort in the level bucket', () => {
    expect(
      mapIds(
        orderAcpConfigOptionSelectors([
          makeMultiSelect('thinking', ['off', 'low', 'medium', 'high'], 'thought_level'),
        ])
      ).thought
    ).toEqual(['thinking']);
    expect(
      mapIds(
        orderAcpConfigOptionSelectors([
          makeMultiSelect('reasoning_effort', ['low', 'medium', 'high']),
        ])
      ).thought
    ).toEqual(['reasoning_effort']);
  });

  it('leaves every other bucket unchanged for a mixed list that also has a thought toggle', () => {
    const selectors = [
      makeSelector('verbosity', 'Verbosity'),
      makeSelector('model', 'Model', 'model'),
      makeToggleSelect('thinking', ['false', 'true'], 'thought_level'),
      makeMultiSelect('effort', ['low', 'medium', 'high'], 'thought_level'),
      makeSelector('mode', 'Mode', 'mode'),
      makeSelector('permission_mode', 'Permission mode', '_permission'),
      makeSelector('fast-mode', 'Fast Mode', undefined, 'boolean'),
      makeCollaborationModeSelector(),
      makeSelector('safe_mode', 'Safe Mode', undefined, 'boolean'),
      makeSelector('temperature', 'Temperature'),
    ];

    expect(mapIds(orderAcpConfigOptionSelectors(selectors))).toEqual({
      model: ['model'],
      thought: ['effort'],
      thoughtToggle: ['thinking'],
      fastMode: ['fast-mode'],
      planMode: ['collaboration_mode'],
      interactionMode: [],
      permissionMode: ['permission_mode'],
      mode: ['mode'],
      boolean: ['safe_mode'],
      other: ['verbosity', 'temperature'],
    });
  });
});
