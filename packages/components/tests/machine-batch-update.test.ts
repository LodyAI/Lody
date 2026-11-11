import { describe, expect, it } from 'vitest';
import type { MachineLifecycleCapability } from '@lody/shared';
import {
  BATCH_SWITCH_TIMEOUT_MS,
  batchUpgradeOptions,
  deriveBatchRowStatus,
  planMachineBatchUpdate,
  type BatchMachineInput,
} from '../src/lib/machine-batch-update';

const updatable: MachineLifecycleCapability = {
  launchMode: 'daemon',
  canRemoteRestart: true,
  canRemoteUpgrade: true,
};
const machine = (overrides: Partial<BatchMachineInput>): BatchMachineInput => ({
  id: 'm',
  name: 'machine',
  isOwn: true,
  isOnline: true,
  cliVersion: '1.0.0',
  supportsManagedUpdates: true,
  lifecycle: updatable,
  runningSessionCount: 0,
  ...overrides,
});

describe('one-click update plan covers only the requester’s own machines', () => {
  it('classifies every owned machine and leaves teammates’ machines out', () => {
    const plan = planMachineBatchUpdate(
      [
        machine({ id: 'a', runningSessionCount: 2 }),
        machine({ id: 'teammate', isOwn: false }),
        machine({ id: 'current', cliVersion: '1.1.0' }),
        machine({ id: 'offline', isOnline: false }),
        machine({
          id: 'desktop',
          lifecycle: {
            ...updatable,
            launchMode: 'electron',
            canRemoteUpgrade: false,
            reason: 'electron',
          },
        }),
        machine({
          id: 'foreground',
          lifecycle: {
            ...updatable,
            launchMode: 'foreground',
            canRemoteUpgrade: false,
            reason: 'not_daemon',
          },
        }),
        machine({
          id: 'install',
          lifecycle: { ...updatable, canRemoteUpgrade: false, reason: 'unsupported_install' },
        }),
        machine({ id: 'old-protocol', supportsManagedUpdates: false }),
        machine({ id: 'unprobed', lifecycle: null }),
      ],
      '1.1.0'
    );
    expect(plan.map((row) => [row.machineId, row.kind, row.reason])).toEqual([
      ['a', 'update', undefined],
      ['current', 'up-to-date', undefined],
      ['offline', 'offline', undefined],
      ['desktop', 'unsupported', 'desktop'],
      ['foreground', 'unsupported', 'foreground'],
      ['install', 'unsupported', 'install'],
      ['old-protocol', 'unsupported', 'install'],
      ['unprobed', 'unsupported', 'unknown'],
    ]);
    expect(plan[0]).toMatchObject({
      currentVersion: '1.0.0',
      targetVersion: '1.1.0',
      runningSessionCount: 2,
    });
  });

  it('never offers a downgrade', () => {
    expect(planMachineBatchUpdate([machine({ cliVersion: '1.2.0' })], '1.1.0')[0]?.kind).toBe(
      'up-to-date'
    );
  });
});

describe('per-machine progress after the request is accepted', () => {
  const base = { target: '1.1.0', nowMs: 1_000_000 };
  it('reports updated once the machine runs the target version', () => {
    expect(
      deriveBatchRowStatus({ ...base, request: 'accepted', isOnline: true, cliVersion: '1.1.0' })
    ).toEqual({ kind: 'updated' });
  });
  it('waits for idle while the prepared update has not switched', () => {
    expect(
      deriveBatchRowStatus({
        ...base,
        request: 'accepted',
        isOnline: true,
        cliVersion: '1.0.0',
        updatePhase: 'waiting',
      })
    ).toEqual({ kind: 'waiting-idle' });
  });
  it('surfaces rollback and blocked recovery from the machine’s own record', () => {
    for (const phase of ['rolled-back', 'blocked', 'failed'] as const)
      expect(
        deriveBatchRowStatus({
          ...base,
          request: 'accepted',
          isOnline: true,
          cliVersion: '1.0.0',
          updatePhase: phase,
        })
      ).toEqual({ kind: phase });
  });
  it('turns red only when the switch has been offline longer than the timeout', () => {
    const switching = {
      ...base,
      request: 'accepted' as const,
      isOnline: false,
      cliVersion: '1.0.0',
      offlineSinceMs: base.nowMs - BATCH_SWITCH_TIMEOUT_MS + 1,
    };
    expect(deriveBatchRowStatus(switching)).toEqual({ kind: 'switching' });
    expect(
      deriveBatchRowStatus({ ...switching, offlineSinceMs: base.nowMs - BATCH_SWITCH_TIMEOUT_MS })
    ).toEqual({ kind: 'timed-out' });
  });
  it('keeps a rejected request as a failure with its reason', () => {
    expect(
      deriveBatchRowStatus({ ...base, request: 'failed', error: 'expired', isOnline: true })
    ).toEqual({ kind: 'request-failed', error: 'expired' });
  });
});

describe('one-click update never moves a machine across channels or backwards', () => {
  it('signs the client channel without confirming a channel change or downgrade', () => {
    expect(batchUpgradeOptions('next', 'immediate')).toEqual({
      protocol: 1,
      channel: 'next',
      switchPolicy: 'immediate',
      confirmChannelChange: false,
      confirmDowngrade: false,
    });
  });
});
