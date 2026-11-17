import { MessageChannel } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CODE_COLLAB_FILE_INDEX_LIMITS, estimateCodeCollabFileIndexStateBytes } from '@lody/shared';

import {
  computeAllChanges,
  createGitIgnoreScanFilter,
  summarizeAllChanges,
} from './file-index-scan-core';
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
  it('counts binary, empty and permission changes while summing only text lines', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'image.bin'), Buffer.from([0, 1, 2]));
      await git(workspaceRoot, ['add', '.']);
      await git(workspaceRoot, ['commit', '-m', 'comparison base']);
      await writeFile(path.join(workspaceRoot, 'image.bin'), Buffer.from([0, 3, 4]));
      await writeFile(path.join(workspaceRoot, 'new.bin'), Buffer.from([0, 5, 6]));
      await writeFile(path.join(workspaceRoot, 'empty.txt'), '');
      await chmod(path.join(workspaceRoot, 'README.md'), 0o755);
      const zeroLine = await computeAllChanges(workspaceRoot);
      expect(summarizeAllChanges(zeroLine)).toEqual({ files: 4, allChange: { add: 0, del: 0 } });
      await writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'one\ntwo\nthree\n');
      expect(summarizeAllChanges(await computeAllChanges(workspaceRoot))).toEqual({
        files: 5,
        allChange: { add: 1, del: 0 },
      });
      await unlink(path.join(workspaceRoot, 'image.bin'));
      const deleted = await computeAllChanges(workspaceRoot);
      expect(deleted['image.bin']).toEqual({ diff: [0, 0], del: true });
      expect(summarizeAllChanges(deleted)).toEqual({ files: 5, allChange: { add: 1, del: 0 } });
      const bounded = await computeAllChanges(workspaceRoot, { untrackedLineCountBudget: 0 });
      expect(summarizeAllChanges(bounded)).toEqual({ files: 5, allChange: null });
    });
  });

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
  it('keeps an untracked in-project pnpm store out of the file index but shows tracked files there', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      // Tracked before the cache policy applies: must stay visible.
      await mkdir(path.join(workspaceRoot, '.pnpm-store', 'pinned'), { recursive: true });
      await writeFile(path.join(workspaceRoot, '.pnpm-store', 'pinned', 'tracked.json'), '{}\n');
      await git(workspaceRoot, ['add', '.pnpm-store/pinned/tracked.json']);
      await git(workspaceRoot, ['commit', '-m', 'tracked store file']);
      await mkdir(path.join(workspaceRoot, '.pnpm-store', 'v10', 'index'), { recursive: true });
      for (let index = 0; index < 20; index += 1) {
        await writeFile(
          path.join(workspaceRoot, '.pnpm-store', 'v10', 'index', `entry-${index}.json`),
          '{"cache":true}\n'
        );
      }

      const result = await fileIndexScanWorker({
        kind: 'full-state',
        workspaceRoot,
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
      });
      if (result.kind !== 'full-state' || result.status !== 'ok') throw new Error('Missing state');

      const paths = Object.keys(result.fileIndex);
      expect(paths).toContain('.pnpm-store/pinned/tracked.json');
      expect(paths).toContain('src/new.ts');
      expect(paths.filter((file) => file.startsWith('.pnpm-store/v10'))).toEqual([]);
      expect(
        Object.keys(result.allChanges).filter((file) => file.startsWith('.pnpm-store'))
      ).toEqual([]);
    });
  });

  it('honours .gitignore in non-recursive filesystem refreshes but keeps tracked files', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, '.gitignore'), 'coverage/\n*.log\n.env\n');
      await writeFile(path.join(workspaceRoot, 'forced.log'), 'tracked despite the rule\n');
      await git(workspaceRoot, ['add', '.gitignore']);
      await git(workspaceRoot, ['add', '-f', 'forced.log']);
      await git(workspaceRoot, ['commit', '-m', 'ignore rules']);
      await mkdir(path.join(workspaceRoot, 'coverage'));
      await writeFile(path.join(workspaceRoot, 'coverage', 'lcov.info'), 'x\n');
      await writeFile(path.join(workspaceRoot, 'debug.log'), 'x\n');
      await writeFile(path.join(workspaceRoot, '.env'), 'SECRET=1\n');
      await mkdir(path.join(workspaceRoot, 'src', 'coverage'));

      const result = await fileIndexScanWorker({
        directoryAbsolutePath: workspaceRoot,
        directoryWorkspacePath: '',
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
        recursive: false,
      });
      const rootPaths = result.entries.map(([file]) => file);
      expect(rootPaths).toEqual(expect.arrayContaining(['README.md', 'src', 'forced.log']));
      expect(rootPaths).not.toContain('coverage');
      expect(rootPaths).not.toContain('debug.log');
      expect(rootPaths).not.toContain('.env');

      const nested = await fileIndexScanWorker({
        directoryAbsolutePath: path.join(workspaceRoot, 'src'),
        directoryWorkspacePath: 'src',
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
        recursive: false,
      });
      // Rules from the repository root apply to a subdirectory scan.
      expect(nested.entries.map(([file]) => file).sort()).toEqual(['src/app.ts', 'src/new.ts']);
    });
  });

  it('evaluates nested gitignore rules in-process so scans can prune ignored directories', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, '.gitignore'), '*.log\nbuild-out/\n');
      await writeFile(path.join(workspaceRoot, '.git', 'info', 'exclude'), 'local-only/\n');
      await mkdir(path.join(workspaceRoot, 'pkg', 'generated'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'pkg', '.gitignore'), '!keep.log\ngenerated/\n');
      await writeFile(path.join(workspaceRoot, 'pkg', 'vendor.log'), 'tracked\n');
      await git(workspaceRoot, ['add', '.gitignore', 'pkg/.gitignore']);
      await git(workspaceRoot, ['add', '-f', 'pkg/vendor.log']);
      await git(workspaceRoot, ['commit', '-m', 'rules']);

      const filter = await createGitIgnoreScanFilter(workspaceRoot);
      if (!filter) throw new Error('Expected a Git ignore filter inside the worktree');
      expect(
        [
          ...(await filter.ignoredEntryNames('', [
            { name: 'build-out', isDirectory: true },
            { name: 'a.log', isDirectory: false },
            { name: 'local-only', isDirectory: true },
            { name: 'pkg', isDirectory: true },
            { name: 'README.md', isDirectory: false },
          ])),
        ].sort()
      ).toEqual(['a.log', 'build-out', 'local-only']);
      // A directory-only rule does not hide a file of the same name.
      expect(
        await filter.ignoredEntryNames('', [{ name: 'build-out', isDirectory: false }])
      ).toEqual(new Set());

      const nested = [
        { name: 'keep.log', isDirectory: false },
        { name: 'other.log', isDirectory: false },
        { name: 'generated', isDirectory: true },
        { name: 'vendor.log', isDirectory: false },
      ];
      // Deeper rules win (`!keep.log`); a force-added tracked file stays visible.
      expect([...(await filter.ignoredEntryNames('pkg', nested))].sort()).toEqual([
        'generated',
        'other.log',
      ]);
      // A scan rooted below the top level applies the same chain of rules.
      const subdirectory = await createGitIgnoreScanFilter(path.join(workspaceRoot, 'pkg'));
      expect([...((await subdirectory?.ignoredEntryNames('', nested)) ?? [])].sort()).toEqual([
        'generated',
        'other.log',
      ]);
    });
  });

  it('prunes .gitignore directories from a recursive filesystem scan', async () => {
    await withPlainWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, '.gitignore'), 'out/\n');
      await mkdir(path.join(workspaceRoot, 'out', 'nested'), { recursive: true });
      for (let index = 0; index < 50; index += 1) {
        await writeFile(path.join(workspaceRoot, 'out', 'nested', `bundle-${index}.js`), 'x');
      }

      const result = await fileIndexScanWorker({
        directoryAbsolutePath: workspaceRoot,
        directoryWorkspacePath: '',
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
        recursive: true,
      });
      const paths = result.entries.map(([file]) => file);
      expect(paths).toEqual(expect.arrayContaining(['README.md', 'src', 'src/app.ts']));
      // Neither the ignored directory nor anything below it is read or counted.
      expect(paths.filter((file) => file === 'out' || file.startsWith('out/'))).toEqual([]);
    });
  });

  it('bounds the published index for a flood of untracked files without inventing deletions', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      const generated = path.join(workspaceRoot, 'generated-output', 'deeply', 'nested', 'chunks');
      await mkdir(generated, { recursive: true });
      for (let index = 0; index < 1_500; index += 1) {
        await writeFile(path.join(generated, `chunk-${String(index).padStart(5, '0')}.txt`), 'x\n');
      }

      const result = await fileIndexScanWorker({
        kind: 'full-state',
        workspaceRoot,
        maxRawTextBytes: 1024 * 1024,
        entryBudget: 1000,
      });
      if (result.kind !== 'full-state' || result.status !== 'ok') throw new Error('Missing state');

      expect(Object.keys(result.fileIndex).length).toBeLessThanOrEqual(
        CODE_COLLAB_FILE_INDEX_LIMITS.maxEntries
      );
      expect(estimateCodeCollabFileIndexStateBytes(result.fileIndex)).toBeLessThanOrEqual(
        CODE_COLLAB_FILE_INDEX_LIMITS.maxBytes
      );
      expect(result.omittedPaths).toBeGreaterThan(0);
      // Over-budget paths are not loaded, not deleted.
      expect(
        Object.values(result.fileIndex).filter(
          (value) => value !== true && value.kind === 'deleted'
        )
      ).toEqual([]);
      // Root entries and the real source change survive the flood.
      expect(result.fileIndex['README.md']).toBe(true);
      expect(result.fileIndex['src/app.ts']).toEqual({ kind: 'file', change: { diff: [1, 0] } });
      expect(result.fileIndex['generated-output']).toEqual({ kind: 'lazy' });
    });
  });

  it('reads untracked files for line counts only within the budget', async () => {
    await withGitWorkspace(async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, 'src', 'second.ts'), 'a\nb\nc\n');
      const changes = await computeAllChanges(workspaceRoot, { untrackedLineCountBudget: 1 });
      const untracked = [changes['src/new.ts'], changes['src/second.ts']];
      expect(untracked.filter((value) => value === true)).toHaveLength(1);
      expect(untracked.filter((value) => value !== true && value?.diff !== undefined)).toHaveLength(
        1
      );
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
