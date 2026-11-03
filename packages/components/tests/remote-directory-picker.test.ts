import { describe, expect, it } from 'vitest';
import type { LocalProjectBrowseDirectoryResult, MachineId, MachineViewMeta } from '@lody/shared';

import { buildAddLocalProjectMachineOptions } from '../src/components/local-projects/local-project-machine-options';

import type { MachineVisibilityAccess } from '../src/lib/visible-machine-index';

function directoryPage(
  path: string,
  names: string[],
  nextCursor?: string
): LocalProjectBrowseDirectoryResult {
  return {
    path,
    parentPath: '/home/user',
    entries: names.map((name) => ({
      name,
      absolutePath: `${path}/${name}`,
      isSymlink: false,
      hidden: false,
    })),
    truncated: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function machine(id: string, name: string, ownerUserId: string): MachineViewMeta {
  return {
    id: id as MachineId,
    name,
    ownerUserId,
    sessions: [],
    raceLimits: {},
  };
}

function access(machineId: string, ownerUserId: string): MachineVisibilityAccess {
  return {
    machineId,
    ownerUserId,
    sharedWithTeam: ownerUserId !== 'user-me',
    updatedAt: 1,
  };
}

describe('buildAddLocalProjectMachineOptions', () => {
  it('keeps teammates’ visible machines and marks them owner-only', () => {
    const ownMachine = machine('machine-own', 'My Mac', 'user-me');
    ownMachine.protocolCapabilities = { localProjectCreateDirectory: 1, projectFolderSelection: 1 };
    const teammateMachine = machine('machine-team', 'Build server', 'user-alex');
    const visibleMachines = new Map([
      [ownMachine.id, ownMachine],
      [teammateMachine.id, teammateMachine],
    ]);
    const accessByMachineId = new Map([
      [ownMachine.id, access(ownMachine.id, 'user-me')],
      [teammateMachine.id, access(teammateMachine.id, 'user-alex')],
    ]);

    expect(
      buildAddLocalProjectMachineOptions({
        visibleMachines,
        accessByMachineId,
        onlineMachineIds: new Set([ownMachine.id, teammateMachine.id]),
        localMachineId: null,
        currentUserId: 'user-me',
        ownerNameByUserId: new Map([
          ['user-me', 'Zoe'],
          ['user-alex', 'Alex Chen'],
        ]),
      })
    ).toEqual([
      {
        id: ownMachine.id,
        name: 'My Mac',
        online: true,
        supportsCreateDirectory: true,
        supportsProjectFolderSelection: true,
        canAddProjects: true,
        ownerName: 'Zoe',
      },
      {
        id: teammateMachine.id,
        name: 'Build server',
        online: true,
        supportsCreateDirectory: false,
        supportsProjectFolderSelection: false,
        canAddProjects: false,
        ownerName: 'Alex Chen',
      },
    ]);
  });

  it('treats the locally probed machine as online without cloud presence', () => {
    const ownMachine = machine('machine-own', 'My Mac', 'user-me');

    expect(
      buildAddLocalProjectMachineOptions({
        visibleMachines: new Map([[ownMachine.id, ownMachine]]),
        accessByMachineId: new Map([[ownMachine.id, access(ownMachine.id, 'user-me')]]),
        onlineMachineIds: new Set(),
        localMachineId: ownMachine.id,
        currentUserId: 'user-me',
        ownerNameByUserId: new Map([['user-me', 'Zoe']]),
      })
    ).toEqual([
      {
        id: ownMachine.id,
        name: 'My Mac',
        online: true,
        supportsCreateDirectory: false,
        supportsProjectFolderSelection: false,
        canAddProjects: true,
        ownerName: 'Zoe',
      },
    ]);
  });

  it('does not classify ownership until the current user resolves', () => {
    const ownMachine = machine('machine-own', 'My Mac', 'user-me');

    expect(
      buildAddLocalProjectMachineOptions({
        visibleMachines: new Map([[ownMachine.id, ownMachine]]),
        accessByMachineId: new Map([[ownMachine.id, access(ownMachine.id, 'user-me')]]),
        onlineMachineIds: new Set([ownMachine.id]),
        localMachineId: null,
        currentUserId: null,
        ownerNameByUserId: new Map([['user-me', 'Zoe']]),
      })
    ).toEqual([]);
  });
});
