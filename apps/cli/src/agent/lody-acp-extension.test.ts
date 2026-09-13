import { describe, expect, it } from 'vitest';
import { LODY_EXTENSION_METHODS } from 'acp-extension-core';
import type { RequestPermissionRequest, SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  getBuiltinToolPermissionOutcome,
  parseRateLimitsSnapshot,
  parseLodyExtensionMessage,
} from './lody-acp-extension';

describe('Core usage accounting boundary', () => {
  it('preserves optional delta separately from cumulative totals and rejects invalid buckets', () => {
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30 };
    const params = {
      sessionId: 's',
      usage,
      modelUsage: { model: { ...usage, inputTokens: 300 } },
      delta: { usage, modelUsage: { model: usage } },
    };
    const parse = (value: Record<string, unknown>) =>
      parseLodyExtensionMessage({
        method: LODY_EXTENSION_METHODS.sessionUsageUpdate,
        params: value,
        sessionId: 's',
        provider: 'grok',
      });
    expect(parse(params)).toEqual({ type: 'usage', update: params });
    const { delta, ...legacy } = params;
    expect(parse(legacy)).toEqual({ type: 'usage', update: legacy });
    expect(() =>
      parse({ ...params, delta: { ...delta, usage: { ...usage, inputTokens: -1 } } })
    ).toThrow();
  });
});

describe('Grok TUI permission compatibility', () => {
  const request: RequestPermissionRequest = {
    sessionId: 'grok-session',
    toolCall: { toolCallId: 'tool', title: 'Execute', kind: 'execute' },
    options: [
      { kind: 'allow_always', optionId: 'lasting-grant', name: 'Always allow' },
      { kind: 'allow_once', optionId: 'this-call', name: 'Allow once' },
    ],
  };
  const configOptions = (currentValue: string): SessionConfigOption[] => [
    {
      id: 'permission_mode',
      name: 'Permissions',
      type: 'select',
      category: '_permission',
      currentValue,
      options: [],
    },
  ];
  const args = {
    agentConfig: { cliType: 'builtin' as const, agentType: 'grok' },
    configOptions: configOptions('always-approve'),
    request,
    pending: false,
  };

  it('grants only this call, independent of option order or labels', () => {
    expect(getBuiltinToolPermissionOutcome(args)).toEqual({
      outcome: 'selected',
      optionId: 'this-call',
    });
  });

  it.each(['ask', 'auto', 'dontAsk', 'yolo', 'agent-full-access'])(
    'keeps %s interactive',
    (mode) => {
      expect(
        getBuiltinToolPermissionOutcome({ ...args, configOptions: configOptions(mode) })
      ).toBeUndefined();
    }
  );

  it('does not apply Grok policy to other providers or an absent option snapshot', () => {
    for (const agentType of ['claude', 'codex', 'kimi']) {
      expect(
        getBuiltinToolPermissionOutcome({ ...args, agentConfig: { cliType: 'builtin', agentType } })
      ).toBeUndefined();
    }
    expect(getBuiltinToolPermissionOutcome({ ...args, agentConfig: undefined })).toBeUndefined();
    expect(getBuiltinToolPermissionOutcome({ ...args, configOptions: [] })).toBeUndefined();
  });

  it('never substitutes a lasting grant when AllowOnce is missing', () => {
    const withoutOnce = {
      ...request,
      options: request.options.filter((o) => o.kind !== 'allow_once'),
    };
    expect(getBuiltinToolPermissionOutcome({ ...args, request: withoutOnce })).toBeUndefined();
    expect(
      getBuiltinToolPermissionOutcome({ ...args, request: withoutOnce, pending: true })
    ).toEqual({ outcome: 'cancelled' });
  });

  it('keeps question requests interactive even when draining', () => {
    const question: RequestPermissionRequest = {
      ...request,
      _meta: {
        claudeCode: {
          requestType: 'askUserQuestion',
          askUserQuestion: {
            version: 1,
            questions: [
              {
                question: 'Which database?',
                header: 'Database',
                options: [{ label: 'Postgres', description: 'Use Postgres' }],
                multiSelect: false,
              },
            ],
          },
        },
      },
    };
    expect(
      getBuiltinToolPermissionOutcome({ ...args, request: question, pending: true })
    ).toBeUndefined();
  });
});

describe('rate-limit window labels', () => {
  const window = { usedPercent: 0, windowDurationSeconds: 604_800, resetsAtEpochSeconds: null };
  const snapshot = {
    rateLimits: [
      {
        limitId: 'claude',
        scope: { providerId: 'claude' },
        windows: [window, { ...window, label: 'Fable' }],
      },
    ],
  };

  it('preserves same-duration labeled windows in query responses', () => {
    expect(parseRateLimitsSnapshot(snapshot)).toEqual(snapshot);
  });

  it('preserves labels in proactive updates', () => {
    expect(
      parseLodyExtensionMessage({
        method: LODY_EXTENSION_METHODS.rateLimitsUpdate,
        params: snapshot,
        provider: 'claude',
        sessionId: 'synthetic-session',
      })
    ).toEqual({ type: 'rateLimits', snapshot });
  });
});
