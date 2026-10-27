import { describe, expect, it } from 'vitest';
import type { AgentConfigMeta, MachineViewMeta } from '@lody/shared';
import { getRateLimitEntryKey } from '@lody/shared';
import {
  buildProviderRows,
  buildProviderUsage,
  buildQuotaRows,
  providerKeyForConfig,
  providerKeyForModelId,
} from '../src/components/settings/ai-usage-model';

const machine = (overrides: Partial<MachineViewMeta>): MachineViewMeta =>
  ({
    id: 'machine-1',
    name: 'MacBook Pro',
    raceLimits: {},
    acpCapabilities: {},
    ...overrides,
  }) as unknown as MachineViewMeta;

const config = (overrides: Partial<AgentConfigMeta>): AgentConfigMeta =>
  ({
    id: 'config-1' as AgentConfigMeta['id'],
    machineId: 'machine-1' as AgentConfigMeta['machineId'],
    name: 'Claude Code',
    cliType: 'builtin',
    agentType: 'claude',
    env: {},
    ...overrides,
  }) as AgentConfigMeta;

type RateLimitValue = MachineViewMeta['raceLimits'][string];

const rateLimit = (windows: RateLimitValue['windows']): RateLimitValue =>
  ({
    limitId: 'account',
    scope: { providerId: 'claude' },
    windows,
  }) as RateLimitValue;

describe('providerKeyForModelId', () => {
  it('maps the Provider families shown on the page', () => {
    expect(providerKeyForModelId('anthropic/claude-opus-4-8')).toBe('claude');
    expect(providerKeyForModelId('openai/gpt-5-codex')).toBe('codex');
    expect(providerKeyForModelId('deepseek-v4')).toBe('deepseek');
    expect(providerKeyForModelId('moonshot/kimi-k2')).toBe('kimi');
    expect(providerKeyForModelId('google/gemini-2.5-pro')).toBe('gemini');
    expect(providerKeyForModelId('unknown/model')).toBe('other');
  });
});

describe('providerKeyForConfig', () => {
  it('uses the persisted brand before the runtime slug', () => {
    expect(providerKeyForConfig({ ...config({}), brandId: 'deepseek' })).toBe('deepseek');
    expect(providerKeyForConfig(config({ agentType: 'codex' }))).toBe('codex');
  });
});

describe('buildQuotaRows', () => {
  it('joins a Provider config with the owning machine and its windows', () => {
    const configId = 'config-1' as AgentConfigMeta['id'];
    const rows = buildQuotaRows({
      machines: new Map([
        [
          'machine-1',
          machine({
            raceLimits: {
              [getRateLimitEntryKey('claude', 'account', configId)]: rateLimit([
                {
                  usedPercent: 38,
                  windowDurationSeconds: 5 * 60 * 60,
                  resetsAtEpochSeconds: 1_800_000_000,
                },
              ]),
            },
          }),
        ],
      ]),
      configs: [config({ id: configId })],
      onlineMachineIds: new Set(['machine-1' as AgentConfigMeta['machineId']]),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerName: 'Claude Code',
      machineName: 'MacBook Pro',
      machineOnline: true,
      providerKey: 'claude',
    });
    expect(rows[0].windows).toHaveLength(1);
    expect(rows[0].windows[0]?.remainingPercent).toBe(62);
  });

  it('keeps a Provider without reported windows and marks the machine offline', () => {
    const rows = buildQuotaRows({
      machines: new Map([['machine-1', machine({ name: 'Mac mini' })]]),
      configs: [config({ name: 'Kimi Code', agentType: 'kimi', cliType: 'registry' })],
      onlineMachineIds: new Set(),
    });

    expect(rows[0]).toMatchObject({
      providerName: 'Kimi Code',
      machineName: 'Mac mini',
      machineOnline: false,
      providerKey: 'kimi',
    });
    expect(rows[0].windows).toEqual([]);
    expect(rows[0].wallet).toBeNull();
  });
});

describe('buildProviderUsage', () => {
  it('groups model usage into Provider series and totals', () => {
    const result = buildProviderUsage([
      {
        bucketLabel: 'Monday',
        byModel: [
          { modelId: 'claude-opus', tokens: 60, costUSD: 3 },
          { modelId: 'gpt-5-codex', tokens: 30, costUSD: 1 },
        ],
      },
      {
        bucketLabel: 'Tuesday',
        byModel: [
          { modelId: 'claude-sonnet', tokens: 40, costUSD: 2 },
          { modelId: 'deepseek-v4', tokens: 10, costUSD: 0.5 },
        ],
      },
    ]);

    expect(result.series).toHaveLength(2);
    expect(result.series[0]?.values).toEqual([
      { id: 'claude', label: 'Claude', value: 60 },
      { id: 'codex', label: 'Codex', value: 30 },
    ]);
    expect(result.totals).toEqual([
      { key: 'claude', label: 'Claude', tokens: 100, costUSD: 5 },
      { key: 'codex', label: 'Codex', tokens: 30, costUSD: 1 },
      { key: 'deepseek', label: 'DeepSeek', tokens: 10, costUSD: 0.5 },
    ]);
    expect(result.totalTokens).toBe(140);
    expect(result.totalCostUSD).toBe(6.5);
  });
});

describe('buildProviderRows', () => {
  it('joins Provider usage with the lowest reported window', () => {
    const quotaRows = buildQuotaRows({
      machines: new Map([
        [
          'machine-1',
          machine({
            raceLimits: {
              [getRateLimitEntryKey('claude', 'account', 'config-1')]: rateLimit([
                {
                  usedPercent: 38,
                  windowDurationSeconds: 5 * 60 * 60,
                  resetsAtEpochSeconds: null,
                },
                {
                  usedPercent: 56,
                  windowDurationSeconds: 7 * 24 * 60 * 60,
                  resetsAtEpochSeconds: null,
                },
              ]),
            },
          }),
        ],
      ]),
      configs: [config({})],
      onlineMachineIds: new Set(['machine-1' as AgentConfigMeta['machineId']]),
    });

    const rows = buildProviderRows({
      usage: [
        { key: 'claude', label: 'Claude', tokens: 100, costUSD: 5 },
        { key: 'codex', label: 'Codex', tokens: 50, costUSD: 2 },
      ],
      quotaRows,
      totalTokens: 150,
    });

    expect(rows[0]).toMatchObject({
      key: 'claude',
      label: 'Claude',
      machines: ['MacBook Pro'],
      tokens: 100,
      costUSD: 5,
      share: 66.7,
      quotaPercent: 62,
    });
    expect(rows[1]).toMatchObject({ key: 'codex', tokens: 50, share: 33.3, quotaPercent: null });
  });
});
