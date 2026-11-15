import { materializeProjectGroup } from '../src/session/worktree/project-worktrees';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, vi } from 'vitest';
import type { ProjectRef, SessionId, SessionMeta, SessionProjectRun } from '@lody/shared';
import { projectRunMetaPatch } from '../src/session/project-run-state';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import { WorkspaceGitService } from '../src/session/workspace-git-service';

const projectRun = (): SessionProjectRun => ({
  id: '12345678-1234-4234-8234-123456789012' as never,
  name: 'Example',
  root: 'project-example-12345678-1234-4234-8234-123456789012',
  members: {
    web: {
      o: 0,
      src: { kind: 'github', repoFullName: 'example/web' },
      placement: { kind: 'root', dir: 'web' },
      path: 'web',
      base: 'main',
    },
    api: {
      o: 1,
      src: { kind: 'github', repoFullName: 'example/api' },
      placement: { kind: 'root', dir: 'api' },
      path: 'api',
      base: 'main',
    },
  },
});

const exec = promisify(execFile);

const owner = 'owner' as SessionId;

const child = 'child' as SessionId;

function fixture() {
  const meta = new Map<SessionId, Partial<SessionMeta>>([
    [owner, {}],
    [child, { parentSessionId: owner }],
  ]);
  const workspaceDocument = {
    repo: {
      async getDocMeta() {
        return { meta: meta.get(owner) };
      },
      async upsertDocMeta(_room: string, patch: Partial<SessionMeta>) {
        meta.set(owner, { ...meta.get(owner), ...patch });
      },
    },
    async getOrCreateSessionDoc(id: SessionId) {
      return {
        async getMetaState() {
          return meta.get(id);
        },
        async setProjectRun(run: SessionProjectRun) {
          meta.set(id, { ...meta.get(id), ...projectRunMetaPatch(run) });
        },
        async setProject(project: ProjectRef) {
          meta.set(id, { ...meta.get(id), project });
        },
        async setBranchName(branchName: string) {
          meta.set(id, { ...meta.get(id), branchName });
        },
      };
    },
  } as unknown as LoroDocumentManager;
  const service = new WorkspaceGitService({
    logger: { debug() {} } as unknown as Logger,
    workspaceDocument,
  });
  return { service, meta, workspaceDocument };
}

let seedRootDir: string | undefined;

let emptyFeatureRepoSeedDir: string | undefined;

let submoduleGroupSeedDir: string | undefined;

