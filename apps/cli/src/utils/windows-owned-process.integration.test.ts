import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { terminateWindowsChildProcess } from './windows-child-process';
import { build } from 'esbuild';
import { spawnWindowsOwnedProcess } from './windows-owned-process';

const suite =
  process.platform === 'win32' && process.env.LODY_WINDOWS_SUPERVISOR_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('Windows owned launcher integration', () => {
  let directory: string;
  let launcherPath: string;
  let supervisorPath: string;
  let target: string;
  beforeAll(async () => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'lody-owned-launch-'));
    launcherPath = path.join(directory, 'launcher.cjs');
    supervisorPath = path.join(directory, `windows-process-supervisor-win32-${process.arch}.exe`);
    const compiled = spawnSync(
      process.execPath,
      ['scripts/build-windows-process-supervisor.mjs', '--out-dir', directory],
      { encoding: 'utf8', windowsHide: true }
    );
    if (compiled.status !== 0) throw new Error('Native supervisor test build failed');
    await build({
      entryPoints: ['src/windows-process-launcher.ts'],
      outfile: launcherPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    target = path.join(directory, 'target with spaces.cjs');
    writeFileSync(
      target,
      `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),input,mode:process.env.ELECTRON_RUN_AS_NODE??null}));process.stderr.write('target stderr');process.exitCode=7;});`
    );
  }, 180_000);
  afterAll(() => {
    if (
      directory &&
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('lody-owned-launch-')
    )
      rmSync(directory, { recursive: true, force: true });
  });
  async function run(command: string, args: string[], mode?: string, pathDirectory?: string) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (mode !== undefined) env.ELECTRON_RUN_AS_NODE = mode;
    if (pathDirectory) {
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
      env[pathKey] = [pathDirectory, env[pathKey] ?? ''].join(path.delimiter);
    }
    const child = spawnWindowsOwnedProcess(
      command,
      args,
      { cwd: directory, env, stdio: 'pipe' },
      { launcherPath, supervisorPath }
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin?.end('stdin snow 雪');
    const code = await closed;
    return { code, stdout, stderr };
  }
  it('preserves native argv, pipes, exit code and target environment', async () => {
    const args = ['space value', '雪', '& echo injected', 'quote"value'];
    const result = await run(process.execPath, [target, ...args]);
    expect(result.code).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ args, input: 'stdin snow 雪', mode: null });
    expect(result.stderr).toBe('target stderr');
  }, 15_000);
  it('preserves cmd launcher argument escaping and existing Node mode', async () => {
    const cmd = path.join(directory, 'target command.cmd');
    writeFileSync(cmd, `@"${process.execPath}" "${target}" %*\r\n`);
    const args = ['space value', '雪', '& echo injected'];
    const result = await run(cmd, args, '1');
    expect(result.code).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ args, input: 'stdin snow 雪', mode: '1' });
    expect(result.stderr).toBe('target stderr');
  }, 15_000);
  it('resolves a bare PATH command inside the owned Node launcher', async () => {
    const bin = mkdtempSync(path.join(directory, 'path-only-'));
    writeFileSync(
      path.join(bin, 'lody-owned-path-test.cmd'),
      `@"${process.execPath}" "${target}" %*\r\n`
    );
    const args = ['space value', '雪', '& echo injected'];
    const result = await run('lody-owned-path-test', args, undefined, bin);
    expect(result.code).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ args, input: 'stdin snow 雪', mode: null });
    expect(result.stderr).toBe('target stderr');
  }, 15_000);
  it('reports target spawn failure without unowned fallback', async () => {
    const result = await run(path.join(directory, 'missing-target.exe'), []);
    expect(result.code).toBe(125);
  }, 15_000);
  it('terminates the owned job through the retained child handle without consulting its PID', async () => {
    const source = String.raw`
      const { spawn } = require('node:child_process');
      function descendant(depth) {
        const { spawn } = require('node:child_process');
        setTimeout(() => process.exit(90), 60000);
        if (depth === 0) { process.send([process.pid]); return; }
        const child = spawn(process.execPath, ['-e', '(' + descendant.toString() + ')(' + (depth - 1) + ')'], {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: true,
        });
        child.once('message', (pids) => process.send([process.pid, ...pids]));
        child.once('error', () => process.exit(91));
      }
      const child = spawn(process.execPath, ['-e', '(' + descendant.toString() + ')(1)'], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: true,
      });
      child.once('message', (pids) => process.stdout.write(JSON.stringify([process.ppid, process.pid, ...pids]) + '\n'));
      child.once('error', () => process.exit(91));
      setTimeout(() => process.exit(90), 60000);
    `;
    const child = spawnWindowsOwnedProcess(
      process.execPath,
      ['-e', source],
      { stdio: 'pipe' },
      { launcherPath, supervisorPath }
    );
    const supervisorPid = z.number().int().positive().parse(child.pid);
    const closed = once(child, 'close', { signal: AbortSignal.timeout(30_000) });
    void closed.catch(() => {});
    let observer: ReturnType<typeof spawn> | undefined;
    let observerClosed: Promise<unknown[]> | undefined;
    let outputLines: ReturnType<typeof createInterface> | undefined;
    let observerLines: ReturnType<typeof createInterface> | undefined;
    try {
      if (!child.stdout) throw new Error('Owned fixture stdout unavailable');
      outputLines = createInterface({ input: child.stdout });
      const [line] = await once(outputLines, 'line', { signal: AbortSignal.timeout(10_000) });
      const pids = [
        supervisorPid,
        ...z
          .array(z.number().int().positive())
          .length(4)
          .parse(JSON.parse(String(line))),
      ];
      expect(new Set(pids).size).toBe(5);
      // Pin independent handles while every synthetic process is still alive.
      // Detached descendants remain alive after IPC disconnect, so killing only
      // the supervisor cannot satisfy this assertion without Job Object teardown.
      const script = String.raw`
        $ErrorActionPreference = 'Stop'
        $owned = @()
        try {
          foreach ($processId in @(${pids.join(',')})) {
            $item = [System.Diagnostics.Process]::GetProcessById($processId)
            $null = $item.Handle
            $owned += $item
            if ($item.HasExited) { throw 'Fixture exited before observation' }
          }
          [Console]::WriteLine('handles-ready')
          $command = [Console]::In.ReadLineAsync()
          if (-not $command.Wait(15000) -or $command.Result -ne 'verify') { throw 'Observation canceled' }
          foreach ($item in $owned) {
            if (-not $item.WaitForExit(5000)) { throw 'Owned process survived' }
            if ($item.ExitCode -eq 90) { throw 'Fixture watchdog fired' }
          }
          [Console]::WriteLine('all-five-exited')
        } finally {
          [Array]::Reverse($owned)
          $cleanupFailed = $false
          foreach ($item in $owned) {
            try {
              if (-not $item.HasExited) { $item.Kill() }
              if (-not $item.WaitForExit(5000)) { $cleanupFailed = $true }
            } catch { $cleanupFailed = $true } finally { $item.Dispose() }
          }
          if ($cleanupFailed) { throw 'Owned fixture cleanup failed' }
        }
      `;
      observer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      observerClosed = once(observer, 'close', { signal: AbortSignal.timeout(25_000) });
      void observerClosed.catch(() => {});
      if (!observer.stdout || !observer.stdin) throw new Error('Observer pipes unavailable');
      let output = '';
      let errors = '';
      observer.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      observer.stderr?.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      observerLines = createInterface({ input: observer.stdout });
      const [ready] = await once(observerLines, 'line', { signal: AbortSignal.timeout(10_000) });
      expect(ready).toBe('handles-ready');
      Object.defineProperty(child, 'pid', {
        get: () => {
          throw new Error('Cached supervisor PID was read');
        },
      });
      await terminateWindowsChildProcess(child, true);
      observer.stdin.end('verify\n');
      expect(await observerClosed, errors).toEqual([0, null]);
      expect(output).toContain('all-five-exited');
      await closed;
    } finally {
      observer?.stdin?.end();
      try {
        if (observerClosed) await observerClosed;
      } finally {
        observerLines?.close();
        outputLines?.close();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
      }
    }
  }, 40_000);
});
