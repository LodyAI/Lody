import { describe, expect, it } from 'vitest';
import { buildExecutionTurnConfigOverrides } from '../src/lib/execution-turn-config';

describe('execution turn config', () => {
  it('freezes Codex execution as Default without changing other option values', () => {
    expect(
      buildExecutionTurnConfigOverrides({
        selectedModeId: null,
        defaultModeId: null,
        modeOptions: [],
        configOptionSelectors: [],
        configOptionValues: {
          collaboration_mode: 'plan',
          reasoning_effort: 'high',
          'fast-mode': true,
        },
      })
    ).toEqual({
      modeIdOverride: null,
      configOptionValuesOverride: {
        collaboration_mode: 'default',
        reasoning_effort: 'high',
        'fast-mode': true,
      },
    });
  });

  it('freezes a legacy Plan mode to the configured non-Plan default', () => {
    expect(
      buildExecutionTurnConfigOverrides({
        selectedModeId: 'plan',
        defaultModeId: 'accept-edits',
        modeOptions: [{ value: 'plan' }, { value: 'accept-edits' }],
        configOptionSelectors: [],
        configOptionValues: { reasoning_effort: 'low' },
      })
    ).toEqual({
      modeIdOverride: 'accept-edits',
      configOptionValuesOverride: { reasoning_effort: 'low' },
    });
  });

  it('uses the first advertised non-Plan mode when the reported default is Plan', () => {
    expect(
      buildExecutionTurnConfigOverrides({
        selectedModeId: 'plan',
        defaultModeId: 'plan',
        modeOptions: [{ value: 'plan' }, { value: 'default' }],
        configOptionSelectors: [],
        configOptionValues: {},
      }).modeIdOverride
    ).toBe('default');
  });

  it('does not invent a mode when the agent advertises no execution destination', () => {
    expect(
      buildExecutionTurnConfigOverrides({
        selectedModeId: 'plan',
        defaultModeId: 'plan',
        modeOptions: [{ value: 'plan' }],
        configOptionSelectors: [],
        configOptionValues: {},
      }).modeIdOverride
    ).toBe('plan');
  });

  it('uses the advertised Plan current value before the local map is seeded', () => {
    expect(
      buildExecutionTurnConfigOverrides({
        selectedModeId: null,
        defaultModeId: null,
        modeOptions: [],
        configOptionSelectors: [
          {
            configId: 'collaboration_mode',
            category: 'collaboration_mode',
            type: 'select',
            currentValue: 'plan',
            options: [{ value: 'default' }, { value: 'plan' }],
          },
        ],
        configOptionValues: { reasoning_effort: 'low' },
      }).configOptionValuesOverride
    ).toEqual({ collaboration_mode: 'default', reasoning_effort: 'low' });
  });
});
