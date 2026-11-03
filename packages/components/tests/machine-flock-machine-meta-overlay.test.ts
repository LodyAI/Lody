import { describe, expect, it } from 'vitest';
import { buildMachineDeleteLocalProjectCommand, getRateLimitEntryKey, machineFlockKeys, serializeMachineFlockKey, type AgentConfigId, type LocalProjectId, type MachineId, type MachineViewMeta } from '@lody/shared';

import { mergeMachineFlockMachineMeta } from '../src/lib/machine-flock-machine-meta-overlay';

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
