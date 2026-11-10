import { describe, expect, it } from 'vitest';
import type { MachineId, MachineViewMeta } from '@lody/shared';
import {
  buildWorkspaceMachineSelectionPool,
  getMachineIdentityRestoreCandidates,
  resolveDesktopMachineSelection,
} from '../src/components/settings/machine-selection';
import type { MachineTabItem } from '../src/components/settings/machine-tab-list';

const machine = (id: string): MachineViewMeta => ({
  id: id as MachineId,
  name: id,
  cliVersion: '0.57.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
});

const item = (id: string, overrides: Partial<MachineTabItem> = {}): MachineTabItem => ({
  machine: machine(id),
  isOwn: false,
  isOnline: true,
  sharedWithTeam: true,
  ...overrides,
});

const OWN_LOCAL = 'own-local' as MachineId;
const OWN_OTHER = 'own-other' as MachineId;
const TEAMMATE = 'teammate' as MachineId;

describe('buildWorkspaceMachineSelectionPool', () => {
  it('includes a directly targeted private machine owned by the current user', () => {
    const privateOwn = item(OWN_LOCAL, { isOwn: true, sharedWithTeam: false });
    const shared = item(TEAMMATE);
    const result = buildWorkspaceMachineSelectionPool({
      filteredItems: [shared],
      allItems: [privateOwn, shared],
      selectedMachineId: OWN_LOCAL,
    });
    expect(result.map((entry) => entry.machine.id)).toEqual([OWN_LOCAL, TEAMMATE]);
  });

  it('includes a directly targeted shared machine hidden by the current filter', () => {
    const sharedOwn = item(OWN_OTHER, { isOwn: true });
    const result = buildWorkspaceMachineSelectionPool({
      filteredItems: [],
      allItems: [sharedOwn],
      selectedMachineId: OWN_OTHER,
    });
    expect(result).toEqual([sharedOwn]);
  });

  it('does not expose another member private machine through a direct target', () => {
    const privateTeammate = item(TEAMMATE, { sharedWithTeam: false });
    const result = buildWorkspaceMachineSelectionPool({
      filteredItems: [],
      allItems: [privateTeammate],
      selectedMachineId: TEAMMATE,
    });
    expect(result).toEqual([]);
  });
});

describe('resolveDesktopMachineSelection', () => {
  it('falls back to an own machine when the My machines filter hides a teammate selection', () => {
    const minePool = [item(OWN_OTHER, { isOwn: true }), item(OWN_LOCAL, { isOwn: true })];
    const result = resolveDesktopMachineSelection({
      pool: minePool,
      selectedMachineId: TEAMMATE,
      localMachineId: null,
    });
    expect(result.resolved?.id).toBe(OWN_OTHER);
    expect(result.nextSelectedMachineId).toBe(OWN_OTHER);
  });

  it('re-resolves when the selected machine asynchronously leaves the pool', () => {
    const onlineOnly = [item(OWN_LOCAL, { isOwn: true }), item(TEAMMATE)];
    const before = resolveDesktopMachineSelection({
      pool: onlineOnly,
      selectedMachineId: TEAMMATE,
      localMachineId: OWN_LOCAL,
    });
    expect(before.resolved?.id).toBe(TEAMMATE);

    // The teammate machine goes offline; the Online filter drops it from the pool.
    const afterOffline = onlineOnly.filter((entry) => entry.machine.id !== TEAMMATE);
    const after = resolveDesktopMachineSelection({
      pool: afterOffline,
      selectedMachineId: TEAMMATE,
      localMachineId: OWN_LOCAL,
    });
    // Local machine wins the fallback order.
    expect(after.resolved?.id).toBe(OWN_LOCAL);
    expect(after.nextSelectedMachineId).toBe(OWN_LOCAL);
  });

  it('clears the selection when no machine matches the filters', () => {
    const result = resolveDesktopMachineSelection({
      pool: [],
      selectedMachineId: TEAMMATE,
      localMachineId: OWN_LOCAL,
    });
    expect(result.resolved).toBeUndefined();
    expect(result.nextSelectedMachineId).toBeNull();
  });

  it('prefers the local machine over other fallbacks', () => {
    const pool = [item(TEAMMATE), item(OWN_LOCAL, { isOwn: true })];
    const result = resolveDesktopMachineSelection({
      pool,
      selectedMachineId: null,
      localMachineId: OWN_LOCAL,
    });
    expect(result.nextSelectedMachineId).toBe(OWN_LOCAL);
  });
});

describe('old identity recovery candidates', () => {
  it('uses account ownership rather than the local-machine ownership shortcut', () => {
    const localShortcut = item(OWN_LOCAL, { isOwn: true, isOnline: false });
    const ownedRemote = item(OWN_OTHER, { isOwn: false, isOnline: false });
    const onlineOwn = item('online-own', { isOwn: true });
    const unknownOwner = item('unknown-owner', { isOwn: true, isOnline: false });
    const allItems = [localShortcut, ownedRemote, onlineOwn, unknownOwner];
    const accessByMachineId = new Map([
      [OWN_LOCAL, { ownerUserId: 'another-account' }],
      [OWN_OTHER, { ownerUserId: 'current-account' }],
      ['online-own' as MachineId, { ownerUserId: 'current-account' }],
    ]);
    expect(
      getMachineIdentityRestoreCandidates({
        allItems,
        accessByMachineId,
        currentUserId: 'current-account',
      })
    ).toEqual([ownedRemote.machine]);
    expect(
      getMachineIdentityRestoreCandidates({ allItems, accessByMachineId, currentUserId: null })
    ).toEqual([]);
  });
});
