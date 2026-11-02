import { describe, expect, it } from 'vitest';
import {
  buildSessionProjectRun,
  PROJECT_SUBMODULE_BASE,
  SessionProjectRunSchema,
  type LocalProjectId,
  type MachineId,
  type ProjectId,
  type ProjectMemberId,
  type WorkspaceProject,
} from '@lody/shared';
import {
  buildProjectGroupProjectRef,
  buildProjectRepositoryCopyIndex,
  getProjectGroupMachineAvailability,
  resolveProjectGroupLaunchTarget,
} from '@/lib/project-group-launch';
import { placeProjectGroups } from '@/lib/project-group-placement';

const id = (value: string) => value as ProjectMemberId;
const project: WorkspaceProject = {
  v: 1,
  id: '0b9a4a6e-6d2f-4f3a-9a53-0f3d1f0b2c11' as ProjectId,
  name: 'Shop',
  instructions: 'web is the frontend',
  ownerUserId: 'user-1',
  createdAtMs: 1,
  revision: 1,
  members: [
    {
      id: id('web'),
      source: {
        kind: 'local',
        machineId: 'machine-1' as MachineId,
        localProjectId: 'web' as LocalProjectId,
      },
      placement: { kind: 'root', dir: 'web' },
    },
    {
      id: id('api'),
      source: { kind: 'github', repoFullName: 'acme/api', baseBranch: 'develop' },
      placement: { kind: 'root', dir: 'api' },
    },
    {
      id: id('proto'),
      source: { kind: 'github', repoFullName: 'acme/proto' },
      placement: { kind: 'submodule', parent: id('api'), path: 'proto' },
    },
  ],
};

describe('project group launch', () => {
  it('launches every member, pinned to the machine of the local ones', () => {
    const target = resolveProjectGroupLaunchTarget(project);
    expect(target).toMatchObject({ kind: 'ready', machineId: 'machine-1' });
    // The whole group, submodules included: there is no per-conversation subset.
    expect(target.kind === 'ready' && target.members.map((member) => member.id)).toEqual([
      'web',
      'api',
      'proto',
    ]);
    expect(resolveProjectGroupLaunchTarget({ members: project.members.slice(1) })).toMatchObject({
      kind: 'ready',
      machineId: null,
    });
    const split: WorkspaceProject = {
      ...project,
      members: [
        project.members[0]!,
        {
          ...project.members[0]!,
          id: id('docs'),
          source: {
            kind: 'local',
            machineId: 'machine-2' as MachineId,
            localProjectId: 'docs' as LocalProjectId,
          },
          placement: { kind: 'root', dir: 'docs' },
        },
      ],
    };
    expect(resolveProjectGroupLaunchTarget(split)).toEqual({
      kind: 'machines_conflict',
      machineIds: ['machine-1', 'machine-2'],
    });
  });

  // The snapshot itself is the shared contract's; this pins the shape the
  // landing relies on.
  it('freezes a snapshot the shared contract accepts', () => {
    const run = buildSessionProjectRun(
      project,
      project.members.map((member) => member.id)
    );
    expect(SessionProjectRunSchema.safeParse(run).success).toBe(true);
    expect(run).toMatchObject({
      id: project.id,
      name: 'Shop',
      instructions: 'web is the frontend',
      root: `project-shop-${project.id}`,
    });
    expect(run!.members[id('proto')]).toMatchObject({
      o: 2,
      path: 'api/proto',
      base: PROJECT_SUBMODULE_BASE,
    });
    expect(run!.members[id('api')]!.base).toBe('develop');
  });

  it('leaves one remaining member to an ordinary single-project conversation', () => {
    expect(buildSessionProjectRun(project, [project.members[0]!.id])).toBeUndefined();
    expect(buildProjectGroupProjectRef(project.members[0]!)).toEqual({
      kind: 'local',
      localProjectId: 'web',
      useWorktree: true,
    });
    expect(buildProjectGroupProjectRef(project.members[1]!)).toEqual({
      kind: 'github',
      repoFullName: 'acme/api',
      branch: 'develop',
    });
    // The legacy ProjectRef rejects an empty branch; HEAD is the placeholder
    // the daemon resolves to the default branch.
    expect(buildProjectGroupProjectRef(project.members[2]!)).toMatchObject({ branch: 'HEAD' });
  });

  it('offers a group on the machines it can run on and names what each lacks', () => {
    const m1 = 'machine-1' as MachineId;
    const m2 = 'machine-2' as MachineId;
    const copies = buildProjectRepositoryCopyIndex([
      { machineId: m1, project: { githubRepoFullName: 'Acme/Web' } },
      { machineId: m2, project: { githubRepoFullName: 'acme/web' } },
      { machineId: m2, project: { githubRepoFullName: 'acme/api' } },
      { machineId: m1, project: {} },
    ]);
    const portable: WorkspaceProject = {
      ...project,
      members: [
        {
          id: id('web'),
          source: { kind: 'github', repoFullName: 'acme/web', preferLocal: true },
          placement: { kind: 'root', dir: 'web' },
        },
        {
          id: id('api'),
          source: { kind: 'github', repoFullName: 'acme/api', preferLocal: true },
          placement: { kind: 'root', dir: 'api' },
        },
        // A plain GitHub member is always cloned; it is never "missing".
        {
          id: id('docs'),
          source: { kind: 'github', repoFullName: 'acme/docs' },
          placement: { kind: 'root', dir: 'docs' },
        },
      ],
    };
    const on = (machineId: MachineId | null, group = portable) =>
      getProjectGroupMachineAvailability(group, machineId, copies);
    expect(on(m2)).toEqual({ kind: 'available', missing: new Set() });
    expect(on(m1)).toEqual({ kind: 'available', missing: new Set([id('api')]) });
    expect(on(null)).toEqual({ kind: 'available', missing: new Set() });

    // The local web folder binds the original group to machine-1.
    expect(on(m2, project)).toEqual({ kind: 'elsewhere', machineId: m1 });
    expect(on(m1, project).kind).toBe('available');
    const split: WorkspaceProject = {
      ...project,
      members: [
        ...project.members,
        {
          id: id('ios'),
          source: { kind: 'local', machineId: m2, localProjectId: 'ios' as LocalProjectId },
          placement: { kind: 'root', dir: 'ios' },
        },
      ],
    };
    expect(on(m1, split)).toEqual({ kind: 'conflict' });
  });
});

