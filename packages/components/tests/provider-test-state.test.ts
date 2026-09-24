import { describe, expect, it } from 'vitest';
import type { AgentConfigId, MachineAcpBinaryProgressMessage, MachineId } from '@lody/shared';

import {
  agentRuntimeReadinessFromActivity,
  agentRuntimeReadinessFromProgress,
  createProviderTestRunRegistry,
  providerTestActivityFromProgress,
  providerWaitEscalation,
  PROVIDER_WAIT_EXCEPTIONAL_AFTER_SECONDS,
  PROVIDER_WAIT_MEASURED_AFTER_SECONDS,
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

  it('does not present a runtime that already failed as still checking', () => {
    for (const status of ['error', 'unsupported-platform', 'incompatible-host'] as const) {
      expect(providerTestActivityFromProgress(progress(status))).toEqual({
        phase: 'runtime-failed',
      });
    }
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

describe('agentRuntimeReadinessFromProgress', () => {
  it('lights the mark up only once the runtime has landed', () => {
    expect(agentRuntimeReadinessFromProgress(progress('installed'))).toEqual({
      readiness: 'ready',
      percent: null,
    });
    expect(agentRuntimeReadinessFromProgress(null)).toEqual({
      readiness: 'cold',
      percent: null,
    });
  });

  it('only carries a denominator while downloading', () => {
    expect(agentRuntimeReadinessFromProgress(progress('downloading', 62.5))).toEqual({
      readiness: 'arriving',
      percent: 62.5,
    });
    expect(agentRuntimeReadinessFromProgress(progress('downloading'))).toEqual({
      readiness: 'arriving',
      percent: null,
    });
    for (const status of ['checking', 'verifying', 'extracting', 'publishing'] as const) {
      expect(agentRuntimeReadinessFromProgress(progress(status))).toEqual({
        readiness: 'arriving',
        percent: null,
      });
    }
  });

  it('reads a failed runtime as cold, leaving the reason to the row badge', () => {
    for (const status of ['error', 'unsupported-platform', 'incompatible-host'] as const) {
      expect(agentRuntimeReadinessFromProgress(progress(status))).toEqual({
        readiness: 'cold',
        percent: null,
      });
    }
  });
});

describe('agentRuntimeReadinessFromActivity', () => {
  it('leaves the mark to its durable state when nothing is in flight', () => {
    expect(agentRuntimeReadinessFromActivity(undefined)).toBeNull();
  });

  it('fills for a download and orbits for every denominator-free stage', () => {
    expect(
      agentRuntimeReadinessFromActivity({ phase: 'downloading-runtime', percent: 140 })
    ).toEqual({ readiness: 'arriving', percent: 100 });
    // The ACP handshake is the case that matters: no percentage exists, so none
    // may be invented.
    expect(agentRuntimeReadinessFromActivity({ phase: 'probing-provider' })).toEqual({
      readiness: 'arriving',
      percent: null,
    });
  });

  it('stops presenting an already-failed runtime as arriving', () => {
    expect(agentRuntimeReadinessFromActivity({ phase: 'runtime-failed' })).toEqual({
      readiness: 'cold',
      percent: null,
    });
  });
});

describe('providerWaitEscalation', () => {
  it('says only the stage name while a wait is still ordinary', () => {
    expect(providerWaitEscalation(0)).toBe('normal');
    expect(providerWaitEscalation(PROVIDER_WAIT_MEASURED_AFTER_SECONDS - 1)).toBe('normal');
  });

  it('starts measuring once the wait is long enough to want bounded', () => {
    expect(providerWaitEscalation(PROVIDER_WAIT_MEASURED_AFTER_SECONDS)).toBe('measured');
    expect(providerWaitEscalation(PROVIDER_WAIT_EXCEPTIONAL_AFTER_SECONDS - 1)).toBe('measured');
  });

  it('admits the wait left the normal range instead of holding the stage name', () => {
    // The second escalation is the whole point of having tiers: past here a
    // stage name over a rising number is the interface insisting nothing is
    // wrong, so the tone has to change rather than the number growing alone.
    expect(providerWaitEscalation(PROVIDER_WAIT_EXCEPTIONAL_AFTER_SECONDS)).toBe('exceptional');
    expect(providerWaitEscalation(600)).toBe('exceptional');
  });

  it('escalates in order, so a tier can never be skipped or reversed', () => {
    expect(PROVIDER_WAIT_MEASURED_AFTER_SECONDS).toBeGreaterThan(0);
    expect(PROVIDER_WAIT_EXCEPTIONAL_AFTER_SECONDS).toBeGreaterThan(
      PROVIDER_WAIT_MEASURED_AFTER_SECONDS
    );
  });
});
