import { describe, expect, it } from 'vitest';
import { parseSessionNotification } from '@lody/shared';
import {
  getAcpRuntimeConfigPatch,
  getAcpRuntimeConfigPatchFromOptions,
  mergeAcpRuntimeConfigUpdates,
} from './runtime-config';

describe('ACP runtime config projection', () => {
  it('projects supported current values and derives model and mode fields', () => {
    const notification = parseSessionNotification({
      sessionId: 'acp-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          { id: 'model', category: 'model', type: 'select', currentValue: 'gpt-5.6-sol' },
          { id: 'permission', category: 'mode', type: 'select', currentValue: 'default' },
          {
            id: 'collaboration_mode',
            category: 'collaboration_mode',
            type: 'select',
            currentValue: 'default',
          },
          { id: 'fast_mode', type: 'boolean', currentValue: true },
          { id: 'agent', type: 'select', currentValue: 'unsupported' },
          { id: 'malformed', type: 'select', currentValue: 42 },
        ],
      },
    });

    expect(getAcpRuntimeConfigPatch(notification)).toEqual({
      acpSessionId: 'acp-1',
      modeId: 'default',
      modelId: 'gpt-5.6-sol',
      configOptionValues: {
        model: 'gpt-5.6-sol',
        permission: 'default',
        collaboration_mode: 'default',
        fast_mode: true,
      },
    });
  });

  it('folds notifications in wire order', () => {
    const configUpdate = parseSessionNotification({
      sessionId: 'acp-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          { id: 'permission', category: 'mode', type: 'select', currentValue: 'plan' },
          { id: 'reasoning_effort', type: 'select', currentValue: 'low' },
        ],
      },
    });
    const modeUpdate = parseSessionNotification({
      sessionId: 'acp-1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
    });

    expect(mergeAcpRuntimeConfigUpdates([configUpdate, modeUpdate])).toEqual({
      acpSessionId: 'acp-1',
      modeId: 'default',
      configOptionValues: { permission: 'plan', reasoning_effort: 'low' },
    });
  });

  it('projects the authoritative config options returned by an ACP request', () => {
    expect(
      getAcpRuntimeConfigPatchFromOptions('acp-response' as never, [
        { id: 'model', category: 'model', type: 'select', currentValue: 'canonical-model' },
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
        },
      ])
    ).toEqual({
      acpSessionId: 'acp-response',
      modelId: 'canonical-model',
      configOptionValues: {
        model: 'canonical-model',
        reasoning_effort: 'medium',
      },
    });
  });

  it('drops sensitive ids and unsupported option types before building a durable patch', () => {
    expect(
      getAcpRuntimeConfigPatchFromOptions('acp-sensitive' as never, [
        { id: 'api_token', type: 'select', currentValue: 'secret-value' },
        { id: 'password', type: 'boolean', currentValue: true },
        { id: 'safe_select', type: 'select', currentValue: 'visible' },
        { id: 'safe_toggle', type: 'boolean', currentValue: false },
        { id: 'future_object', type: 'object', currentValue: 'serialized-secret' },
        { id: 'mismatched_boolean', type: 'boolean', currentValue: 'true' },
      ])
    ).toEqual({
      acpSessionId: 'acp-sensitive',
      configOptionValues: {
        safe_select: 'visible',
        safe_toggle: false,
      },
    });
  });
});
