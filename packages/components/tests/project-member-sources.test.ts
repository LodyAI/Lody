import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';
import {
  buildProjectMemberSourceOptions,
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
  it('marks only repositories the GitHub integration lists as reachable on GitHub', () => {
    const sources = buildProjectMemberSourceOptions({
      localProjects: [local(here, 'web', 'acme/web'), local(here, 'tool', 'private/tool')],
      githubRepositories: [{ fullName: 'acme/web' }],
    });
    const of = (key: string) => sources.find((option) => option.key === key);
    expect(of('github:acme/web')?.onGithub).toBe(true);
    // Known only from a folder's remote: offered as that folder, never as a clone.
    expect(of('github:private/tool')).toMatchObject({ kind: 'repository' });
    expect(of('github:private/tool')?.onGithub).toBeUndefined();
  });

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
});
