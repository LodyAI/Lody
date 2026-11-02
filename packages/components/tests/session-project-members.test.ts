import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId, ProjectMemberId, SessionMeta } from '@lody/shared';
import {
  buildSessionProjectMemberRows,
  resolveSessionProjectMemberRow,
} from '../src/lib/session-project-members';

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

  it('is empty for an ordinary session', () => {
    expect(buildSessionProjectMemberRows({ pullRequests: [] })).toEqual([]);
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