describe('project placement in the sidebar', () => {
  it('puts a machine-bound project under its listed machine and the rest with GitHub', () => {
    const m1 = 'machine-1' as MachineId;
    const portable = {
      id: 'portable' as ProjectId,
      members: [
        {
          id: id('web'),
          source: { kind: 'github' as const, repoFullName: 'acme/web', preferLocal: true as const },
          placement: { kind: 'root' as const, dir: 'web' },
        },
      ],
    };
    // `project` holds a local folder on machine-1.
    const offList = {
      id: 'elsewhere' as ProjectId,
      members: [
        {
          id: id('ios'),
          source: {
            kind: 'local' as const,
            machineId: 'machine-9' as MachineId,
            localProjectId: 'ios' as LocalProjectId,
          },
          placement: { kind: 'root' as const, dir: 'ios' },
        },
      ],
    };
    const state = (projectId: string) => ({ projectId });
    const row = (sessionId: string, projectGroupId: string) => ({
      sessionId,
      projectGroup: { id: projectGroupId },
    });
    const placed = placeProjectGroups({
      projects: [project, portable, offList],
      states: [state(project.id), state(portable.id), state(offList.id)],
      sessions: [
        row('a', project.id),
        row('b', portable.id),
        row('c', 'deleted'),
        row('d', offList.id),
      ],
      listedMachineIds: new Set([m1]),
    });
    expect(placed.byMachine.get(m1)).toEqual({
      states: [state(project.id)],
      sessions: [row('a', project.id)],
    });
    // A machine the sidebar does not list cannot hold it; a deleted project's
    // conversations have no machine either.
    expect(placed.anywhere).toEqual({
      states: [state(portable.id), state(offList.id)],
      sessions: [row('b', portable.id), row('c', 'deleted'), row('d', offList.id)],
    });
  });
});
