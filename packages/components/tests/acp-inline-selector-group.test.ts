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
      makeSelector('plan-mode', 'Plan Mode'),
      makeSelector('safe_mode', 'Safe Mode', undefined, 'boolean'),
      makeSelector('temperature', 'Temperature'),
    ];

    expect(mapIds(orderAcpConfigOptionSelectors(selectors))).toEqual({
      model: ['model'],
      thought: ['reasoning_effort'],
      fastMode: ['fast-mode'],
      planMode: ['plan-mode'],
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
      mode: ['mode'],
      boolean: [],
      other: [],
    });
  });

  it('routes on/off select fast options into the fast mode bucket', () => {
    const selectors = [
      makeOnOffSelector('fast', 'Fast'),
      makeOnOffSelector('fast_mode', 'Fast Mode'),
      makeSelector('temperature', 'Temperature'),
    ];

    expect(mapIds(orderAcpConfigOptionSelectors(selectors))).toEqual({
      model: [],
      thought: [],
      fastMode: ['fast', 'fast_mode'],
      planMode: [],
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
      mode: ['custom_mode'],
      boolean: [],
      other: [],
    });
  });
});
