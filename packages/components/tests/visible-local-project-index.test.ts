import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId, MachineViewMeta } from '@lody/shared';
import { buildProjectRepositoryCopyIndex } from '../src/lib/project-group-launch';
import type { MachineVisibilityAccess } from '../src/lib/visible-machine-index';
import {
  buildVisibleLocalProjectIndex,
  getLocalProjectVisibilityKey,
} from '../src/lib/visible-local-project-index';

const machineId = 'machine-1' as MachineId;
const projectId = 'project-1' as LocalProjectId;

function machineMeta(overrides: Partial<MachineViewMeta> = {}): MachineViewMeta {
  return {
    id: machineId,
    name: 'Machine 1',
    ownerUserId: 'user-1',
    hostType: 'user',
    cliVersion: '1.0.0',
    os: 'darwin',
    sessions: [],
    raceLimits: {},
    localProjects: {
      [projectId]: {
        id: projectId,
        name: 'Lody',
        rootPath: '/repo/lody',
        createdAtMs: 1,
      },
    },
    ...overrides,
  };
}

function machineAccess(overrides: Partial<MachineVisibilityAccess> = {}): MachineVisibilityAccess {
  return {
    machineId,
    ownerUserId: 'user-1',
    sharedWithTeam: false,
    updatedAt: 10,
    ...overrides,
  };
}

describe('visible local project index', () => {
  it('hides member-only entries without removing access or repository copies', () => {
    const machine = machineMeta();
    machine.localProjects![projectId] = {
      ...machine.localProjects![projectId]!,
      standaloneVisible: false,
      githubRepoFullName: 'acme/api',
    };
    const args = {
      rawMachines: new Map([[machineId, machine]]),
      machineAccessByMachineId: new Map([[machineId, machineAccess()]]),
      convexAccessRows: [],
      currentUserId: 'user-1',
      isLoading: false,
    };
    const result = buildVisibleLocalProjectIndex(args);
    const key = getLocalProjectVisibilityKey(machineId, projectId);
    expect(result.projects.size).toBe(0);
    expect(result.accessByProjectKey.has(key)).toBe(true);
    expect(result.registeredProjects.get(key)?.project.rootPath).toBe('/repo/lody');
    expect(buildProjectRepositoryCopyIndex(result.registeredProjects.values()).size).toBe(1);
    expect(
      buildVisibleLocalProjectIndex({ ...args, includeMemberOnly: true }).projects.has(key)
    ).toBe(true);
  });

  it('synthesizes access for the current user projects without Convex rows', () => {
    const result = buildVisibleLocalProjectIndex({
      rawMachines: new Map([[machineId, machineMeta()]]),
      machineAccessByMachineId: new Map([[machineId, machineAccess()]]),
      convexAccessRows: [],
      currentUserId: 'user-1',
      isLoading: false,
    });

    const key = getLocalProjectVisibilityKey(machineId, projectId);
    expect(result.projects.get(key)?.project.name).toBe('Lody');
    expect(result.projects.get(key)?.isMachineRegistered).toBe(true);
    expect(result.accessByProjectKey.get(key)).toEqual({
      machineId,
      localProjectId: projectId,
      ownerUserId: 'user-1',
      sharedWithTeam: false,
      updatedAt: 0,
    });
  });

  it('marks a project as unavailable for cloud mutations while machine access is synthetic', () => {
    const result = buildVisibleLocalProjectIndex({
      rawMachines: new Map([[machineId, machineMeta()]]),
      machineAccessByMachineId: new Map([[machineId, machineAccess({ updatedAt: 0 })]]),
      convexAccessRows: [],
      currentUserId: 'user-1',
      isLoading: false,
    });

    const key = getLocalProjectVisibilityKey(machineId, projectId);
    expect(result.projects.get(key)?.project.name).toBe('Lody');
    expect(result.projects.get(key)?.isMachineRegistered).toBe(false);
  });

  it('keeps shared team projects from Convex for other users', () => {
    const result = buildVisibleLocalProjectIndex({
      rawMachines: new Map([
        [
          machineId,
          machineMeta({
            ownerUserId: 'user-2',
          }),
        ],
      ]),
      machineAccessByMachineId: new Map([
        [
          machineId,
          machineAccess({
            ownerUserId: 'user-2',
            sharedWithTeam: true,
          }),
        ],
      ]),
      convexAccessRows: [
        {
          machineId,
          localProjectId: projectId,
          ownerUserId: 'user-2',
          sharedWithTeam: true,
          updatedAt: 10,
        },
      ],
      currentUserId: 'user-1',
      isLoading: false,
    });

    const key = getLocalProjectVisibilityKey(machineId, projectId);
    expect(result.projects.get(key)?.machine.ownerUserId).toBe('user-2');
    expect(result.accessByProjectKey.get(key)?.sharedWithTeam).toBe(true);
  });

  it('drops rows whose project no longer exists in machine metadata', () => {
    const result = buildVisibleLocalProjectIndex({
      rawMachines: new Map([
        [
          machineId,
          machineMeta({
            localProjects: {},
          }),
        ],
      ]),
      machineAccessByMachineId: new Map([[machineId, machineAccess()]]),
      convexAccessRows: [
        {
          machineId,
          localProjectId: projectId,
          ownerUserId: 'user-1',
          sharedWithTeam: true,
          updatedAt: 10,
        },
      ],
      currentUserId: 'user-1',
      isLoading: false,
    });

    expect(result.projects.size).toBe(0);
  });

  it('uses machine access ownership to synthesize fallback entries after owner drift', () => {
    const result = buildVisibleLocalProjectIndex({
      rawMachines: new Map([
        [
          machineId,
          machineMeta({
            ownerUserId: 'old-owner',
          }),
        ],
      ]),
      machineAccessByMachineId: new Map([
        [
          machineId,
          machineAccess({
            ownerUserId: 'new-owner',
          }),
        ],
      ]),
      convexAccessRows: [],
      currentUserId: 'new-owner',
      isLoading: false,
    });

    const key = getLocalProjectVisibilityKey(machineId, projectId);
    expect(result.accessByProjectKey.get(key)?.ownerUserId).toBe('new-owner');
    expect(result.projects.get(key)?.machine.ownerUserId).toBe('new-owner');
  });
});
