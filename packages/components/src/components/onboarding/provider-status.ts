import {
  getAcpCapabilityCacheKey,
  getAcpCapabilityCacheEntryAuthority,
  type AgentConfigMeta,
  type MachineViewMeta,
} from '@lody/shared';

export type OnboardingProviderStatus = 'untested' | 'passed' | 'failed';

type ProviderStatusInput = Pick<
  AgentConfigMeta,
  'id' | 'cliType' | 'agentType' | 'runtimeOverrides'
>;

export function resolveInitialOnboardingProviderStatus(
  config: ProviderStatusInput,
  machine: Pick<MachineViewMeta, 'acpCapabilities' | 'protocolCapabilities'> | undefined
): Extract<OnboardingProviderStatus, 'untested' | 'passed'> {
  const cacheKey = getAcpCapabilityCacheKey(config.id);
  return getAcpCapabilityCacheEntryAuthority(
    machine?.acpCapabilities?.[cacheKey],
    config.runtimeOverrides,
    machine
  ) === 'authoritative'
    ? 'passed'
    : 'untested';
}
