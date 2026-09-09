import { describe, expect, it } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  getAcpCapabilityCacheKey,
  type AcpCapabilityCacheEntry,
  type AgentConfigId,
  type MachineViewMeta,
} from '@lody/shared';

import { resolveInitialOnboardingProviderStatus } from '../src/components/onboarding/provider-status';

const config = {
  id: 'builtin-kimi' as AgentConfigId,
  cliType: 'builtin' as const,
  agentType: 'kimi',
};

const runtimeEntry: AcpCapabilityCacheEntry = {
  cliType: 'builtin',
  agentType: 'kimi',
  cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
  provenance: 'runtime',
  sourceVersion: 'builtin-kimi:0.29.0',
  modes: [],
  models: [],
  configOptions: [],
  availableCommands: [],
  fetchedAt: 1,
};

function machineWithCapabilities(
  entry: AcpCapabilityCacheEntry,
  targetConfig: typeof config = config
): Pick<MachineViewMeta, 'acpCapabilities' | 'protocolCapabilities'> {
  return { acpCapabilities: { [getAcpCapabilityCacheKey(targetConfig.id)]: entry } };
}

describe('resolveInitialOnboardingProviderStatus', () => {
  it('does not treat missing or static capabilities as verified', () => {
    expect(resolveInitialOnboardingProviderStatus(config, undefined)).toBe('untested');
    expect(
      resolveInitialOnboardingProviderStatus(
        config,
        machineWithCapabilities({ ...runtimeEntry, provenance: undefined })
      )
    ).toBe('untested');
  });

  it('treats parsed runtime probes as verified across cache versions', () => {
    expect(
      resolveInitialOnboardingProviderStatus(config, machineWithCapabilities(runtimeEntry))
    ).toBe('passed');
    expect(
      resolveInitialOnboardingProviderStatus(
        config,
        machineWithCapabilities({ ...runtimeEntry, cacheVersion: ACP_CAPABILITY_CACHE_VERSION - 1 })
      )
    ).toBe('passed');
  });

  it('applies the same authoritative-probe rule to existing builtins', () => {
    const claudeConfig = {
      ...config,
      id: 'builtin-claude' as AgentConfigId,
      agentType: 'claude',
    };
    const claudeRuntimeEntry: AcpCapabilityCacheEntry = {
      ...runtimeEntry,
      agentType: 'claude',
      sourceVersion: 'builtin-claude:test',
    };

    expect(
      resolveInitialOnboardingProviderStatus(
        claudeConfig,
        machineWithCapabilities({ ...claudeRuntimeEntry, provenance: undefined }, claudeConfig)
      )
    ).toBe('untested');
    expect(
      resolveInitialOnboardingProviderStatus(
        claudeConfig,
        machineWithCapabilities(claudeRuntimeEntry, claudeConfig)
      )
    ).toBe('passed');
  });
});
