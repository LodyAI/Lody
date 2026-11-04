import { describe, expect, it } from 'vitest';
import type { AgentConfigId, MachineId, ProviderSetupTask } from '@lody/shared';
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
  it('requires the selected AgentConfig to still be published', () => {
    const selectedConfig = {
      kind: 'agentConfig' as const,
      agentConfigId: setupId,
      agentName: 'Draft Agent',
    };
    expect(resolveDesktopOnboardingSummaryAgent(selectedConfig, [], [])).toEqual({
      state: 'missing',
      name: 'Draft Agent',
    });
    expect(
      resolveDesktopOnboardingSummaryAgent(selectedConfig, [], [setup('verifying').config])
    ).toEqual({
      state: 'ready',
      name: 'Draft Agent',
    });
  });
});
