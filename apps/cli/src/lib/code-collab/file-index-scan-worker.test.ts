import { MessageChannel } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import fileIndexScanWorker from './file-index-scan-worker';

const execFileAsync = promisify(execFile);

// Real subprocesses; the wrapper only signals when a `git ls-files --cached` rejection
// has reached the scan core, so the test can check what happens next without timers.
const gitCommandFailures = vi.hoisted(() => ({
  onCachedListingRejected: undefined as (() => void) | undefined,
}));

vi.mock('@lody/shared/node/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lody/shared/node/process')>();
  return {
    ...actual,
    runCommandTextLegacy: async (...args: Parameters<typeof actual.runCommandTextLegacy>) => {
      try {
        return await actual.runCommandTextLegacy(...args);
      } catch (error) {
        if (args[0].args.includes('--cached')) {
          gitCommandFailures.onCachedListingRejected?.();
        }
        throw error;
      }
    },
  };
});

afterEach(() => {
  gitCommandFailures.onCachedListingRejected = undefined;
  vi.unstubAllEnvs();
});

// `ls-files --cached` fails only after `ls-files --deleted` is running; the latter then
// blocks on a FIFO until the test kills it, so it outlives its sibling deterministically.
const FAKE_GIT_SCRIPT = `#!/bin/sh
case " $* " in
  *" --deleted "*)
    printf '%s' "$$" > "$LODY_TEST_GIT_DIR/deleted.pid.tmp"
    mv "$LODY_TEST_GIT_DIR/deleted.pid.tmp" "$LODY_TEST_GIT_DIR/deleted.pid"
    : > "$LODY_TEST_GIT_DIR/ready.fifo"
    exec cat "$LODY_TEST_GIT_DIR/gate.fifo"
    ;;
  *" --cached "*)
    cat "$LODY_TEST_GIT_DIR/ready.fifo" > /dev/null
    echo 'fatal: simulated ls-files failure' >&2
    exit 1
    ;;
esac
exit 128
`;

