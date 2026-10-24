import { describe, expect, it } from 'vitest';
import type {
  LocalProjectId,
  MachineId,
  ProjectId,
  ProjectMemberId,
  ProjectMemberSource,
} from '@lody/shared';
import {
  addProjectGroupMember,
  applySourceSelection,
  applyDetectedProjectSubmodules,
  buildProjectGroupFormValue,
  buildWorkspaceProjectFromForm,
  collectProjectSubmoduleDescendants,
  EMPTY_PROJECT_GROUP_FORM_VALUE,
  removeProjectGroupMember,
  suggestProjectMemberDir,
  updateProjectGroupMemberPlacement,
  upgradeProjectGroupRepositoryMembers,
  validateProjectGroupForm,
  type ProjectGroupFormValue,
  type ProjectGroupMemberDraft,
} from '@/lib/project-group-form';

const PROJECT_ID = '0b9a4a6e-6d2f-4f3a-9a53-0f3d1f0b2c11' as ProjectId;
const github = (repoFullName: string): ProjectMemberSource => ({ kind: 'github', repoFullName });
const local = (id: string): ProjectMemberSource => ({
  kind: 'local',
  machineId: 'machine-1' as MachineId,
  localProjectId: id as LocalProjectId,
});

function ids() {
  let next = 0;
  return () => `m${++next}` as ProjectMemberId;
}

const labelOf = (member: ProjectGroupMemberDraft) =>
  member.source.kind === 'github' ? member.source.repoFullName : member.source.localProjectId;
const repoOf = (member: ProjectGroupMemberDraft) =>
  member.source.kind === 'github' ? member.source.repoFullName : undefined;

function threeRepos(): ProjectGroupFormValue {
  const createId = ids();
  let value: ProjectGroupFormValue = { ...EMPTY_PROJECT_GROUP_FORM_VALUE, name: 'Shop' };
  value = addProjectGroupMember(value, github('acme/web'), 'acme/web', createId);
  value = addProjectGroupMember(value, github('acme/api'), 'acme/api', createId);
  value = addProjectGroupMember(value, github('acme/proto'), 'acme/proto', createId);
  return value;
}

