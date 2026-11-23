import { afterAll, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { RepoId } from '@lody/shared';
import { WorktreeManager } from '../src/session/worktree/worktree-manager';
import { createLogger } from '../src/utils/logger';

const testLogger = createLogger({
  level: 'error',
  transports: 'console',
  console: {
    colorize: false,
    timestamp: false,
    format: 'simple',
  },
});

export interface WorktreeManagerTestFixture {
  testDir: string;
  repoId: RepoId;
  manager: WorktreeManager;
}

export const useWorktreeManagerTestFixture = (
  setFixture: (fixture: WorktreeManagerTestFixture) => void
): void => {
  let testDir: string;
  let originalLocksDir: string | undefined;

  beforeEach(() => {
    // Match the canonical paths returned by Git and Project worktree preparation.
    testDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lody-worktree-test-')));
    const repoId = `test-repo-${Date.now()}` as RepoId;

    originalLocksDir = process.env.LODY_LOCKS_DIR;
    process.env.LODY_LOCKS_DIR = path.join(testDir, 'locks');

    const manager = new WorktreeManager({
      repoId,
      logger: testLogger,
    });

    // @ts-expect-error - accessing private property for testing
    manager.baseDir = testDir;
    // @ts-expect-error - accessing private property for testing
    manager.repoDir = path.join(testDir, repoId);
    // @ts-expect-error - accessing private property for testing
    manager.bareGitDir = path.join(testDir, repoId, 'bare.git');
    // @ts-expect-error - accessing private property for testing
    manager.worktreesDir = path.join(testDir, repoId, 'worktrees');
    // @ts-expect-error - accessing private property for testing
    manager.cacheDir = path.join(testDir, repoId, 'cache');

    setFixture({ testDir, repoId, manager });
  });

  afterEach(() => {
    if (originalLocksDir === undefined) {
      delete process.env.LODY_LOCKS_DIR;
    } else {
      process.env.LODY_LOCKS_DIR = originalLocksDir;
    }

    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });
};

/**
 * Small `git` wrapper for test setup and assertions.
 * Returns trimmed stdout; throws on non-zero exit.
 */
export const runGit = (cwd: string, args: string[]): string => {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
};

/**
 * Creates a commit in the given repo using a fixed identity (no global git config required).
 */
export const gitCommit = (cwd: string, message: string): string => {
  runGit(cwd, ['add', '-A']);
  runGit(cwd, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    message,
  ]);
  return runGit(cwd, ['rev-parse', 'HEAD']);
};

/**
 * Converts a local path into a properly escaped file URL.
 */
export const toFileUrl = (localPath: string): string => {
  const normalized = path.resolve(localPath);
  return pathToFileURL(normalized).toString();
};

let templateRootDir: string | undefined;
let localRepoTemplateDir: string | undefined;
const remoteRepoTemplates = new Map<
  'main' | 'master',
  { sourceTemplateDir: string; remoteBareTemplateDir: string }
>();

const ensureTemplateRoot = (): string => {
  if (!templateRootDir) {
    templateRootDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lody-wt-tpl-'))
    );
  }
  return templateRootDir;
};

afterAll(() => {
  if (templateRootDir) {
    try {
      fs.rmSync(templateRootDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    templateRootDir = undefined;
    localRepoTemplateDir = undefined;
    remoteRepoTemplates.clear();
  }
});

/**
 * Creates a bare "remote" repo plus a working repo, pushes an initial commit, and returns both paths.
 */
export const createRemoteRepo = (
  rootDir: string,
  defaultBranch: 'main' | 'master'
): { sourceDir: string; remoteBareDir: string } => {
  let cached = remoteRepoTemplates.get(defaultBranch);
  if (!cached) {
    const tplRoot = ensureTemplateRoot();
    const sourceTemplateDir = path.join(tplRoot, `source-${defaultBranch}`);
    const remoteBareTemplateDir = path.join(tplRoot, `remote-${defaultBranch}.git`);

    fs.mkdirSync(sourceTemplateDir, { recursive: true });
    runGit(sourceTemplateDir, ['init', '-b', defaultBranch]);
    fs.writeFileSync(path.join(sourceTemplateDir, 'README.md'), `# ${defaultBranch}\n`, 'utf8');
    gitCommit(sourceTemplateDir, 'init');

    runGit(tplRoot, ['init', '--bare', remoteBareTemplateDir]);
    runGit(sourceTemplateDir, ['remote', 'add', 'origin', remoteBareTemplateDir]);
    runGit(sourceTemplateDir, ['push', '-u', 'origin', defaultBranch]);

    cached = { sourceTemplateDir, remoteBareTemplateDir };
    remoteRepoTemplates.set(defaultBranch, cached);
  }

  const sourceDir = path.join(rootDir, `source-${defaultBranch}`);
  const remoteBareDir = path.join(rootDir, `remote-${defaultBranch}.git`);
  fs.cpSync(cached.sourceTemplateDir, sourceDir, { recursive: true });
  fs.cpSync(cached.remoteBareTemplateDir, remoteBareDir, { recursive: true });

  const gitConfigPath = path.join(sourceDir, '.git', 'config');
  const configText = fs.readFileSync(gitConfigPath, 'utf8');
  fs.writeFileSync(
    gitConfigPath,
    configText.replaceAll(cached.remoteBareTemplateDir, remoteBareDir),
    'utf8'
  );

  return { sourceDir, remoteBareDir };
};

export const createLocalRepo = (rootDir: string): string => {
  if (!localRepoTemplateDir) {
    const tplRoot = ensureTemplateRoot();
    const tplDir = path.join(tplRoot, 'local-source');
    fs.mkdirSync(tplDir, { recursive: true });
    runGit(tplDir, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(tplDir, 'README.md'), '# local\n', 'utf8');
    gitCommit(tplDir, 'init');
    localRepoTemplateDir = tplDir;
  }

  const sourceDir = path.join(rootDir, 'local-source');
  fs.cpSync(localRepoTemplateDir, sourceDir, { recursive: true });
  return sourceDir;
};
