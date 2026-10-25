import {
  encodeSessionFilePath,
  decodeSessionFilePath,
  getProjectMemberRootId,
  parseProjectMemberRootId,
  SessionFileRootIdSchema,
} from '../src/project-path';
import { SessionCreateRequestSchema } from '../src/message-schemas';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceProjectSchema,
  buildSessionProjectRun,
  selectProjectMembers,
  matchProjectSubmoduleMember,
  getProjectRepositoryFullName,
  SessionProjectRunSchema,
  deduplicateProjectMembers,
  getCurrentPullRequestsByRepository,
  getProjectRunRoot,
  resolveProjectMemberPaths,
  getProjectBoundMachineId,
  pickProjectRepositoryLocalCopy,
  encodeProjectPreparationProgress,
  decodeProjectPreparationProgress,
  type ProjectMember,
  type ProjectMemberId,
} from '../src/workspace-project';
import { resolveSessionFilePath } from '../src/project-path';
import {
  parseWorkspaceFlockRow,
  applyWorkspaceFlockRowEvents,
  listWorkspaceProjects,
} from '../src/workspace-flock';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  machineSupportsMultiRepoProject,
  machineSupportsProjectFileRoots,
  machineSupportsProjectRepositoryMembers,
} from '../src/machine-protocol-capabilities';
import type { MachineId } from '../src/ids';
import type { LocalProjectId } from '../src/project';

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
  it('freezes selected members, defers Git bases and recursively prunes unselected parents', () => {
    const p = project();
    const snapshot = buildSessionProjectRun(
      p,
      p.members.map((m) => m.id)
    )!;
    expect(Object.values(snapshot.members).map((m) => [m.o, m.path, m.base])).toEqual([
      [0, 'api', 'HEAD'],
      [1, 'api/lib/proto', 'gitlink'],
    ]);
    p.members[0]!.source.baseBranch = 'later';
    p.instructions = 'Changed';
    expect(snapshot.instructions).toBe('API owns the protocol.');
    expect(Object.values(snapshot.members)[0]!.src.baseBranch).toBeUndefined();
    expect(
      buildSessionProjectRun(
        p,
        p.members.map((m) => m.id)
      )!.members[p.members[0]!.id]!.base
    ).toBe('later');
    const child = p.members[1]!;
    const grandchild: ProjectMember = {
      id: 'nested' as ProjectMemberId,
      source: { kind: 'github', repoFullName: 'acme/nested' },
      placement: { kind: 'submodule', parent: child.id, path: 'nested' },
    };
    p.members.push(grandchild);
    expect(selectProjectMembers(p.members, [child.id, grandchild.id])).toEqual([]);
    expect(selectProjectMembers(p.members, [p.members[0]!.id, grandchild.id])).toEqual([
      p.members[0],
    ]);
    expect(buildSessionProjectRun(p, [child.id, grandchild.id])).toBeUndefined();
    expect(buildSessionProjectRun(p, [p.members[0]!.id])).toBeUndefined();
    expect(() => buildSessionProjectRun(p, ['missing' as ProjectMemberId])).toThrow('Unknown');
  });
  it('matches GitHub transport aliases and relative URLs without guessing ambiguous identities', () => {
    const p = project();
    for (const url of [
      '../proto.git',
      'git@github.com:ACME/proto.git',
      'ssh://git@github.com/acme/proto.git',
      'https://github.com/acme/proto',
    ]) {
      expect(matchProjectSubmoduleMember({ url }, p.members, undefined, 'acme/api')?.id).toBe(
        p.members[1]!.id
      );
    }
    expect(getProjectRepositoryFullName('../other.git', 'acme/api')).toBe('acme/other');
    expect(getProjectRepositoryFullName('https://github.com.evil/acme/proto')).toBeUndefined();
    expect(matchProjectSubmoduleMember({ url: '/host/proto' }, p.members)).toBeUndefined();
    const local: ProjectMember = {
      ...p.members[1]!,
      id: 'local' as ProjectMemberId,
      source: { kind: 'local', machineId: 'm' as never, localProjectId: 'l' as never },
    };
    expect(
      matchProjectSubmoduleMember(
        { url: '../proto.git' },
        [local],
        () => ({ repoFullName: 'acme/proto' }),
        'acme/api'
      )
    ).toEqual(local);
    expect(
      matchProjectSubmoduleMember(
        { url: '../proto.git' },
        [...p.members, local],
        () => ({ repoFullName: 'acme/proto' }),
        'acme/api'
      )
    ).toBeUndefined();
  });
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
    expect(machineSupportsProjectFileRoots({})).toBe(false);
    expect(machineSupportsProjectFileRoots({ protocolCapabilities: { multiRepoProject: 1 } })).toBe(
      false
    );
    expect(
      machineSupportsProjectFileRoots({
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      })
    ).toBe(true);
    expect(
      machineSupportsMultiRepoProject({
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      })
    ).toBe(true);
    expect(machineSupportsMultiRepoProject({ protocolCapabilities: { multiRepoProject: 1 } })).toBe(
      true
    );
  });
});
describe('repository Members', () => {
  const local = (machineId: string, localProjectId: string) =>
    ({
      kind: 'local',
      machineId: machineId as MachineId,
      localProjectId: localProjectId as LocalProjectId,
    }) as const;

  it('keeps preferLocal through the catalog and the frozen run', () => {
    const p = project();
    const withRepo = WorkspaceProjectSchema.parse({
      ...p,
      members: [
        {
          ...p.members[0]!,
          source: { kind: 'github', repoFullName: 'acme/api', preferLocal: true },
        },
        p.members[1]!,
      ],
    });
    expect(withRepo.members[0]!.source).toEqual({
      kind: 'github',
      repoFullName: 'acme/api',
      preferLocal: true,
    });
    const frozen = buildSessionProjectRun(withRepo, ['api', 'proto'] as ProjectMemberId[]);
    expect(frozen?.members['api' as ProjectMemberId]?.src).toMatchObject({ preferLocal: true });
    expect(
      WorkspaceProjectSchema.safeParse({
        ...p,
        members: [
          {
            ...p.members[0]!,
            source: { kind: 'github', repoFullName: 'acme/api', preferLocal: false },
          },
        ],
      }).success
    ).toBe(false);
  });

  it('binds a group to the one machine of its local Members', () => {
    const github = { kind: 'github', repoFullName: 'acme/api', preferLocal: true } as const;
    expect(getProjectBoundMachineId([{ source: github }])).toBeNull();
    expect(
      getProjectBoundMachineId([
        { source: github },
        { source: local('m1', 'docs') },
        { source: local('m1', 'notes') },
      ])
    ).toBe('m1');
    expect(
      getProjectBoundMachineId([{ source: local('m1', 'docs') }, { source: local('m2', 'ios') }])
    ).toBe('conflict');
  });

  it('picks the most recently opened copy of a repository, ignoring case', () => {
    const copies = [
      { id: 'a' as LocalProjectId, githubRepoFullName: 'Acme/API', createdAtMs: 1 },
      {
        id: 'b' as LocalProjectId,
        githubRepoFullName: 'acme/api',
        createdAtMs: 2,
        lastOpenedAtMs: 9,
      },
      {
        id: 'c' as LocalProjectId,
        githubRepoFullName: 'acme/web',
        createdAtMs: 3,
        lastOpenedAtMs: 99,
      },
      { id: 'd' as LocalProjectId, createdAtMs: 4 },
    ];
    expect(pickProjectRepositoryLocalCopy('acme/api', copies)?.id).toBe('b');
    expect(pickProjectRepositoryLocalCopy('acme/proto', copies)).toBeUndefined();
    // Equal recency falls back to the id, so every client picks the same copy.
    expect(
      pickProjectRepositoryLocalCopy('acme/api', [
        { id: 'z' as LocalProjectId, githubRepoFullName: 'acme/api', createdAtMs: 5 },
        { id: 'y' as LocalProjectId, githubRepoFullName: 'acme/api', createdAtMs: 5 },
      ])?.id
    ).toBe('y');
  });

  it('requires its own capability beyond multi-repository and file roots', () => {
    expect(
      machineSupportsProjectRepositoryMembers({
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      })
    ).toBe(true);
    expect(
      machineSupportsProjectRepositoryMembers({
        protocolCapabilities: { multiRepoProject: 1, projectFileRoots: 1 },
      })
    ).toBe(false);
    expect(
      machineSupportsProjectRepositoryMembers({
        protocolCapabilities: { projectRepositoryMembers: 1 },
      })
    ).toBe(true);
  });
});

