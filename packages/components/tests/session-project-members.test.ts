import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId, ProjectMemberId, SessionMeta } from '@lody/shared';
import {
  buildSessionProjectMemberRows,
  resolveSessionProjectMemberRow,
} from '../src/lib/session-project-members';
import { projectSharingReducer, type ProjectSharingState } from '../src/lib/project-sharing-state';
import {
  buildProjectMemberSourceOptions,
  resolveProjectEditorSource,
  type ProjectMemberSourceOption,
} from '@/lib/project-member-sources';

describe('session-project-members', () => {
  const projectRun = {
    id: '0b9a4a6e-6d2f-4f3a-9a53-0f3d1f0b2c11',
    name: 'Shop',
    root: 'project-shop-0b9a4a6e-6d2f-4f3a-9a53-0f3d1f0b2c11',
    members: {
      proto: {
        o: 2,
        src: { kind: 'github', repoFullName: 'acme/proto' },
        placement: { kind: 'submodule', parent: 'api', path: 'proto' },
        path: 'api/proto',
        base: 'gitlink',
        branch: 'lody/export-proto',
      },
      web: {
        o: 0,
        src: { kind: 'local', machineId: 'm1', localProjectId: 'web' },
        placement: { kind: 'root', dir: 'web' },
        path: 'web',
        base: 'HEAD',
        branch: 'lody/export',
        repoFullName: 'acme/web',
      },
      api: {
        o: 1,
        src: { kind: 'github', repoFullName: 'acme/api' },
        placement: { kind: 'root', dir: 'api' },
        path: 'api',
        base: 'HEAD',
      },
    },
  } as unknown as NonNullable<SessionMeta['projectRun']>;

  describe('buildSessionProjectMemberRows', () => {
    it('attaches a PR to the repository in its URL, not a stale legacy repository field', () => {
      const rows = buildSessionProjectMemberRows({
        projectRun,
        pullRequests: [
          {
            url: 'https://github.com/acme/api/pull/7',
            status: 'open',
            repository: 'acme/web',
            number: 99,
          },
        ] as unknown as SessionMeta['pullRequests'],
      });
      const api = rows.find((row) => row.id === ('api' as ProjectMemberId));
      const web = rows.find((row) => row.id === ('web' as ProjectMemberId));
      expect(api?.pr).toEqual({
        url: 'https://github.com/acme/api/pull/7',
        status: 'open',
        number: 7,
      });
      expect(web?.pr).toBeUndefined();
    });

    it('lists members in snapshot order, each with its own current PR and CI', () => {
      const rows = buildSessionProjectMemberRows({
        projectRun,
        pullRequests: [
          { url: 'https://github.com/acme/web/pull/3', status: 'closed' },
          { url: 'https://github.com/acme/proto/pull/5', status: 'open' },
          { url: 'https://github.com/acme/web/pull/4', status: 'open' },
        ],
        pullRequestState: { 'https://github.com/acme/web/pull/4': { s: 'f', t: 1 } },
      });
      expect(rows.map((row) => row.path)).toEqual(['web', 'api', 'api/proto']);
      expect(rows[0]).toMatchObject({
        kind: 'local',
        repoFullName: 'acme/web',
        pr: { number: 4, status: 'open', ciState: 'f' },
      });
      expect(rows[1]!.pr).toBeUndefined();
      expect(rows[2]).toMatchObject({ isSubmodule: true, pr: { number: 5 } });
    });

    it('nests submodules under their parent when the snapshot lists the child first', () => {
      const rows = buildSessionProjectMemberRows({
        projectRun: {
          ...projectRun,
          members: {
            proto: {
              o: 0,
              src: { kind: 'github', repoFullName: 'acme/proto' },
              placement: { kind: 'submodule', parent: 'api', path: 'proto' },
              path: 'api/proto',
              base: 'gitlink',
            },
            api: {
              o: 1,
              src: { kind: 'github', repoFullName: 'acme/api' },
              placement: { kind: 'root', dir: 'api' },
              path: 'api',
              base: 'HEAD',
            },
            web: {
              o: 2,
              src: { kind: 'github', repoFullName: 'acme/web' },
              placement: { kind: 'root', dir: 'web' },
              path: 'web',
              base: 'HEAD',
            },
          },
        } as unknown as NonNullable<SessionMeta['projectRun']>,
        pullRequests: [],
      });

      expect(rows.map((row) => row.path)).toEqual(['api', 'api/proto', 'web']);
      expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);
    });

    it('resolves the explicit selection, then the legacy repository, then the first row', () => {
      const rows = buildSessionProjectMemberRows({
        projectRun,
        pullRequests: [],
      });

      expect(resolveSessionProjectMemberRow(rows, 'proto' as ProjectMemberId)?.path).toBe(
        'api/proto'
      );
      expect(resolveSessionProjectMemberRow(rows, null, 'acme/api')?.path).toBe('api');
      expect(resolveSessionProjectMemberRow(rows, null)?.path).toBe('web');
      expect(resolveSessionProjectMemberRow([], 'proto' as ProjectMemberId)).toBeNull();
    });

    it.each(['additional', 'link'] as const)(
      'resolves the registered directory for %s access',
      (access) => {
        const meta = {
          projectRun: {
            ...projectRun,
            members: {
              docs: {
                o: 0,
                access,
                src: { kind: 'local', machineId: 'm1', localProjectId: 'docs' },
                placement: { kind: 'root', dir: 'docs' },
                path: 'docs',
                base: 'HEAD',
              },
            },
          } as unknown as NonNullable<SessionMeta['projectRun']>,
          pullRequests: [],
        };
        const context = {
          machineId: 'm1' as MachineId,
          localProjects: {
            docs: {
              id: 'docs' as LocalProjectId,
              name: 'Docs',
              rootPath: '/srv/projects/documentation',
              createdAtMs: 1,
            },
          },
        };
        const rows = buildSessionProjectMemberRows(meta, context);
        expect(rows[0]).toMatchObject({
          path: 'docs',
          access,
          localRootPath: '/srv/projects/documentation',
        });
        expect(buildSessionProjectMemberRows(meta)[0]?.localRootPath).toBeUndefined();
        expect(
          buildSessionProjectMemberRows(meta, { ...context, machineId: 'other' as MachineId })[0]
            ?.localRootPath
        ).toBeUndefined();
        expect(
          buildSessionProjectMemberRows(meta, { ...context, localProjects: {} })[0]?.localRootPath
        ).toBeUndefined();
        expect(rows[0]!.pr).toBeUndefined();
      }
    );
  });
});

