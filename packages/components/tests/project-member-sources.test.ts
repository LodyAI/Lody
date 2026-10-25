import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';
import {
  buildProjectMemberSourceOptions,
  groupProjectMemberSourceOptions,
  type ProjectMemberSourceOption,
} from '@/lib/project-member-sources';

const here = 'machine-1' as MachineId;
const studio = 'machine-2' as MachineId;
const local = (
  machineId: MachineId,
  id: string,
  githubRepoFullName?: string,
  lastOpenedAtMs?: number
) => ({
  machineId,
  machineName: machineId === here ? 'MacBook Pro' : 'Studio',
  online: true,
  project: {
    id: id as LocalProjectId,
    name: id,
    createdAtMs: 1,
    ...(githubRepoFullName ? { githubRepoFullName } : {}),
    ...(lastOpenedAtMs ? { lastOpenedAtMs } : {}),
  },
});

const options = buildProjectMemberSourceOptions({
  localProjects: [
    local(here, 'web', 'acme/web'),
    local(studio, 'web-old', 'acme/web', 1),
    local(studio, 'web-new', 'acme/web', 9),
    local(here, 'notes'),
    local(studio, 'ios'),
  ],
  githubRepositories: [
    { fullName: 'Acme/Web', description: 'Frontend' },
    { fullName: 'acme/api' },
    { fullName: 'acme/proto' },
  ],
});
const byKey = new Map(options.map((option) => [option.key, option]));
const keys = (items: readonly ProjectMemberSourceOption[]) => items.map((option) => option.key);

describe('project member sources', () => {
  it('merges every copy of a repository into one row, in the order the daemon picks', () => {
    expect(keys(options)).toEqual([
      'github:acme/web',
      'github:acme/api',
      'github:acme/proto',
      `local:${studio}:ios`,
      `local:${here}:notes`,
    ]);
    const web = byKey.get('github:acme/web')!;
    // GitHub's spelling wins; copies make it a repository Member.
    expect(web.source).toEqual({ kind: 'github', repoFullName: 'Acme/Web', preferLocal: true });
    expect(web.description).toBe('Frontend');
    // One copy per machine: the most recently opened on Studio.
    expect(web.copies.map((copy) => [copy.machineId, copy.localProjectId])).toEqual([
      [here, 'web'],
      [studio, 'web-new'],
    ]);
    // Every merged folder still resolves, for groups saved before.
    expect(web.localKeys).toEqual([
      `local:${here}:web`,
      `local:${studio}:web-old`,
      `local:${studio}:web-new`,
    ]);
    // Only on GitHub: a plain GitHub Member, cloned wherever it runs.
    expect(byKey.get('github:acme/api')!.source).toEqual({
      kind: 'github',
      repoFullName: 'acme/api',
    });
  });

  it('keeps GitHub-only repositories out of view until searched or selected', () => {
    const layout = (query: string, selected: string[] = []) =>
      groupProjectMemberSourceOptions({
        options,
        selectedKeys: new Set(selected),
        query,
        filter: { kind: 'all' },
        currentMachineId: here,
        boundMachineId: null,
      });
    const idle = layout('');
    expect(idle.groups.map((group) => [group.kind, keys(group.items)])).toEqual([
      ['repositories', ['github:acme/web']],
      ['here', [`local:${here}:notes`]],
      ['elsewhere', [`local:${studio}:ios`]],
    ]);
    expect(idle.hiddenRepositoryCount).toBe(2);
    expect(idle.disabledKeys.size).toBe(0);
    expect(idle.machineIds).toEqual([here, studio]);
    expect(keys(layout('', ['github:acme/api']).groups[0]!.items)).toEqual([
      'github:acme/web',
      'github:acme/api',
    ]);
    expect(layout('pro').hiddenRepositoryCount).toBe(0);
    expect(keys(layout('pro').groups[0]!.items)).toHaveLength(3);
  });

  it('disables folders on other machines once the group is bound, and says so once', () => {
    const layout = groupProjectMemberSourceOptions({
      options,
      selectedKeys: new Set([`local:${here}:notes`]),
      query: '',
      filter: { kind: 'all' },
      currentMachineId: here,
      boundMachineId: here,
    });
    expect([...layout.disabledKeys]).toEqual([`local:${studio}:ios`]);
    expect(layout.groups.find((group) => group.kind === 'elsewhere')?.blockedBy).toBe(here);
    expect(layout.groups.find((group) => group.kind === 'here')?.blockedBy).toBeUndefined();
  });

  it('narrows to one machine, and lists every folder apart when this device runs none', () => {
    const studioOnly = groupProjectMemberSourceOptions({
      options,
      selectedKeys: new Set(),
      query: '',
      filter: { kind: 'machine', machineId: studio },
      currentMachineId: here,
      boundMachineId: null,
    });
    expect(studioOnly.groups.map((group) => [group.kind, keys(group.items)])).toEqual([
      ['repositories', ['github:acme/web']],
      ['machine', [`local:${studio}:ios`]],
    ]);
    expect(studioOnly.hiddenRepositoryCount).toBe(0);

    const web = groupProjectMemberSourceOptions({
      options,
      selectedKeys: new Set(),
      query: '',
      filter: { kind: 'repositories' },
      currentMachineId: null,
      boundMachineId: null,
    });
    expect(web.groups.map((group) => group.kind)).toEqual(['repositories']);

    const browser = groupProjectMemberSourceOptions({
      options,
      selectedKeys: new Set(),
      query: '',
      filter: { kind: 'all' },
      currentMachineId: null,
      boundMachineId: null,
    });
    expect(browser.groups.map((group) => [group.kind, group.items.length])).toEqual([
      ['repositories', 1],
      ['elsewhere', 2],
    ]);
  });
});