it('preserves daemon repository checkout receipts in session snapshots', () => {
  const snapshot = run();
  const member = Object.values(snapshot.members)[0]!;
  member.repositoryCheckout = {
    kind: 'local',
    machineId: 'machine' as never,
    localProjectId: 'copy' as never,
  };
  expect(
    Object.values(SessionProjectRunSchema.parse(snapshot).members)[0]?.repositoryCheckout
  ).toEqual(member.repositoryCheckout);
});

describe('Project preparation progress', () => {
  it('round-trips each step through the presence detail and stays bounded', () => {
    for (const progress of [
      { step: 'resolve' },
      { step: 'member', done: 2, total: 5, path: 'web/deps/api' },
      { step: 'submodules' },
      { step: 'setup', path: 'web' },
    ] as const) {
      expect(decodeProjectPreparationProgress(encodeProjectPreparationProgress(progress))).toEqual(
        progress
      );
    }
    const long = encodeProjectPreparationProgress({ step: 'setup', path: 'x'.repeat(1000) });
    // Within the presence detail bound (280).
    expect(long.length).toBeLessThanOrEqual(280);
    expect(decodeProjectPreparationProgress(long)).toMatchObject({ step: 'setup' });
  });

  it('ignores plain text from older daemons and malformed payloads', () => {
    expect(decodeProjectPreparationProgress('Preparing web (0/5 ready)')).toBeUndefined();
    expect(decodeProjectPreparationProgress(undefined)).toBeUndefined();
    expect(decodeProjectPreparationProgress('lody-project-prep:{bad')).toBeUndefined();
    expect(
      decodeProjectPreparationProgress('lody-project-prep:{"step":"member","done":-1}')
    ).toBeUndefined();
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
    expect(resolveSessionFilePath(roots, '/work\\outside/file')).toBeUndefined();
    expect(resolveSessionFilePath(roots, '/work/file\\name')).toEqual({
      rootId: 'main',
      relativePath: 'file\\name',
    });
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

describe('multi-root wire file identities', () => {
  it('round trips main and member paths without collisions with literal filenames', () => {
    for (const relativePath of [
      'docs/a.ts',
      'member:docs/a.ts',
      'lody-root:member:docs/a.ts',
      'a\\b.txt',
    ]) {
      const main = { rootId: 'main', relativePath };
      const member = { rootId: getProjectMemberRootId('docs'), relativePath };
      expect(encodeSessionFilePath(main)).toBe(relativePath);
      expect(encodeSessionFilePath(member)).not.toBe(relativePath);
      expect(decodeSessionFilePath(encodeSessionFilePath(main))).toEqual(main);
      expect(decodeSessionFilePath(encodeSessionFilePath(member))).toEqual(member);
    }
    expect(parseProjectMemberRootId('member:docs')).toBe('docs');
    expect(parseProjectMemberRootId('main')).toBeUndefined();
  });
  it('rejects malformed roots, traversal and malformed wire keys', () => {
    for (const root of ['member:', 'member:../x', 'member:__proto__', '/tmp']) {
      expect(SessionFileRootIdSchema.safeParse(root).success).toBe(false);
    }
    for (const key of [
      '../x',
      '/etc/passwd',
      '\0lody-root:main/a',
      '\0lody-root:member:docs/../a',
      'a\0b',
    ]) {
      expect(decodeSessionFilePath(key)).toBeUndefined();
    }
    expect(() => encodeSessionFilePath({ rootId: 'main', relativePath: '../a' })).toThrow();
  });
});
