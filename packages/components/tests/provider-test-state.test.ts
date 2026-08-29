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
  it('preserves and clamps determinate download progress', () => {
    expect(providerTestActivityFromProgress(progress('downloading', 42.4))).toEqual({
      phase: 'downloading-runtime',
      percent: 42.4,
    });
    expect(providerTestActivityFromProgress(progress('downloading', 140))).toEqual({
      phase: 'downloading-runtime',
      percent: 100,
    });
  });

  it('uses honest non-numeric stages outside determinate downloads', () => {
    expect(providerTestActivityFromProgress(progress('extracting'))).toEqual({
      phase: 'extracting-runtime',
    });
    expect(providerTestActivityFromProgress(progress('installed'))).toEqual({
      phase: 'probing-provider',
    });
  });
});

describe('createProviderTestRunRegistry', () => {
  it('makes a replacement run current and aborts the previous run', () => {
    const registry = createProviderTestRunRegistry();
    const first = registry.start(configId);
    const second = registry.start(configId);

    expect(first.signal.aborted).toBe(true);
    expect(registry.isCurrent(configId, first)).toBe(false);
    expect(registry.isCurrent(configId, second)).toBe(true);
  });

  it('prevents an invalidated or completed run from committing', () => {
    const registry = createProviderTestRunRegistry();
    const invalidated = registry.start(configId);
    registry.invalidate(configId);
    expect(invalidated.signal.aborted).toBe(true);
    expect(registry.finish(configId, invalidated)).toBe(false);

    const completed = registry.start(configId);
    expect(registry.finish(configId, completed)).toBe(true);
    expect(registry.finish(configId, completed)).toBe(false);
  });
});
