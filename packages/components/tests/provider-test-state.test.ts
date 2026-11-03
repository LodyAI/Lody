import { describe, expect, it } from 'vitest';
import type { AgentConfigId, MachineAcpBinaryProgressMessage, MachineId } from '@lody/shared';

import {
  createProviderTestRunRegistry,
  providerTestActivityFromProgress,
} from '../src/components/onboarding/provider-test-state';

const configId = 'provider-1' as AgentConfigId;

function progress(
  status: MachineAcpBinaryProgressMessage['status'],
  percent?: number
): MachineAcpBinaryProgressMessage {
  return {
    type: 'machine/acp-binary-progress',
    machineId: 'machine-1' as MachineId,
    agentType: 'kimi',
    status,
    percent,
  };
}

describe('providerTestActivityFromProgress', () => {
  it('does not present a runtime that already failed as still checking', () => {
    for (const status of ['error', 'unsupported-platform', 'incompatible-host'] as const) {
      expect(providerTestActivityFromProgress(progress(status))).toEqual({
        phase: 'runtime-failed',
      });
    }
  });
});

describe('createProviderTestRunRegistry', () => {
  it('detaches without aborting, so leaving the step does not cancel the work', () => {
    // Leaving the provider step must stop the screen committing a result it can
    // no longer show, and nothing more. The machine drops a refresh once its
    // last consumer leaves, so aborting here would make "continue" quietly mean
    // "abandon this agent" — the opposite of what the UI offers at that moment.
    const registry = createProviderTestRunRegistry();
    const detached = registry.start(configId);

    registry.detachAll();

    expect(detached.signal.aborted).toBe(false);
    expect(registry.isCurrent(configId, detached)).toBe(false);
    expect(registry.finish(configId, detached)).toBe(false);
  });
});
