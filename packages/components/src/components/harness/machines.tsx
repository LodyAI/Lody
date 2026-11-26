/*
 * The bridge between real machine data and the drawn harness. The store keeps
 * only what the surface owns — which machine is active and its config
 * overrides — so these hooks project the live machine index into the `Device`
 * rows every panel renders. `Device.id` is the machine's own `MachineId`:
 * pairing surfaces a real machine, it never mints a fake row.
 *
 * Liveness is presence-derived and three-state: a machine whose status is
 * 'unknown' draws the neutral 'idle' dot, never 'offline' — the same rule the
 * sidebar machine pill follows.
 */
import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { getMachineHostType, type MachineId, type MachineViewMeta } from '@lody/shared';

import { localMachineIdAtom } from '@/atoms/local-probe';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import {
  lodyPresenceSyncStateAtom,
  machineOnlineStatusAtomFamily,
  onlineMachineIdsAtom,
  type MachineOnlineStatus,
} from '@/atoms/presence';
import { useOptionalAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import { canManageAllMachines } from '@/lib/machine-deletion';
import { useOrganization } from '@/hooks/useOrganization';

import type { Device, DeviceKind, DeviceStatus } from './catalog';
import { harness, useHarness } from './store';

const OS_LABELS: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

const OS_KNOWN = new Set(Object.keys(OS_LABELS));

/**
 * The form factor the glyph draws. Machines carry no `arch` field — `os` is
 * `process.platform` — so the heuristic is: cloud host → cloud, a desktop OS →
 * laptop, anything else (headless or unrecognized) → server.
 */
export function machineKind(machine: Pick<MachineViewMeta, 'hostType' | 'os'>): DeviceKind {
  if (getMachineHostType(machine) === 'cloud') return 'cloud';
  return OS_KNOWN.has(machine.os) ? 'laptop' : 'server';
}

/** Presence → the store's device status. 'unknown' draws idle, never offline. */
export function deviceStatus(online: MachineOnlineStatus): DeviceStatus {
  return online === 'online' ? 'online' : online === 'offline' ? 'offline' : 'idle';
}

export function machineToDevice(machine: MachineViewMeta, online: MachineOnlineStatus): Device {
  return {
    id: machine.id,
    name: machine.name || machine.id,
    kind: machineKind(machine),
    os: OS_LABELS[machine.os] ?? machine.os ?? '',
    host: machine.name || machine.id,
    version: machine.cliVersion || '',
    status: deviceStatus(online),
  };
}

/**
 * The machines the harness can claim. Under the workspace shell that is the
 * visibility-filtered index; a bare mount (a story, a test) reads the raw meta
 * map so the surface still renders instead of throwing.
 */
function useMachineIndex() {
  const authed = useOptionalAuthenticatedConvex();
  if (!authed) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- one branch, picked once per mount
    const machines = useAtomValue(getMachineMetaMapAtom);
    return { machines, isLoading: false };
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- the branch is stable
  const index = useVisibleMachineMetas();
  return { machines: index.machines, isLoading: index.isLoading };
}

export type HarnessDevices = {
  /** Real machines in their index order, projected to the drawn shape. */
  devices: Device[];
  /** The metas behind `devices`, keyed by the same `MachineId`. */
  machines: ReadonlyMap<MachineId, MachineViewMeta>;
  /** MachineIds the store's per-device overrides are keyed by. */
  activeDevice: string | null;
  select: (machineId: MachineId) => void;
  /** 'unknown' until the machine index has answered — not 'no devices'. */
  isLoading: boolean;
};

/**
 * The device list every harness panel reads. Selection and overrides stay in
 * the harness store keyed by `MachineId`; the rows themselves are a live view
 * of the machine index, so a machine that joins mid-session simply appears.
 */
export function useHarnessDevices(): HarnessDevices {
  const state = useHarness();
  const { machines, isLoading } = useMachineIndex();
  const onlineIds = useAtomValue(onlineMachineIdsAtom);
  // Same rule as `machineOnlineStatusAtomFamily`, computed once for the list:
  // 'offline' only when presence is synced and the heartbeat is absent.
  const presenceSynced = useAtomValue(lodyPresenceSyncStateAtom) === 'synced';
  const devices = useMemo(
    () =>
      [...machines.values()].map((machine) =>
        machineToDevice(
          machine,
          onlineIds.has(machine.id) ? 'online' : presenceSynced ? 'offline' : 'unknown'
        )
      ),
    [machines, onlineIds, presenceSynced]
  );
  const localMachineId = useAtomValue(localMachineIdAtom);
  // The selection while it is still listed, else this device, else the first.
  const activeDevice =
    state.activeDevice && machines.has(state.activeDevice as MachineId)
      ? state.activeDevice
      : localMachineId && machines.has(localMachineId)
        ? localMachineId
        : (devices[0]?.id ?? null);
  return { devices, machines, activeDevice, select: harness.select, isLoading };
}

/** One row's live liveness; the page maps it onto the drawn status words. */
export function useDeviceStatus(machineId: MachineId): MachineOnlineStatus {
  return useAtomValue(machineOnlineStatusAtomFamily(machineId));
}

/**
 * The device a config page is scoped to: the selected machine while it is
 * still listed, else this device, else the first row.
 */
export function useActiveDevice(): { device: Device | null; devices: Device[] } {
  const { devices, activeDevice } = useHarnessDevices();
  const device = devices.find((d) => d.id === activeDevice) ?? devices[0] ?? null;
  return { device, devices };
}

/**
 * Who the current viewer is allowed to delete: machine removal is doc-level
 * and gated the same way as the machine settings page — an offline machine
 * that is yours, or any offline machine for an owner/admin.
 */
export function useDeviceManagement() {
  const accountId = useWorkspaceLocalAccountId();
  const { activeOrganization } = useOrganization();
  const members = useMemo(() => activeOrganization?.members ?? [], [activeOrganization]);
  const canManageOthers = useMemo(
    () => canManageAllMachines(accountId, members),
    [accountId, members]
  );
  return { accountId, canManageOthers };
}