async function ensureGitSeeds(): Promise<{
  emptyFeatureRepoSeed: string;
  submoduleGroupSeed: string;
}> {
  if (emptyFeatureRepoSeedDir && submoduleGroupSeedDir) {
    return {
      emptyFeatureRepoSeed: emptyFeatureRepoSeedDir,
      submoduleGroupSeed: submoduleGroupSeedDir,
    };
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lody-wgs-seeds-')));
  seedRootDir = root;
  const seedEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const seedGit = async (cwd: string, args: string[]) =>
    (await exec('git', args, { cwd, env: seedEnv })).stdout;

  const emptyRepo = join(root, 'empty-feature-local');
  await mkdir(emptyRepo);
  await seedGit(emptyRepo, ['init', '-b', 'feature/local']);

  const groupSeed = join(root, 'submodule-group');
  const seedWeb = join(groupSeed, 'web');
  const seedApi = join(groupSeed, 'api');
  await mkdir(groupSeed);
  for (const repository of [seedWeb, seedApi]) {
    await mkdir(repository);
    await seedGit(repository, ['init', '-b', 'main']);
    await writeFile(join(repository, 'readme'), 'original');
    await seedGit(repository, ['add', '.']);
    await seedGit(repository, ['commit', '-m', 'base']);
  }
  const moduleUrl = 'https://github.com/example/api.git';
  await seedGit(seedWeb, ['submodule', 'add', pathToFileURL(seedApi).href, 'deps/api']);
  await seedGit(seedWeb, ['config', '-f', '.gitmodules', 'submodule.deps/api.url', moduleUrl]);
  await seedGit(seedWeb, ['commit', '-am', 'submodule']);
  await seedGit(seedApi, ['remote', 'add', 'origin', 'git@github.com:example/api.git']);

  emptyFeatureRepoSeedDir = emptyRepo;
  submoduleGroupSeedDir = groupSeed;
  return { emptyFeatureRepoSeed: emptyRepo, submoduleGroupSeed: groupSeed };
}

async function withRepo(
  run: (cwd: string, git: (args: string[]) => Promise<string>) => Promise<void>
) {
  const { emptyFeatureRepoSeed } = await ensureGitSeeds();
  // Frozen repository identities use real paths, including macOS /var aliases.
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'lody-branch-')));
  const git = async (args: string[]) => (await exec('git', args, { cwd })).stdout;
  try {
    await cp(join(emptyFeatureRepoSeed, '.git'), join(cwd, '.git'), { recursive: true });
    await run(cwd, git);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function withLocalSubmoduleGroup(
  selected: boolean,
  runTest: (context: {
    directory: string;
    web: string;
    api: string;
    roots: { api: string };
    run: SessionProjectRun;
    options: Parameters<typeof materializeProjectGroup>[0];
    meta: ReturnType<typeof fixture>['meta'];
    git: (cwd: string, args: string[]) => Promise<string>;
  }) => Promise<void>
) {
  const { submoduleGroupSeed } = await ensureGitSeeds();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'lody-submodule-group-')));
  const web = join(directory, 'web');
  const api = join(directory, 'api');
  const git = async (cwd: string, args: string[]) => (await exec('git', args, { cwd })).stdout;
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
  vi.stubEnv('GIT_AUTHOR_NAME', 'Test');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Test');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.com');
  vi.stubEnv('LODY_DATA_DIR', join(directory, 'data'));
  try {
    await Promise.all([
      cp(join(submoduleGroupSeed, 'web'), web, { recursive: true }),
      cp(join(submoduleGroupSeed, 'api'), api, { recursive: true }),
    ]);
    const seedApiUrl = pathToFileURL(join(submoduleGroupSeed, 'api')).href;
    const apiUrl = pathToFileURL(api).href;
    for (const configFile of [
      join(web, '.git/config'),
      join(web, '.git/modules/deps/api/config'),
    ]) {
      const content = await readFile(configFile, 'utf8');
      await writeFile(
        configFile,
        content.replaceAll(seedApiUrl, apiUrl).replaceAll(submoduleGroupSeed, directory)
      );
    }
    const moduleUrl = 'https://github.com/example/api.git';
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${apiUrl}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', moduleUrl);
    const { meta, workspaceDocument } = fixture();
    const run = projectRun();
    for (const [id, member] of Object.entries(run.members)) {
      member.src = {
        kind: 'local',
        machineId: 'machine' as never,
        localProjectId: id as never,
      };
      member.base = 'HEAD';
    }
    const apiId = Object.keys(run.members)[1]!;
    if (selected) {
      const member = run.members[apiId as keyof typeof run.members]!;
      member.placement = { kind: 'submodule', parent: 'web' as never, path: 'deps/api' };
      member.path = 'web/deps/api';
      member.base = 'gitlink';
    }
    meta.set(owner, { projectRun: run, machineId: 'machine' as never });
    const roots = { api };
    const options = {
      sessionId: owner,
      machineId: 'machine',
      workspaceDocument,
      logger: { debug() {}, info() {}, warn() {}, trace() {} } as unknown as Logger,
      resolveLocalRoot: async (id: string) => (id === 'web' ? web : roots.api),
      brokerAuth: async () => undefined,
      setup: async () => {},
    };
    await runTest({ directory, web, api, roots, run, options, meta, git });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export function registerGitSeedCleanup() {
  afterAll(async () => {
    if (seedRootDir) {
      await rm(seedRootDir, { recursive: true, force: true });
      seedRootDir = undefined;
      emptyFeatureRepoSeedDir = undefined;
      submoduleGroupSeedDir = undefined;
    }
  });
}
export {
  child,
  emptyFeatureRepoSeedDir,
  ensureGitSeeds,
  exec,
  fixture,
  owner,
  projectRun,
  seedRootDir,
  submoduleGroupSeedDir,
  withLocalSubmoduleGroup,
  withRepo,
};
