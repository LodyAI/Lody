import { describe, expect, it } from 'vitest';
import {
  buildMachineDeleteLocalProjectCommand,
  getAcpCapabilityCacheKey,
  getRateLimitEntryKey,
  machineFlockKeys,
  serializeMachineFlockKey,
  type AgentConfigId,
  type LocalProjectId,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';

import { mergeMachineFlockMachineMeta } from '../src/lib/machine-flock-machine-meta-overlay';

describe('machine Flock machine meta overlay', () => {
  it('merges local project rows over legacy machine meta', () => {
    const machineId = 'machine-1' as MachineId;
    const localProjectId = 'project-1' as LocalProjectId;
    const machine: MachineViewMeta = {
      id: machineId,
      name: 'Machine',
      cliVersion: '',
      os: '',
      sessions: [],
      localProjects: {
        [localProjectId]: {
          id: localProjectId,
          name: 'legacy',
          rootPath: '/legacy',
          createdAtMs: 1,
        },
      },
    };
    const row = {
      key: machineFlockKeys.localProject(localProjectId),
      value: {
        id: localProjectId,
        name: 'flock',
        rootPath: '/flock',
        createdAtMs: 2,
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

    expect(next.get(machineId)?.localProjects?.[localProjectId]).toEqual(row.value);
  });

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

  it('merges ACP capability rows over legacy machine meta', () => {
    const machineId = 'machine-1' as MachineId;
    const configId = 'config-1' as AgentConfigId;
    const cacheKey = getAcpCapabilityCacheKey(configId);
    const machine: MachineViewMeta = {
      id: machineId,
      name: 'Machine',
      cliVersion: '',
      os: '',
      sessions: [],
      acpCapabilities: {
        [cacheKey]: {
          cliType: 'custom',
          agentType: 'agent',
          cacheVersion: 1,
          modes: [],
          models: [],
          fetchedAt: 1,
        },
      },
    };
    const row = {
      key: machineFlockKeys.acpCapability(configId),
      value: {
        cliType: 'custom',
        agentType: 'agent',
        cacheVersion: 2,
        sourceVersion: 'v2',
        modes: [],
        models: [],
        fetchedAt: 2,
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

    expect(next.get(machineId)?.acpCapabilities?.[cacheKey]).toEqual(row.value);
  });

  it('merges rate limit rows and filters legacy plan-name entries', () => {
    const machineId = 'machine-1' as MachineId;
    const legacyPlanKey = getRateLimitEntryKey('codex', 'pro');
    const currentKey = getRateLimitEntryKey('codex', 'codex_bengalfox');
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
      key: machineFlockKeys.rateLimit('codex', 'codex_bengalfox'),
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

  it('keeps the same map reference when there are no Flock rows', () => {
    const machines = new Map<MachineId, MachineViewMeta>();
    expect(mergeMachineFlockMachineMeta(machines, new Map())).toBe(machines);
  });
});
