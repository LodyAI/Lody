import type { ChildProcess } from 'child_process';

export interface WindowsChildProcessOptions {
  timeoutMs?: number;
}

/**
 * Terminate through Node's retained Windows process handle, never a cached PID.
 * This confirms root exit only. Descendant teardown requires spawn-time job ownership.
 * Windows treats both SIGTERM and SIGKILL as immediate termination; callers must
 * complete any graceful protocol shutdown before invoking this utility.
 */
export async function terminateWindowsChildProcess(
  child: ChildProcess,
  force: boolean,
  options: WindowsChildProcessOptions = {}
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('Windows child termination timeout must be a positive bounded number');
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error?: NodeJS.ErrnoException) => {
      // Node records a negative spawn exit code before emitting spawn failure.
      // No process exists in this case, and no exit event will follow.
      if (
        child.exitCode != null &&
        child.exitCode < 0 &&
        (error?.syscall === 'spawn' || error?.syscall?.startsWith('spawn '))
      ) {
        finish();
        return;
      }
      finish(new Error('Windows child termination failed'));
    };
    const onExit = () => finish();
    const timer = setTimeout(
      () => finish(new Error('Windows child termination timed out')),
      timeoutMs
    );
    child.once('error', onError);
    child.once('exit', onExit);
    try {
      // false can mean the OS process exited before Node delivered its exit event.
      // Continue waiting for that event; neither a boolean nor a PID proves exit.
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      // A not-yet-delivered spawn failure has no valid native handle: kill
      // returns EINVAL. Await its queued error; the deadline still rejects
      // if no terminal lifecycle evidence arrives.
      if (
        !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EINVAL')
      )
        onError();
    }
  });
}
