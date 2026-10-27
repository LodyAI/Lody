import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';
import { filterMobileProjectOptions } from '@/components/mobile/mobile-new-chat-project-options';
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
