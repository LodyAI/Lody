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
  acpCapabilities: MachineViewMeta['acpCapabilities'] | undefined
): Extract<OnboardingProviderStatus, 'untested' | 'passed'> {
  const cacheKey = getAcpCapabilityCacheKey(config.id);
  return getAcpCapabilityCacheEntryAuthority(
    acpCapabilities?.[cacheKey],
    config.runtimeOverrides
  ) === 'authoritative'
    ? 'passed'
    : 'untested';
}