async function withFailingFakeGit<T>(fn: (fakeGitDir: string) => Promise<T>): Promise<T> {
  const fakeGitDir = await mkdtemp(path.join(tmpdir(), 'lody-file-index-fake-git-'));
  try {
    const gitPath = path.join(fakeGitDir, 'git');
    await writeFile(gitPath, FAKE_GIT_SCRIPT);
    await chmod(gitPath, 0o755);
    await execFileAsync('mkfifo', [
      path.join(fakeGitDir, 'ready.fifo'),
      path.join(fakeGitDir, 'gate.fifo'),
    ]);
    vi.stubEnv('PATH', `${fakeGitDir}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('LODY_TEST_GIT_DIR', fakeGitDir);
    return await fn(fakeGitDir);
  } finally {
    const deletedPid = await readFile(path.join(fakeGitDir, 'deleted.pid'), 'utf8').catch(() => '');
    if (deletedPid && isProcessPresent(Number(deletedPid))) {
      process.kill(Number(deletedPid), 'SIGKILL');
    }
    await rm(fakeGitDir, { recursive: true, force: true });
  }
}

/** True while `pid` exists at all, including as an unreaped zombie. */
function isProcessPresent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd });
}

async function withGitWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lody-file-index-worker-'));
  try {
    await git(workspaceRoot, ['init', '-b', 'main']);
    await git(workspaceRoot, ['config', 'user.email', 'test@example.com']);
    await git(workspaceRoot, ['config', 'user.name', 'Test User']);
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'README.md'), '# Test\n');
    await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'one\n');
    await git(workspaceRoot, ['add', '.']);
    await git(workspaceRoot, ['commit', '-m', 'initial']);

    await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'one\ntwo\n');
    await writeFile(path.join(workspaceRoot, 'src', 'new.ts'), 'created\nfile\n');
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function withPlainWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lody-file-index-worker-plain-'));
  try {
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'README.md'), '# Plain\n');
    await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'plain\n');
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

describe('fileIndexScanWorker', () => {
  it('uses each project group member Git ignore rules and prefixes independent changes', async () => {
    await withPlainWorkspace(async (workspaceRoot) => {
      for (const name of ['web', 'api']) {
        const root = path.join(workspaceRoot, name);
        await mkdir(root);
        await git(root, ['init', '-b', 'main']);
        await git(root, ['config', 'user.name', 'Test']);
        await git(root, ['config', 'user.email', 'test@example.com']);
        await writeFile(path.join(root, '.gitignore'), 'generated.txt\n');
        await writeFile(path.join(root, 'shared.txt'), 'old\n');
        await git(root, ['add', '.']);
        await git(root, ['commit', '-m', 'base']);
        await writeFile(path.join(root, 'shared.txt'), 'old\nnew\n');
        await writeFile(path.join(root, 'generated.txt'), 'ignored');
      }
      const result = await fileIndexScanWorker({
        kind: 'full-state',
        workspaceRoot,
        projectMembers: [
          { path: 'web', base: 'main' },
          { path: 'api', base: 'main' },
        ],
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
      });
      expect(result.status).toBe('ok');
      if (result.kind !== 'full-state' || result.status !== 'ok')
        throw new Error('Missing group state');
      expect(result.allChanges).toMatchObject({
        'web/shared.txt': { diff: [1, 0] },
        'api/shared.txt': { diff: [1, 0] },
      });
      expect(result.fileTreeEntries.map(([file]) => file)).toContain('web/shared.txt');
      expect(result.fileTreeEntries.map(([file]) => file)).toContain('api/shared.txt');
      expect(result.fileTreeEntries.map(([file]) => file)).not.toContain('web/generated.txt');
      expect(result.fileTreeEntries.map(([file]) => file)).not.toContain('api/generated.txt');
      expect(result.allChangesSource).toBe('git');
    });
  });

  it('rebuilds against the tracking base for a qualified local owner ref', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      await git(workspaceRoot, ['checkout', '-b', 'feature']);
      await git(workspaceRoot, ['add', '.']);
      await git(workspaceRoot, ['commit', '-m', 'upstream changes']);
      await git(workspaceRoot, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      await writeFile(path.join(workspaceRoot, 'avatar.txt'), 'avatar fix\n');
      await git(workspaceRoot, ['add', '.']);
      await git(workspaceRoot, ['commit', '-m', 'avatar fix']);
      const scan = () =>
        fileIndexScanWorker({
          kind: 'full-state',
          workspaceRoot,
          preferredBaseBranch: 'refs/heads/main',
          maxRawTextBytes: 1024 * 1024,
          entryBudget: 1000,
        });
      const before = await scan();
      expect(before.status).toBe('ok');
      if (before.status !== 'ok') throw new Error('Expected Git scan');
      expect(before.allChanges).toEqual({ 'avatar.txt': { diff: [1, 0] } });
      await git(workspaceRoot, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      const merged = await scan();
      expect(merged.status).toBe('ok');
      if (merged.status !== 'ok') throw new Error('Expected merged scan');
      expect(merged.allChanges).toEqual({});
      expect(merged.fileIndex['avatar.txt']).toBe(true);
    });
  });
  it('excludes paths deleted from the worktree from the Git scan', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      await unlink(path.join(workspaceRoot, 'README.md'));

      const result = await fileIndexScanWorker({
        directoryAbsolutePath: workspaceRoot,
        directoryWorkspacePath: '',
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
        recursive: true,
      });

      expect(new Map(result.entries)).toEqual(
        new Map([
          ['src', { kind: 'lazy' }],
          ['src/app.ts', true],
          ['src/new.ts', true],
        ])
      );
    });
  });

  it.runIf(process.platform !== 'win32')(
    'cancels the worker cooperatively and reaps its Git child before returning',
    async () => {
      await withPlainWorkspace(async (workspaceRoot) => {
        await withFailingFakeGit(async (fakeGitDir) => {
          let ready: () => void = () => {};
          const started = new Promise<void>((resolve) => {
            ready = resolve;
          });
          gitCommandFailures.onCachedListingRejected = ready;
          const { port1, port2 } = new MessageChannel();
          const scan = fileIndexScanWorker({
            directoryAbsolutePath: workspaceRoot,
            directoryWorkspacePath: '',
            maxRawTextBytes: 1024,
            entryBudget: 1000,
            recursive: true,
            cancellationPort: port2,
          });
          const cancelled = expect(scan).rejects.toThrow();
          await started;
          const pid = Number(await readFile(path.join(fakeGitDir, 'deleted.pid'), 'utf8'));
          expect(isProcessPresent(pid)).toBe(true);
          port1.postMessage('abort');
          try {
            await cancelled;
            expect(isProcessPresent(pid)).toBe(false);
          } finally {
            port1.close();
            port2.close();
          }
        });
      });
    }
  );
});
