import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@lody/shared';
import { buildSessionProjectMemberRows } from '../src/lib/session-project-members';

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
      unpushed: true,
    },
    web: {
      o: 0,
      src: { kind: 'local', machineId: 'm1', localProjectId: 'web' },
      placement: { kind: 'root', dir: 'web' },
      path: 'web',
      base: 'HEAD',
      branch: 'lody/export',
      dirty: true,
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
      dirty: true,
      pr: { number: 4, status: 'open', ciState: 'f' },
    });
    expect(rows[1]!.pr).toBeUndefined();
    expect(rows[2]).toMatchObject({ isSubmodule: true, unpushed: true, pr: { number: 5 } });
  });

  it('is empty for an ordinary session', () => {
    expect(buildSessionProjectMemberRows({ pullRequests: [] })).toEqual([]);
  });

  it('carries how each member reached the agent', () => {
    const rows = buildSessionProjectMemberRows({
      projectRun: {
        ...projectRun,
        members: {
          docs: {
            o: 0,
            access: 'additional',
            src: { kind: 'local', machineId: 'm1', localProjectId: 'docs' },
            placement: { kind: 'root', dir: 'docs' },
            path: 'docs',
            base: 'HEAD',
          },
        },
      } as unknown as NonNullable<SessionMeta['projectRun']>,
      pullRequests: [],
    });
    expect(rows[0]).toMatchObject({ path: 'docs', access: 'additional' });
    expect(rows[0]!.pr).toBeUndefined();
  });
});
