import { SessionCreateRequestSchema } from '../src/message-schemas';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceProjectSchema,
  SessionProjectRunSchema,
  deduplicateProjectMembers,
  getCurrentPullRequestsByRepository,
  getProjectRunRoot,
  resolveProjectMemberPaths,
  type ProjectMember,
  type ProjectMemberId,
} from '../src/workspace-project';
import { resolveSessionFilePath } from '../src/project-path';
import {
  parseWorkspaceFlockRow,
  applyWorkspaceFlockRowEvents,
  listWorkspaceProjects,
} from '../src/workspace-flock';
import { machineSupportsMultiRepoProject } from '../src/machine-protocol-capabilities';

const project = () =>
  WorkspaceProjectSchema.parse({
    v: 1,
    id: 'd835a1ee-4f85-4e15-9dca-2bca912e36bf',
    name: 'Acme Shop',
    ownerUserId: 'u',
    createdAtMs: 1,
    revision: 1,
    instructions: 'API owns the protocol.',
    members: [
      {
        id: 'api',
        source: { kind: 'github', repoFullName: 'acme/api', repoId: 1 },
        placement: { kind: 'root', dir: 'api' },
      },
      {
        id: 'proto',
        source: { kind: 'github', repoFullName: 'acme/proto' },
        placement: { kind: 'submodule', parent: 'api', path: 'lib/proto' },
      },
    ],
  });
const run = () => {
  const p = project();
  const paths = resolveProjectMemberPaths(p.members);
  return {
    id: p.id,
    name: p.name,
    root: getProjectRunRoot(p),
    instructions: p.instructions,
    members: Object.fromEntries(
      p.members.map((m, o) => [
        m.id,
        { o, src: m.source, placement: m.placement, path: paths[m.id], base: 'main' },
      ])
    ),
  };
};
describe('workspace Projects', () => {
  it('normalizes catalog rows, freezes nested paths and removes deleted rows', () => {
    const p = project();
    const key = ['project', p.id];
    expect(parseWorkspaceFlockRow(key, { ...p, hostPath: '/private/path' })?.value).toEqual(p);
    const rows = applyWorkspaceFlockRowEvents({}, [{ key, value: p }]);
    expect(listWorkspaceProjects(rows)).toEqual([p]);
    expect(listWorkspaceProjects(applyWorkspaceFlockRowEvents(rows, [{ key }]))).toEqual([]);
    expect(parseWorkspaceFlockRow(['project', 'other'], p)).toBeUndefined();
    expect(SessionProjectRunSchema.parse(run()).members['proto' as ProjectMemberId]?.path).toBe(
      'api/lib/proto'
    );
  });
  it.each(['../escape', '/absolute', 'a/../b', 'a\\b', '.git', 'C:', 'NUL', 'a.', 'a//b'])(
    'rejects unsafe placement %s',
    (dir) => {
      const p = project();
      p.members[0]!.placement = { kind: 'root', dir };
      expect(WorkspaceProjectSchema.safeParse(p).success).toBe(false);
    }
  );
  it('rejects cycles, missing parents, overlapping siblings and duplicate IDs', () => {
    const p = project();
    const a = p.members[0]!;
    const b = p.members[1]!;
    for (const members of [
      [a, a],
      [a, { ...b, placement: { kind: 'submodule', parent: 'absent', path: 'proto' } }],
      [{ ...a, placement: { kind: 'submodule', parent: b.id, path: 'api' } }, b],
      [a, { ...b, placement: { kind: 'root', dir: 'API' } }],
    ])
      expect(WorkspaceProjectSchema.safeParse({ ...p, members }).success).toBe(false);
    const snapshot = run();
    snapshot.members.proto!.path = 'outside';
    expect(SessionProjectRunSchema.safeParse(snapshot).success).toBe(false);
  });
  it('deduplicates GitHub aliases and machine-local sources using resolved identities', () => {
    const a = project().members[0]!;
    const alias = {
      ...a,
      id: 'alias',
      source: { kind: 'github', repoFullName: 'ACME/API' },
    } as ProjectMember;
    const renamed = {
      ...a,
      id: 'renamed',
      source: { kind: 'github', repoFullName: 'acme/new', repoId: 1 },
    } as ProjectMember;
    const local = {
      ...a,
      id: 'local',
      source: { kind: 'local', machineId: 'm', localProjectId: 'p' },
    } as ProjectMember;
    expect(
      deduplicateProjectMembers([alias, a, renamed, local], () => ({ repoFullName: 'acme/api' }))
    ).toEqual([alias]);
    expect(
      deduplicateProjectMembers([a, local, { ...local, id: 'copy' } as ProjectMember])
    ).toEqual([a, local]);
    expect(
      deduplicateProjectMembers([
        a,
        { ...a, source: { kind: 'github', repoFullName: 'acme/api', repoId: 2 } },
      ])
    ).toHaveLength(2);
  });
  it('selects the last PR per repository without treating invalid URLs as repositories', () => {
    const prs = [
      'https://github.com/acme/api/pull/1',
      'https://github.com/acme/web/pull/2',
      'https://github.com/ACME/api/pull/3',
      'invalid',
    ].map((url) => ({ url }));
    expect(getCurrentPullRequestsByRepository(prs)).toEqual([prs[1], prs[2]]);
  });
  it('preserves the frozen run at the session/create wire boundary and rejects invalid snapshots', () => {
    const request = {
      type: 'session/create',
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
      projectRun: run(),
    };
    expect(SessionCreateRequestSchema.parse(request).projectRun).toEqual(run());
    expect(
      SessionCreateRequestSchema.safeParse({
        ...request,
        projectRun: { ...run(), root: '../escape' },
      }).success
    ).toBe(false);
  });
  it('requires explicit multi-repository capability', () => {
    expect(machineSupportsMultiRepoProject({})).toBe(false);
    expect(machineSupportsMultiRepoProject({ protocolCapabilities: { multiRepoProject: 1 } })).toBe(
      true
    );
  });
});
describe('session file root resolution', () => {
  it('matches the deepest root and rejects siblings and traversal outside all roots', () => {
    const roots = [
      { id: 'main', absolutePath: '/work' },
      { id: 'extra', absolutePath: '/work/nested' },
    ];
    expect(resolveSessionFilePath(roots, '/work/nested/file.ts')).toEqual({
      rootId: 'extra',
      relativePath: 'file.ts',
    });
    expect(resolveSessionFilePath(roots, '/work/nested/../file.ts')).toEqual({
      rootId: 'main',
      relativePath: 'file.ts',
    });
    expect(resolveSessionFilePath(roots, '/work-other/file')).toBeUndefined();
    expect(resolveSessionFilePath(roots, '/work/../../etc/passwd')).toBeUndefined();
    expect(resolveSessionFilePath(roots, 'relative')).toBeUndefined();
    expect(resolveSessionFilePath([{ id: 'main', absolutePath: '/' }], '/file')).toEqual({
      rootId: 'main',
      relativePath: 'file',
    });
  });
  it('handles Windows separators and drive case without folding POSIX case', () => {
    expect(
      resolveSessionFilePath([{ id: 'main', absolutePath: 'C:\\Work' }], 'c:\\work\\a.txt')
    ).toEqual({ rootId: 'main', relativePath: 'a.txt' });
    expect(
      resolveSessionFilePath([{ id: 'main', absolutePath: '/Work' }], '/work/a')
    ).toBeUndefined();
  });
});