describe('project-sharing-state', () => {
  const key = 'machine-1:project-1';

  function begin(
    state: ProjectSharingState = {},
    desired = true,
    requestId = 1
  ): ProjectSharingState {
    return projectSharingReducer(state, { type: 'begin', key, desired, requestId });
  }

  describe('project sharing state', () => {
    it('keeps an acknowledged value until a delayed query catches up', () => {
      const saving = begin();
      const acknowledged = projectSharingReducer(saving, {
        type: 'succeeded',
        key,
        requestId: 1,
        observedSharedWithTeam: false,
      });

      expect(acknowledged[key]).toEqual({
        desired: true,
        requestId: 1,
        status: 'awaiting-sync',
      });
      expect(
        projectSharingReducer(acknowledged, {
          type: 'reconcile',
          sharedWithTeamByKey: new Map([[key, false]]),
        })
      ).toBe(acknowledged);
      expect(
        projectSharingReducer(acknowledged, {
          type: 'reconcile',
          sharedWithTeamByKey: new Map([[key, true]]),
        })
      ).toEqual({});
    });

    it('rolls back a failed request', () => {
      expect(
        projectSharingReducer(begin(), {
          type: 'failed',
          key,
          requestId: 1,
        })
      ).toEqual({});
    });

    it('ignores stale completions from an older request', () => {
      const newer = begin(begin(), false, 2);

      expect(
        projectSharingReducer(newer, {
          type: 'failed',
          key,
          requestId: 1,
        })
      ).toBe(newer);
      expect(
        projectSharingReducer(newer, {
          type: 'succeeded',
          key,
          requestId: 1,
          observedSharedWithTeam: true,
        })
      ).toBe(newer);
    });
  });
});

describe('project-member-sources', () => {
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
    it('editing a folder keeps the selected machine and exact copy even when its repository is merged', () => {
      const sources = buildProjectMemberSourceOptions({
        localProjects: [
          local(here, 'same-id', 'acme/web'),
          local(studio, 'same-id', 'acme/web', 1),
          local(studio, 'newer-copy', 'acme/web', 9),
        ],
        githubRepositories: [],
      });
      expect(resolveProjectEditorSource(`local:${studio}:same-id`, sources[0]!)).toEqual({
        kind: 'local',
        machineId: 'machine-2',
        localProjectId: 'same-id',
      });
      expect(resolveProjectEditorSource('github:acme/web', sources[0]!)).toEqual({
        kind: 'github',
        repoFullName: 'acme/web',
        preferLocal: true,
      });
    });
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
});
