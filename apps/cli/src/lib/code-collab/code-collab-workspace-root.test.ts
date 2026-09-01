import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codeCollabFileIndexToSharedState, type SessionId } from '@lody/shared';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import { getWorktreeManager } from '@/session/worktree/worktree-manager';
import type { Logger } from '@/utils/logger';
import { CodeCollabV2Service } from './code-collab-v2-service';
import { resolveCodeCollabLocalProjectWorkspaceRoot } from './code-collab-workspace-root';

const runGit = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const createLogger = (): Logger => {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => undefined),
  };
  return logger;
};

describe('Code Collab local project workspace root', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const tempRoot of tempRoots.splice(0)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reads All Changes from an inactive local worktree instead of the original project', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'lody-code-collab-local-worktree-'));
    tempRoots.push(tempRoot);
    vi.stubEnv('LODY_DATA_DIR', path.join(tempRoot, 'lody-data'));

    const originalRootPath = path.join(tempRoot, 'project');
    runGit(tempRoot, ['init', '-b', 'main', originalRootPath]);
    writeFileSync(path.join(originalRootPath, 'README.md'), '# project\n', 'utf8');
    runGit(originalRootPath, ['add', '-A']);
    runGit(originalRootPath, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'init',
    ]);

    const sessionId = 'local-worktree-session' as SessionId;
    const logger = createLogger();
    const worktreeManager = getWorktreeManager({
      repoId: deriveRepoIdFromLocalProjectPath(originalRootPath),
      source: { kind: 'local-shared', originalRootPath },
      logger,
    });
    await worktreeManager.ensureRepo();
    const worktree = await worktreeManager.createWorktree(sessionId, 'main');
    writeFileSync(path.join(originalRootPath, 'main-only.txt'), 'main\n', 'utf8');
    writeFileSync(path.join(worktree.hostPath, 'worktree-only.txt'), 'worktree\n', 'utf8');

    const workspaceRoot = resolveCodeCollabLocalProjectWorkspaceRoot({
      originalRootPath,
      ownerSessionId: sessionId,
      isWorktree: true,
      logger,
    });
    expect(workspaceRoot).toBe(worktree.hostPath);
    if (!workspaceRoot) {
      throw new Error('Expected the local session worktree to exist.');
    }

    const service = new CodeCollabV2Service({
      resolveWorkspace: async () => ({
        ok: true,
        ownerSessionId: sessionId,
        workspaceRoot,
        allChangesBaseBranch: 'main',
      }),
    });
    const snapshot = await service.getFileIndex({ sessionId });
    const { allChanges } = codeCollabFileIndexToSharedState(snapshot.fileIndex);

    expect(allChanges).toHaveProperty('worktree-only.txt');
    expect(allChanges).not.toHaveProperty('main-only.txt');
  });

  it('does not fall back to the original project when the worktree is missing', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'lody-code-collab-missing-worktree-'));
    tempRoots.push(tempRoot);
    vi.stubEnv('LODY_DATA_DIR', path.join(tempRoot, 'lody-data'));

    expect(
      resolveCodeCollabLocalProjectWorkspaceRoot({
        originalRootPath: path.join(tempRoot, 'project'),
        ownerSessionId: 'missing-local-worktree' as SessionId,
        isWorktree: true,
        logger: createLogger(),
      })
    ).toBeNull();
  });
});
