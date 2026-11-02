import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';
import {
  filterMobileProjectOptions,
  getMobileProjectOptions,
  resolveMobileNewChatDefaultProject,
} from '@/components/mobile/mobile-new-chat-project-options';
import type {
  MobileProjectFolder,
  MobileProjectGroup,
  MobileProjectRepo,
} from '@/components/mobile/mobile-new-chat-project-sheet';

const spikes = 'spikes' as MachineId;
const zx = 'zx' as MachineId;

const folders: MobileProjectFolder[] = [
  {
    machineId: spikes,
    localProjectId: 'blog' as LocalProjectId,
    name: 'blog',
    rootPath: '~/code/blog',
    lastUsedAt: 2,
  },
  {
    machineId: spikes,
    localProjectId: 'lody' as LocalProjectId,
    name: 'lody',
    rootPath: '~/code/lody',
    lastUsedAt: 4,
  },
  {
    machineId: zx,
    localProjectId: 'loro' as LocalProjectId,
    name: 'loro',
    rootPath: '~/code/loro',
    lastUsedAt: 3,
  },
];

const groups: MobileProjectGroup[] = [
  { projectId: 'group-1', name: 'Loro stack', memberCount: 3, lastUsedAt: 6 },
];

const repositories: MobileProjectRepo[] = [
  { fullName: 'loro-dev/lody', description: 'AI-native local-first companion', lastUsedAt: 1 },
  { fullName: 'loro-dev/loro', description: 'CRDT framework', lastUsedAt: 5 },
];

describe('filterMobileProjectOptions', () => {
  it('scopes local folders to the selected machine and leaves GitHub repos machine-independent', () => {
    const result = filterMobileProjectOptions({
      folders,
      repositories,
      groups,
      machineId: spikes,
      query: '',
    });
    expect(result.folders.map((folder) => folder.name)).toEqual(['lody', 'blog']);
    expect(result.repositories.map((repo) => repo.fullName)).toEqual([
      'loro-dev/loro',
      'loro-dev/lody',
    ]);
    expect(result.groups.map((group) => group.name)).toEqual(['Loro stack']);
  });

  it('searches local names and paths with the same query as GitHub repos', () => {
    const result = filterMobileProjectOptions({
      folders,
      repositories,
      groups,
      machineId: spikes,
      query: 'loro',
    });
    expect(result.folders).toEqual([]);
    expect(result.repositories.map((repo) => repo.fullName)).toEqual([
      'loro-dev/loro',
      'loro-dev/lody',
    ]);
  });

  it('matches a local path, not just its display name', () => {
    const result = filterMobileProjectOptions({
      folders,
      repositories,
      groups,
      machineId: spikes,
      query: 'code/blog',
    });
    expect(result.folders.map((folder) => folder.name)).toEqual(['blog']);
    expect(result.repositories).toEqual([]);
  });

  it('searches project groups with the same query', () => {
    const result = filterMobileProjectOptions({
      folders,
      repositories,
      groups,
      machineId: spikes,
      query: 'loro stack',
    });
    expect(result.groups.map((group) => group.name)).toEqual(['Loro stack']);
    expect(result.folders).toEqual([]);
    expect(result.repositories).toEqual([]);
  });

  it('returns no local folders when no machine is selected', () => {
    const result = filterMobileProjectOptions({
      folders,
      repositories,
      groups,
      machineId: null,
      query: '',
    });
    expect(result.folders).toEqual([]);
    expect(result.repositories).toHaveLength(2);
  });
});

describe('getMobileProjectOptions', () => {
  it('ranks recent usage across sources rather than keeping source groups', () => {
    const result = getMobileProjectOptions({
      folders,
      repositories,
      groups,
      machineId: spikes,
      query: '',
    });
    expect(result.map((option) => option.label)).toEqual([
      'Loro stack',
      'loro-dev/loro',
      'lody',
      'blog',
      'loro-dev/lody',
    ]);
  });
  it('uses names then stable ids for tied or never-used projects, keeping recent first', () => {
    const result = getMobileProjectOptions({
      folders: [
        { ...folders[0]!, name: 'Alpha', lastUsedAt: undefined },
        { ...folders[1]!, name: 'Same', lastUsedAt: 10 },
      ],
      groups: [{ ...groups[0]!, name: 'Same', lastUsedAt: 10 }],
      repositories: [{ fullName: 'Zeta', lastUsedAt: 2 }, { fullName: 'Beta' }],
      machineId: spikes,
      query: '',
    });
    expect(result.map((option) => option.value)).toEqual([
      'group:group-1',
      'local:spikes:lody',
      'github:Zeta',
      'local:spikes:blog',
      'github:Beta',
    ]);
  });
  it('scopes folders before ranking and keeps an unavailable recent group visible', () => {
    const result = getMobileProjectOptions({
      folders,
      repositories,
      groups: [{ ...groups[0]!, lastUsedAt: 20, disabledReason: 'Unavailable' }],
      machineId: zx,
      query: '',
    });
    expect(result[0]?.disabledReason).toBe('Unavailable');
    expect(
      result.filter((option) => option.selection.kind === 'local').map((option) => option.label)
    ).toEqual(['loro']);
  });
});

describe('mobile new-chat default target', () => {
  const options = () =>
    getMobileProjectOptions({ folders, repositories, groups, machineId: spikes, query: '' });
  it('prefers the remembered repo over the more recently ranked group', () => {
    const selection = { kind: 'github', repoFullName: 'loro-dev/lody' } as const;
    expect(resolveMobileNewChatDefaultProject(selection, options())).toEqual(selection);
  });
  it('keeps an explicit no-project choice', () => {
    expect(resolveMobileNewChatDefaultProject({ kind: 'none' }, options())).toEqual({
      kind: 'none',
    });
  });
  it.each(['local', 'group'] as const)('restores the exact %s identity', (kind) => {
    const selection = options().find((option) => option.selection.kind === kind)!.selection;
    expect(resolveMobileNewChatDefaultProject(selection, options())).toEqual(selection);
  });
  it('does not substitute a similarly named folder on another machine', () => {
    expect(
      resolveMobileNewChatDefaultProject(
        { kind: 'local', machineId: 'deleted-machine', localProjectId: folders[0]!.localProjectId },
        options()
      )
    ).toEqual({ kind: 'none' });
  });
  it('falls back to no project for deleted or unavailable remembered targets', () => {
    expect(
      resolveMobileNewChatDefaultProject({ kind: 'github', repoFullName: 'gone/repo' }, options())
    ).toEqual({ kind: 'none' });
    const group = options().find((option) => option.selection.kind === 'group')!;
    expect(
      resolveMobileNewChatDefaultProject(group.selection, [
        { ...group, disabledReason: 'Unavailable' },
      ])
    ).toEqual({ kind: 'none' });
  });
  it('uses existing recent usage when upgrading without a remembered target', () => {
    const available = options();
    expect(resolveMobileNewChatDefaultProject(undefined, available)).toEqual(
      available[0]!.selection
    );
    expect(
      resolveMobileNewChatDefaultProject(
        undefined,
        available.map((option) => ({ ...option, lastUsedAt: undefined }))
      )
    ).toEqual({ kind: 'none' });
  });
});