describe('project group form', () => {
  it('derives a safe directory name from the repository name', () => {
    expect(suggestProjectMemberDir('acme/web')).toBe('web');
    expect(suggestProjectMemberDir('My Folder.')).toBe('My Folder');
    expect(suggestProjectMemberDir('..')).toBe('repo');
  });

  it('gives a colliding directory a numbered suffix and ignores a source added twice', () => {
    const createId = ids();
    let value = addProjectGroupMember(
      EMPTY_PROJECT_GROUP_FORM_VALUE,
      github('acme/app'),
      'acme/app',
      createId
    );
    value = addProjectGroupMember(value, github('other/app'), 'other/app', createId);
    value = addProjectGroupMember(value, github('ACME/app'), 'acme/app', createId);
    expect(value.members.map((member) => member.placement)).toEqual([
      { kind: 'root', dir: 'app' },
      { kind: 'root', dir: 'app-2' },
    ]);
  });

  it('turns a detected submodule into a submodule member, but never overrides a user choice', () => {
    const value = threeRepos();
    const [web, api, proto] = value.members;
    const detected = new Map([[api!.id, [{ path: 'proto', repoFullName: 'acme/proto' }]]]);

    const applied = applyDetectedProjectSubmodules(value, detected, repoOf, labelOf);
    expect(applied.members[2]).toMatchObject({
      placement: { kind: 'submodule', parent: api!.id, path: 'proto' },
      placementOrigin: 'detected',
    });

    const userFlat = updateProjectGroupMemberPlacement(value, proto!.id, {
      kind: 'root',
      dir: 'proto',
    });
    expect(applyDetectedProjectSubmodules(userFlat, detected, repoOf, labelOf)).toBe(userFlat);
    expect(web!.placement).toEqual({ kind: 'root', dir: 'web' });
  });

  it('reverts a detected submodule that is no longer declared', () => {
    const value = threeRepos();
    const api = value.members[1]!;
    const applied = applyDetectedProjectSubmodules(
      value,
      new Map([[api.id, [{ path: 'proto', repoFullName: 'acme/proto' }]]]),
      repoOf,
      labelOf
    );
    const reverted = applyDetectedProjectSubmodules(applied, new Map(), repoOf, labelOf);
    expect(reverted.members[2]!.placement).toEqual({ kind: 'root', dir: 'proto' });
  });

  it('keeps the previous state when detection would create a cycle', () => {
    const createId = ids();
    let value = addProjectGroupMember(
      EMPTY_PROJECT_GROUP_FORM_VALUE,
      github('acme/a'),
      'acme/a',
      createId
    );
    value = addProjectGroupMember(value, github('acme/b'), 'acme/b', createId);
    const [a, b] = value.members;
    const detected = new Map([
      [a!.id, [{ path: 'b', repoFullName: 'acme/b' }]],
      [b!.id, [{ path: 'a', repoFullName: 'acme/a' }]],
    ]);
    expect(applyDetectedProjectSubmodules(value, detected, repoOf, labelOf)).toBe(value);
  });

  it('promotes submodule children to top level when their parent is removed', () => {
    const value = threeRepos();
    const api = value.members[1]!;
    const proto = value.members[2]!;
    const nested = updateProjectGroupMemberPlacement(value, proto.id, {
      kind: 'submodule',
      parent: api.id,
      path: 'proto',
    });
    const removed = removeProjectGroupMember(nested, api.id, labelOf);
    expect(removed.members.map((member) => member.placement)).toEqual([
      { kind: 'root', dir: 'web' },
      { kind: 'root', dir: 'proto' },
    ]);
  });

  it('reports per-member errors for duplicate and invalid directories', () => {
    const value = threeRepos();
    const [web, api, proto] = value.members;
    let edited = updateProjectGroupMemberPlacement(value, api!.id, { kind: 'root', dir: 'WEB' });
    edited = updateProjectGroupMemberPlacement(edited, proto!.id, { kind: 'root', dir: 'a/b' });
    const result = validateProjectGroupForm({ ...edited, name: ' ' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['name_required']);
    expect(result.memberErrors.get(web!.id)).toBe('dir_duplicate');
    expect(result.memberErrors.get(api!.id)).toBe('dir_duplicate');
    expect(result.memberErrors.get(proto!.id)).toBe('dir_invalid');
  });

  it('flags a local folder and a GitHub repository that are the same repository', () => {
    const createId = ids();
    let value: ProjectGroupFormValue = { ...EMPTY_PROJECT_GROUP_FORM_VALUE, name: 'Shop' };
    value = addProjectGroupMember(value, github('acme/web'), 'acme/web', createId);
    value = addProjectGroupMember(value, local('web-checkout'), 'web-checkout', createId);
    const result = validateProjectGroupForm(value, () => ({ repoFullName: 'acme/web' }));
    expect(result.memberErrors.get(value.members[1]!.id)).toBe('duplicate_repository');
  });

  it('builds a contract-valid row and only bumps the revision when content changes', () => {
    const value = { ...threeRepos(), instructions: '  web is the frontend  ' };
    const created = buildWorkspaceProjectFromForm(value, {
      id: PROJECT_ID,
      ownerUserId: 'user-1',
      now: 1000,
    });
    expect(created).toMatchObject({
      v: 1,
      id: PROJECT_ID,
      name: 'Shop',
      instructions: 'web is the frontend',
      revision: 1,
      createdAtMs: 1000,
    });

    const reopened = buildProjectGroupFormValue(created!);
    const unchanged = buildWorkspaceProjectFromForm(reopened, {
      id: PROJECT_ID,
      existing: created,
      ownerUserId: 'someone-else',
      now: 2000,
    });
    expect(unchanged).toBe(created);

    const renamed = buildWorkspaceProjectFromForm(
      { ...reopened, name: 'Storefront' },
      { id: PROJECT_ID, existing: created, ownerUserId: 'someone-else', now: 2000 }
    );
    expect(renamed).toMatchObject({ revision: 2, ownerUserId: 'user-1', createdAtMs: 1000 });
  });

  it('collects nested submodule descendants', () => {
    const members = [
      { id: 'a' as ProjectMemberId, placement: { kind: 'root', dir: 'a' } as const },
      {
        id: 'b' as ProjectMemberId,
        placement: { kind: 'submodule', parent: 'a' as ProjectMemberId, path: 'b' } as const,
      },
      {
        id: 'c' as ProjectMemberId,
        placement: { kind: 'submodule', parent: 'b' as ProjectMemberId, path: 'c' } as const,
      },
    ];
    expect([...collectProjectSubmoduleDescendants(members, 'a' as ProjectMemberId)]).toEqual([
      'b',
      'c',
    ]);
  });

  it('adds ticked sources and removes unticked ones from one multi-select change', () => {
    const value = threeRepos();
    const option = (repo: string) => ({
      key: `github:${repo}`,
      source: github(repo),
      label: repo,
    });
    const previous = ['acme/web', 'acme/api', 'acme/proto'].map(option);
    const api = value.members[1]!;
    const proto = value.members[2]!;
    const nested = updateProjectGroupMemberPlacement(value, proto.id, {
      kind: 'submodule',
      parent: api.id,
      path: 'proto',
    });
    const next = applySourceSelection(
      nested,
      previous,
      [option('acme/web'), option('acme/proto'), option('acme/docs')],
      labelOf,
      ids()
    );
    expect(next.members.map((member) => labelOf(member))).toEqual([
      'acme/web',
      'acme/proto',
      'acme/docs',
    ]);
    // Its parent left, so the submodule becomes a top-level directory.
    expect(next.members[1]!.placement).toEqual({ kind: 'root', dir: 'proto' });
  });

  it('rejects local members on a machine other than the first local member', () => {
    const createId = ids();
    let value: ProjectGroupFormValue = { ...EMPTY_PROJECT_GROUP_FORM_VALUE, name: 'Shop' };
    value = addProjectGroupMember(value, local('web'), 'web', createId);
    value = addProjectGroupMember(value, github('acme/api'), 'acme/api', createId);
    value = addProjectGroupMember(
      value,
      {
        kind: 'local',
        machineId: 'machine-2' as MachineId,
        localProjectId: 'ios' as LocalProjectId,
      },
      'ios',
      createId
    );
    const result = validateProjectGroupForm(value);
    expect(result.valid).toBe(false);
    expect([...result.memberErrors]).toEqual([[value.members[2]!.id, 'machine_mismatch']]);
  });

  it('turns local members with a published remote into repository members in place', () => {
    const createId = ids();
    let value: ProjectGroupFormValue = { ...EMPTY_PROJECT_GROUP_FORM_VALUE, name: 'Shop' };
    value = addProjectGroupMember(value, local('web'), 'web', createId);
    value = addProjectGroupMember(value, local('notes'), 'notes', createId);
    value = addProjectGroupMember(value, local('api'), 'api', createId);
    value = addProjectGroupMember(value, github('acme/api'), 'acme/api', createId);
    value = updateProjectGroupMemberPlacement(value, value.members[0]!.id, {
      kind: 'root',
      dir: 'frontend',
    });
    const remotes: Record<string, string> = { web: 'acme/web', api: 'Acme/API' };
    const next = upgradeProjectGroupRepositoryMembers(
      value,
      (source) => remotes[source.localProjectId]
    );
    // web keeps its id and the directory the user chose.
    expect(next.members[0]).toEqual({
      ...value.members[0]!,
      source: { kind: 'github', repoFullName: 'acme/web', preferLocal: true },
    });
    // notes has no remote; api is already in the group from GitHub, so the
    // folder stays and validation reports the duplicate.
    expect(next.members.slice(1)).toEqual(value.members.slice(1));
    expect(
      upgradeProjectGroupRepositoryMembers(next, (source) => remotes[source.localProjectId])
    ).toBe(next);
    expect(upgradeProjectGroupRepositoryMembers(value, () => undefined)).toBe(value);
  });
});
