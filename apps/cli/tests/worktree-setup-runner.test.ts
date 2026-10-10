import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionId, WorkspaceId, WorktreeSetupScriptConfig } from '@lody/shared';
import { createLogger } from '../src/utils/logger';
import {
  resolveWorktreeSetupShell,
  runWorktreeSetup,
  type WorktreeScriptEndEvent,
  type WorktreeScriptOutputEvent,
  type WorktreeScriptStartEvent,
  type WorktreeScriptStepEndEvent,
  type WorktreeScriptStepStartEvent,
} from '../src/session/worktree/worktree-setup-runner';

const testLogger = createLogger({
  level: 'error',
  transports: 'console',
  console: {
    colorize: false,
    timestamp: false,
    format: 'simple',
  },
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('worktree setup runner', () => {
  it('runs script lines in one shell while emitting per-step output', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-worktree-setup-'));
    tempDirs.push(workdir);

    const shell = resolveWorktreeSetupShell();
    const script =
      shell === 'powershell'
        ? "$env:LODY_TEST_VALUE = 'hello'\nWrite-Output $env:LODY_TEST_VALUE\n[Console]::Error.WriteLine('err')"
        : 'export LODY_TEST_VALUE=hello\nprintf "$LODY_TEST_VALUE\\n"\nprintf \'err\\n\' >&2';
    const config: WorktreeSetupScriptConfig = {
      scripts: {
        [shell]: script,
      },
    };
    const starts: WorktreeScriptStartEvent[] = [];
    const stepStarts: WorktreeScriptStepStartEvent[] = [];
    const outputs: WorktreeScriptOutputEvent[] = [];
    const stepEnds: WorktreeScriptStepEndEvent[] = [];
    const ends: WorktreeScriptEndEvent[] = [];

    await runWorktreeSetup({
      config,
      sessionId: 'session-1' as SessionId,
      workspaceId: 'workspace-1' as WorkspaceId,
      workdir,
      branch: 'feature/worktree-setup-history',
      logger: testLogger,
      events: {
        onStart: (event) => {
          starts.push(event);
        },
        onStepStart: (event) => {
          stepStarts.push(event);
        },
        onOutput: (event) => {
          outputs.push(event);
        },
        onStepEnd: (event) => {
          stepEnds.push(event);
        },
        onEnd: (event) => {
          ends.push(event);
        },
      },
    });

    expect(starts).toHaveLength(1);
    expect(starts[0]?.shell).toBe(shell);
    expect(starts[0]?.displayCommand).toBe(script);
    expect(starts[0]?.workdir).toBe(workdir);
    expect(stepStarts.map((event) => event.displayCommand)).toEqual(script.split('\n'));
    expect(
      outputs
        .filter((event) => event.stepIndex === 1)
        .map((event) => event.chunk)
        .join('')
    ).toContain('hello');
    expect(
      outputs
        .filter((event) => event.stepIndex === 2)
        .map((event) => event.chunk)
        .join('')
    ).toContain('err');
    expect(stepEnds).toHaveLength(3);
    expect(stepEnds.map((event) => event.status)).toEqual(['completed', 'completed', 'completed']);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.status).toBe('completed');
    expect(ends[0]?.exitStatus?.exitCode).toBe(0);
  });

  it('skips setup when the current shell script is empty', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-worktree-setup-'));
    tempDirs.push(workdir);

    const shell = resolveWorktreeSetupShell();
    const otherShell = shell === 'bash' ? 'powershell' : 'bash';
    const starts: WorktreeScriptStartEvent[] = [];
    const outputs: WorktreeScriptOutputEvent[] = [];
    const ends: WorktreeScriptEndEvent[] = [];

    await runWorktreeSetup({
      config: {
        scripts: {
          [shell]: '   ',
          [otherShell]: 'echo should-not-run',
        },
      },
      sessionId: 'session-1' as SessionId,
      workspaceId: 'workspace-1' as WorkspaceId,
      workdir,
      branch: 'feature/worktree-setup-history',
      logger: testLogger,
      events: {
        onStart: (event) => {
          starts.push(event);
        },
        onOutput: (event) => {
          outputs.push(event);
        },
        onEnd: (event) => {
          ends.push(event);
        },
      },
    });

    expect(starts).toHaveLength(0);
    expect(outputs).toHaveLength(0);
    expect(ends).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')(
    'ends every process a failed script started, not just its shell',
    async () => {
      const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-worktree-setup-'));
      tempDirs.push(workdir);
      const pidFile = path.join(workdir, 'background.pid');

      // The first step leaves a background job in the shell's process group;
      // the second fails, which must take that job down with the shell.
      const failure = await runWorktreeSetup({
        config: {
          scripts: { bash: `sleep 600 &\necho $! > ${JSON.stringify(pidFile)}\nfalse` },
        },
        sessionId: 'session-1' as SessionId,
        workspaceId: 'workspace-1' as WorkspaceId,
        workdir,
        branch: 'feature/worktree-setup-failure',
        logger: testLogger,
      }).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(Error);
      const backgroundPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      expect(backgroundPid).toBeGreaterThan(0);
      expect(isAlive(backgroundPid)).toBe(false);
    }
  );
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
