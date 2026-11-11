import type { MachineLifecycleCapability, ManagedDaemonUpdateStatus } from '@lody/shared';
import { isCliVersionOutdated } from './machine-lifecycle-api';

/**
 * One-click update of every machine the requester owns. Each machine is still
 * updated through its own owner-only, backend-verified `machine/upgrade`; this
 * module only decides which machines are offered and how their progress reads.
 */

/** A switch that has not reconnected within this window is shown as failed. */
export const BATCH_SWITCH_TIMEOUT_MS = 5 * 60_000;

export type BatchMachineInput = {
  id: string;
  name: string;
  isOwn: boolean;
  isOnline: boolean;
  cliVersion?: string;
  supportsManagedUpdates: boolean;
  /** `machine/status` capability; null while unknown or unreadable. */
  lifecycle: MachineLifecycleCapability | null;
  runningSessionCount: number;
};

export type BatchUnsupportedReason = 'desktop' | 'foreground' | 'install' | 'unknown';

export type BatchPlanRow = {
  machineId: string;
  name: string;
  kind: 'update' | 'up-to-date' | 'offline' | 'unsupported';
  reason?: BatchUnsupportedReason;
  currentVersion?: string;
  targetVersion: string;
  runningSessionCount: number;
};

const unsupportedReason = (machine: BatchMachineInput): BatchUnsupportedReason => {
  if (!machine.lifecycle) return 'unknown';
  if (machine.lifecycle.launchMode === 'electron') return 'desktop';
  if (machine.lifecycle.launchMode === 'foreground') return 'foreground';
  return 'install';
};

export function planMachineBatchUpdate(
  machines: readonly BatchMachineInput[],
  latestVersion: string
): BatchPlanRow[] {
  return machines
    .filter((machine) => machine.isOwn)
    .map((machine): BatchPlanRow => {
      const row = {
        machineId: machine.id,
        name: machine.name,
        currentVersion: machine.cliVersion,
        targetVersion: latestVersion,
        runningSessionCount: machine.runningSessionCount,
      };
      if (!machine.isOnline) return { ...row, kind: 'offline' };
      if (!isCliVersionOutdated(machine.cliVersion, latestVersion))
        return { ...row, kind: 'up-to-date' };
      if (machine.supportsManagedUpdates && machine.lifecycle?.canRemoteUpgrade === true)
        return { ...row, kind: 'update' };
      return {
        ...row,
        kind: 'unsupported',
        reason:
          machine.lifecycle && !machine.supportsManagedUpdates
            ? 'install'
            : unsupportedReason(machine),
      };
    });
}

export type BatchRowStatus =
  | { kind: 'requesting' }
  | { kind: 'request-failed'; error: string }
  | { kind: 'waiting-idle' }
  | { kind: 'switching' }
  | { kind: 'updated' }
  | { kind: 'rolled-back' }
  | { kind: 'blocked' }
  | { kind: 'failed' }
  | { kind: 'timed-out' };

export function deriveBatchRowStatus(input: {
  request: 'requesting' | 'accepted' | 'failed';
  error?: string;
  target: string;
  isOnline: boolean;
  cliVersion?: string;
  updatePhase?: ManagedDaemonUpdateStatus['phase'];
  /** When the machine was first seen offline after acceptance. */
  offlineSinceMs?: number;
  nowMs: number;
}): BatchRowStatus {
  if (input.request === 'requesting') return { kind: 'requesting' };
  if (input.request === 'failed') return { kind: 'request-failed', error: input.error ?? '' };
  if (input.isOnline && input.cliVersion === input.target) return { kind: 'updated' };
  if (input.updatePhase === 'rolled-back') return { kind: 'rolled-back' };
  if (input.updatePhase === 'blocked') return { kind: 'blocked' };
  if (input.updatePhase === 'failed') return { kind: 'failed' };
  if (!input.isOnline) {
    // The 5-minute window counts from the switch (the old daemon going away),
    // never the wait for idle.
    if (
      input.offlineSinceMs !== undefined &&
      input.nowMs - input.offlineSinceMs >= BATCH_SWITCH_TIMEOUT_MS
    )
      return { kind: 'timed-out' };
    return { kind: 'switching' };
  }
  return { kind: 'waiting-idle' };
}
