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
  configId: 'plan_mode',
  label: 'Collaboration mode',
  category: 'plan_mode',
  type: 'boolean',
  currentValue: false,
  options: [],
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

const mapIds = (value: OrderedAcpConfigOptionSelectors) => ({
  model: value.modelSelectors.map((selector) => selector.configId),
  thought: value.thoughtLevelSelectors.map((selector) => selector.configId),
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
      fastMode: ['fast-mode'],
      planMode: ['plan_mode'],
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
      fastMode: [],
      planMode: [],
      interactionMode: ['interaction_mode'],
      permissionMode: ['permission_mode'],
      mode: ['mode'],
      boolean: [],
      other: [],
    });
  });
});
