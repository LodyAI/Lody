import type { ChildProcess, SpawnOptions, StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Duplex } from 'node:stream';
import spawn from 'cross-spawn';

export const WINDOWS_TARGET_NODE_MODE = 'LODY_WINDOWS_TARGET_NODE_MODE';

/** Both production and development bundles place shared chunks one level below assets. */
export function windowsOwnershipRuntimeRoot(moduleUrl: string): URL {
  const directory = new URL('.', moduleUrl);
  return directory.pathname.endsWith('/chunks/') ? new URL('../', directory) : directory;
}

export interface WindowsOwnedProcessDependencies {
  spawnProcess?: typeof spawn;
  supervisorPath?: string;
  launcherPath?: string;
  exists?: (path: string) => boolean;
  timeoutMs?: number;
}

/** The returned process is the job supervisor; its exit releases the entire job. */
export function spawnWindowsOwnedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  deps: WindowsOwnedProcessDependencies = {}
): ChildProcess {
  const runtimeRoot = windowsOwnershipRuntimeRoot(import.meta.url);
  const supervisorPath =
    deps.supervisorPath ??
    fileURLToPath(new URL(`windows-process-supervisor-win32-${process.arch}.exe`, runtimeRoot));
  const launcherPath =
    deps.launcherPath ?? fileURLToPath(new URL('windows-process-launcher.js', runtimeRoot));
  const exists = deps.exists ?? existsSync;
  if (!exists(supervisorPath) || !exists(launcherPath))
    throw new Error('Windows process ownership runtime is unavailable');
  if (options.shell || options.windowsVerbatimArguments)
    throw new Error('Owned Windows process launch requires structured arguments');
  const selected = options.stdio ?? 'pipe';
  const stdio: StdioOptions =
    typeof selected === 'string' ? [selected, selected, selected] : [...selected];
  if (stdio.length > 3)
    throw new Error('Owned Windows processes support only standard input/output/error');
  while (stdio.length < 3) stdio.push('pipe');
  stdio.push('pipe');
  const targetEnv = options.env ?? process.env;
  const child = (deps.spawnProcess ?? spawn)(
    supervisorPath,
    ['--owner-pid', String(process.pid), '--', process.execPath, launcherPath, command, ...args],
    {
      ...options,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio,
      env: {
        ...targetEnv,
        [WINDOWS_TARGET_NODE_MODE]: JSON.stringify(targetEnv.ELECTRON_RUN_AS_NODE ?? null),
        ELECTRON_RUN_AS_NODE: '1',
      },
    }
  );
  const control = child.stdio[3];
  if (!(control instanceof Duplex)) {
    child.kill();
    throw new Error('Windows process ownership control channel is unavailable');
  }
  let state: 'ready' | 'prepared' | 'started' = 'ready';
  let buffer = '';
  let failed = false;
  let established = false;
  const finishHandshake = () => {
    clearTimeout(timer);
    control.off('data', onData);
  };
  const cleanup = () => {
    finishHandshake();
    control.off('error', onControlError);
    control.off('close', onControlClose);
    child.off('error', onChildError);
    child.off('exit', cleanup);
    control.destroy();
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    cleanup();
    // Closing fd3 withdraws authorization; the native supervisor owns job teardown.
    child.emit('error', new Error('Windows process ownership handshake failed'));
  };
  const onChildError = () => {
    failed = true;
    cleanup();
  };
  const onControlError = () => fail();
  const onControlClose = () => {
    if (!established && child.exitCode == null && child.signalCode == null) fail();
  };
  const onData = (chunk: Buffer) => {
    if (Buffer.byteLength(buffer, 'utf8') + chunk.byteLength > 4096) {
      fail();
      return;
    }
    buffer += chunk.toString('utf8');
    if (buffer.length > 4096) {
      fail();
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        fail();
        return;
      }
      if (typeof message !== 'object' || message === null || !('type' in message)) {
        fail();
        return;
      }
      if (
        state === 'ready' &&
        message.type === 'ready' &&
        'protocol' in message &&
        message.protocol === 1
      ) {
        state = 'prepared';
        control.write('start\n');
      } else if (
        state === 'prepared' &&
        message.type === 'prepared' &&
        'pid' in message &&
        typeof message.pid === 'number' &&
        Number.isSafeInteger(message.pid) &&
        message.pid > 0
      ) {
        state = 'started';
        control.write('resume\n');
      } else if (state === 'started' && message.type === 'started') {
        established = true;
        finishHandshake();
        return;
      } else {
        fail();
        return;
      }
    }
  };
  const timer = setTimeout(fail, deps.timeoutMs ?? 10_000);
  control.on('data', onData);
  control.on('error', onControlError);
  control.on('close', onControlClose);
  child.on('error', onChildError);
  child.once('exit', cleanup);
  return child;
}

function spawnWithOwnership(
  command: string,
  args?: readonly string[] | SpawnOptions,
  options?: SpawnOptions
): ChildProcess {
  const argv = Array.isArray(args) ? args : [];
  const spawnOptions = Array.isArray(args)
    ? (options ?? {})
    : ((args as SpawnOptions | undefined) ?? options ?? {});
  return process.platform === 'win32'
    ? spawnWindowsOwnedProcess(command, argv, spawnOptions)
    : spawn(command, argv, spawnOptions);
}

/** Preserve the cross-spawn injection surface used by existing process factories. */
export const spawnOwnedProcess: typeof spawn = Object.assign(spawnWithOwnership, {
  spawn: (): never => {
    throw new Error('Use the callable owned process launcher');
  },
  sync: (): never => {
    throw new Error('Synchronous owned process launch is unsupported');
  },
});
