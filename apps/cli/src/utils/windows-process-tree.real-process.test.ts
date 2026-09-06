import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { terminateWindowsProcessTree } from './windows-process-tree';

// IPC acknowledges the entire tree. Disconnecting IPC deliberately does NOT
// terminate descendants. Detached children prevent Windows parent-lifetime
// cleanup from masking a wrapper-only kill; taskkill /T must reach both levels.
const fixture = String.raw`
  function run(depth) {
    const { spawn } = require('node:child_process');
    setTimeout(() => process.exit(90), 60000); // Failure-only orphan watchdog.
    if (depth === 0) {
      process.send([process.pid]);
      return;
    }
    const child = spawn(process.execPath, ['-e', '(' + run.toString() + ')(' + (depth - 1) + ')'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: true,
    });
    child.once('message', (pids) => process.send([process.pid, ...pids]));
    child.once('error', () => process.exit(91));
  }
  run(2);
`;

function exitResult(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

describe.skipIf(process.platform !== 'win32')('Windows process tree integration', () => {
  it('terminates an owned wrapper, child, and grandchild, verified by OS handles', async () => {
    const root = spawn(process.execPath, ['-e', fixture], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    const rootExit = exitResult(root);
    // Attach rejection handlers immediately, including on early readiness failure.
    void rootExit.catch(() => {});
    let observer: ReturnType<typeof spawn> | undefined;
    let observerExit: Promise<number | null> | undefined;
    let lines: ReturnType<typeof createInterface> | undefined;
    try {
      const [message] = await once(root, 'message', { signal: AbortSignal.timeout(10_000) });
      const pids = z.array(z.number().int().positive()).length(3).parse(message);
      expect(pids[0]).toBe(root.pid);
      expect(new Set(pids).size).toBe(3);

      // Capture handles BEFORE termination. WaitForExit observes the original
      // objects even if Windows reuses a PID. Finally cleans up those same handles
      // if an assertion fails; it never searches for or kills arbitrary processes.
      const script = String.raw`
        $ErrorActionPreference = 'Stop'
        $owned = @()
        try {
          foreach ($processId in @(${pids.join(',')})) {
            $item = [System.Diagnostics.Process]::GetProcessById($processId)
            $null = $item.Handle
            $owned += $item
            if ($item.HasExited) { throw 'Fixture exited before verification' }
          }
          [Console]::WriteLine('handles-ready')
          $command = [Console]::In.ReadLineAsync()
          if (-not $command.Wait(10000) -or $command.Result -ne 'verify') {
            throw 'Verification handshake failed'
          }
          foreach ($item in $owned) {
            if (-not $item.WaitForExit(5000)) { throw 'Owned descendant remained alive' }
            if ($item.ExitCode -eq 90) { throw 'Fixture watchdog fired' }
          }
          [Console]::WriteLine('all-three-exited')
        } finally {
          [Array]::Reverse($owned)
          foreach ($item in $owned) {
            try {
              if (-not $item.HasExited) { $item.Kill() }
              if (-not $item.WaitForExit(5000)) { throw 'Fixture cleanup failed' }
            } finally { $item.Dispose() }
          }
        }
      `;
      observer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      observerExit = exitResult(observer);
      void observerExit.catch(() => {});
      if (!observer.stdout || !observer.stdin) throw new Error('Observer pipes unavailable');
      let output = '';
      observer.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      let errors = '';
      observer.stderr?.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      lines = createInterface({ input: observer.stdout });
      const [ready] = await once(lines, 'line', { signal: AbortSignal.timeout(10_000) });
      expect(ready).toBe('handles-ready');
      await terminateWindowsProcessTree(root, true);
      observer.stdin.end('verify\n');
      expect(await observerExit, errors).toBe(0);
      expect(output).toContain('all-three-exited');
      await rootExit;
    } finally {
      // Closing stdin asks the observer to clean captured handles on every failure.
      observer?.stdin?.end();
      try {
        if (observerExit) await observerExit;
      } finally {
        lines?.close();
        if (root.exitCode === null && root.signalCode === null) {
          await terminateWindowsProcessTree(root, true);
        }
        await rootExit;
      }
    }
  }, 40_000);
});
