import type { ChildProcess, SpawnOptions } from 'child_process';
import spawn from 'cross-spawn';

export interface WindowsProcessTreeOptions {
  timeoutMs?: number;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/**
 * Request recursive termination of a still-owned Windows child. A successful
 * taskkill result is not independent confirmation that the process tree is empty.
 * Never use an exited child's PID: Windows may have reassigned it.
 */
export async function terminateWindowsProcessTree(
  child: ChildProcess,
  force: boolean,
  options: WindowsProcessTreeOptions = {}
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Cannot terminate Windows process tree without an owned process ID');
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('Windows process tree termination timeout must be a positive bounded number');
  }
  const spawnProcess = options.spawnProcess ?? spawn;
  await new Promise<void>((resolve, reject) => {
    let helper: ChildProcess;
    try {
      helper = spawnProcess('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      reject(new Error('Could not start Windows process tree termination'));
      return;
    }
    let settled = false;
    let timedOut = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      helper.removeListener('error', onError);
      helper.removeListener('close', onClose);
      if (timedOut) reject(new Error('Windows process tree termination timed out'));
      else if (error) reject(error);
      else resolve();
    };
    const onError = () => finish(new Error('Windows process tree termination helper failed'));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0 && signal === null) finish();
      else finish(new Error('Windows process tree termination did not succeed'));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Only terminate our taskkill helper, never another process by a cached PID.
      try {
        helper.kill('SIGKILL');
      } catch {
        // Preserve the timeout result without exposing spawn arguments or output.
      }
      finish(new Error('Windows process tree termination timed out'));
    }, timeoutMs);
    helper.once('error', onError);
    helper.once('close', onClose);
  });
}
