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
  resolveProjectGroupLaunchTarget,
  selectProjectGroupMembers,
} from '@/lib/project-group-launch';

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
  it('drops the submodules of an unticked parent', () => {
    expect(
      selectProjectGroupMembers(project, new Set([id('api')])).map((member) => member.id)
    ).toEqual(['web']);
  });

  it('pins the machine that holds the local members, and rejects two machines', () => {
    expect(resolveProjectGroupLaunchTarget(project, new Set())).toMatchObject({
      kind: 'ready',
      machineId: 'machine-1',
    });
    expect(resolveProjectGroupLaunchTarget(project, new Set([id('web')]))).toMatchObject({
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
    expect(resolveProjectGroupLaunchTarget(split, new Set())).toEqual({
      kind: 'machines_conflict',
      machineIds: ['machine-1', 'machine-2'],
    });
    expect(resolveProjectGroupLaunchTarget(project, new Set([id('web'), id('api')])).kind).toBe(
      'empty'
    );
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
});
