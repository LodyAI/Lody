import { describe, expect, it } from 'vitest';
import {
  type MachineId,
  type MachineViewMeta,
  type MachineMeta,
  buildMachineDeleteLocalProjectCommand,
  getRateLimitEntryKey,
  machineFlockKeys,
  serializeMachineFlockKey,
  type AgentConfigId,
  type LocalProjectId,
} from '@lody/shared';
import {
  buildWorkspaceMachineSelectionPool,
  getMachineIdentityRestoreCandidates,
  resolveDesktopMachineSelection,
} from '../src/components/settings/machine-selection';
import type { MachineTabItem } from '../src/components/settings/machine-tab-list';
import {
  canDeleteOfflineMachine,
  canManageAllMachines,
  evaluateMachineDeletion,
  prepareMachineForDeletion,
} from '../src/lib/machine-deletion';
import { mergeMachineFlockMachineMeta } from '../src/lib/machine-flock-machine-meta-overlay';

describe('machine-selection', () => {
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
});

describe('machine-deletion', () => {
  const currentUserId = 'user-1';
  const otherUserId = 'user-2';

  const createMachine = (overrides: Partial<MachineMeta> = {}): MachineMeta => ({
    id: 'machine-1' as MachineId,
    name: 'Machine 1',
    cliVersion: '0.1.0',
    os: 'linux',
    sessions: [],
    ...overrides,
  });

  describe('machine deletion helpers', () => {
    it('allows deleting the current local machine even without owner metadata', () => {
      expect(
        canDeleteOfflineMachine({
          machine: createMachine({ id: 'machine-local' as MachineId }),
          isOnline: false,
          currentUserId,
          localMachineId: 'machine-local' as MachineId,
          canManageAllMachines: false,
        })
      ).toBe(true);
    });

    it('allows admins to delete other users offline machines', () => {
      expect(
        canDeleteOfflineMachine({
          machine: createMachine({ ownerUserId: otherUserId }),
          isOnline: false,
          currentUserId,
          localMachineId: null,
          canManageAllMachines: true,
        })
      ).toBe(true);
    });

    it('rejects deleting other users offline machines for regular members', () => {
      expect(
        canDeleteOfflineMachine({
          machine: createMachine({ ownerUserId: otherUserId }),
          isOnline: false,
          currentUserId,
          localMachineId: null,
          canManageAllMachines: false,
        })
      ).toBe(false);
    });

    it('prepares deletion checks from the latest metadata and blocks online machines', () => {
      const machineId = 'machine-1' as MachineId;

      const prepared = prepareMachineForDeletion({
        machine: createMachine({
          id: machineId,
          ownerUserId: otherUserId,
        }),
        latestMeta: {
          id: 'stale-id-from-meta' as MachineId,
          ownerUserId: currentUserId,
        },
      });

      expect(prepared.id).toBe(machineId);
      expect(prepared.ownerUserId).toBe(currentUserId);
      expect(
        evaluateMachineDeletion({
          machine: prepared,
          isOnline: true,
          currentUserId,
          localMachineId: null,
          canManageAllMachines: false,
        }).type
      ).toBe('online');
      expect(
        evaluateMachineDeletion({
          machine: prepared,
          isOnline: false,
          currentUserId,
          localMachineId: null,
          canManageAllMachines: false,
        }).type
      ).toBe('allowed');
    });
  });
});

describe('machine-flock-machine-meta-overlay', () => {
  describe('machine Flock machine meta overlay', () => {
    it('hides local projects with pending delete commands', () => {
      const machineId = 'machine-1' as MachineId;
      const deletedLocalProjectId = 'project-deleted' as LocalProjectId;
      const visibleLocalProjectId = 'project-visible' as LocalProjectId;
      const machine: MachineViewMeta = {
        id: machineId,
        name: 'Machine',
        cliVersion: '',
        os: '',
        sessions: [],
        localProjects: {
          [deletedLocalProjectId]: {
            id: deletedLocalProjectId,
            name: 'legacy deleted',
            rootPath: '/legacy-deleted',
            createdAtMs: 1,
          },
          [visibleLocalProjectId]: {
            id: visibleLocalProjectId,
            name: 'legacy visible',
            rootPath: '/legacy-visible',
            createdAtMs: 2,
          },
        },
      };
      const projectRow = {
        key: machineFlockKeys.localProject(deletedLocalProjectId),
        value: {
          id: deletedLocalProjectId,
          name: 'flock deleted',
          rootPath: '/flock-deleted',
          createdAtMs: 3,
        },
      } as const;
      const deleteRow = {
        key: machineFlockKeys.deleteLocalProjectCommand(deletedLocalProjectId),
        value: buildMachineDeleteLocalProjectCommand({ requestedAt: 4 }),
      } as const;

      const next = mergeMachineFlockMachineMeta(
        new Map([[machineId, machine]]),
        new Map([
          [
            machineId,
            {
              [serializeMachineFlockKey(projectRow.key)]: projectRow,
              [serializeMachineFlockKey(deleteRow.key)]: deleteRow,
            },
          ],
        ])
      );

      expect(next.get(machineId)?.localProjects).toEqual({
        [visibleLocalProjectId]: machine.localProjects?.[visibleLocalProjectId],
      });
    });

    it('merges rate limit rows and filters legacy plan-name entries', () => {
      const machineId = 'machine-1' as MachineId;
      const configId = 'config-codex' as AgentConfigId;
      const legacyPlanKey = getRateLimitEntryKey('codex', 'pro');
      const currentKey = getRateLimitEntryKey('codex', 'codex_bengalfox', configId);
      const machine: MachineViewMeta = {
        id: machineId,
        name: 'Machine',
        cliVersion: '',
        os: '',
        sessions: [],
        raceLimits: {
          codex: { used: 1 },
          [legacyPlanKey]: { used: 2 },
          [currentKey]: { used: 3 },
        },
      };
      const row = {
        key: machineFlockKeys.rateLimit(configId, 'codex', 'codex_bengalfox'),
        value: {
          limitId: 'codex_bengalfox',
          used: 4,
        },
      } as const;

      const next = mergeMachineFlockMachineMeta(
        new Map([[machineId, machine]]),
        new Map([
          [
            machineId,
            {
              [serializeMachineFlockKey(row.key)]: row,
            },
          ],
        ])
      );

      expect(next.get(machineId)?.raceLimits).toEqual({
        [currentKey]: row.value,
      });
    });
  });
});
