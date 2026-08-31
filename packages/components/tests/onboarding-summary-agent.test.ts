import { describe, expect, it } from 'vitest';
import type { AgentConfigId, AgentConfigMeta, MachineId, ProviderSetupTask } from '@lody/shared';
import { resolveDesktopOnboardingSummaryAgent } from '../src/components/onboarding/onboarding-overlay';

const machineId = 'machine-1' as MachineId;
const setupId = 'setup-1' as AgentConfigId;
const provider = {
  kind: 'providerSetup' as const,
  providerSetupId: setupId,
  agentName: 'Draft Agent',
};

function setup(status: ProviderSetupTask['status']): ProviderSetupTask {
  return {
    v: 1,
    id: setupId,
    machineId,
    config: {
      id: setupId,
      machineId,
      name: 'Draft Agent',
      cliType: 'builtin',
      agentType: 'codex',
      env: {},
    },
    status,
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('resolveDesktopOnboardingSummaryAgent', () => {
  it('maps live pending, failed, deleted, and published setup states', () => {
    expect(resolveDesktopOnboardingSummaryAgent(provider, [setup('verifying')], [])).toEqual({
      state: 'preparing',
      name: 'Draft Agent',
    });
    expect(resolveDesktopOnboardingSummaryAgent(provider, [setup('failed')], [])).toEqual({
      state: 'failed',
      name: 'Draft Agent',
    });
    expect(resolveDesktopOnboardingSummaryAgent(provider, [], [])).toEqual({
      state: 'missing',
      name: 'Draft Agent',
    });

    const published: AgentConfigMeta = {
      ...setup('verifying').config,
      name: 'Published Agent',
    };
    expect(resolveDesktopOnboardingSummaryAgent(provider, [], [published])).toEqual({
      state: 'ready',
      name: 'Published Agent',
    });
  });
});
