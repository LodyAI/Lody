import { randomUUID } from 'crypto';
import { stat } from 'fs/promises';
import path from 'path';

import type { ChildProcess } from 'child_process';

import type { Logger } from '@/utils/logger';
import { decodeBuffer } from '@/utils/encoding';
import type {
  SessionProcessHandle,
  SessionResourceLimitViolation,
  SessionSandbox,
} from './session-sandbox';

export type TerminalExitStatus = { exitCode: number | null; signal?: string | null };

/**
 * The terminal command never started: its executable could not be resolved
 * (`ENOENT`) or could not be executed (`EACCES`).
 *
 * `createTerminal` rejects with this instead of resolving a terminal id, so the
 * ACP layer can answer with a typed JSON-RPC error. A bare errno (`-2`) leaves
 * agents unable to tell a bad command from a broken connection, and several
 * drop the whole ACP session over it.
 */
export class TerminalSpawnError extends Error {
  readonly spawnCode: 'ENOENT' | 'EACCES';
  readonly command: string;

  constructor(spawnCode: 'ENOENT' | 'EACCES', command: string, cause: unknown) {
    super(
      spawnCode === 'ENOENT'
        ? `Terminal command not found: ${command}`
        : `Terminal command is not executable: ${command}`,
      { cause }
    );
    this.name = 'TerminalSpawnError';
    this.spawnCode = spawnCode;
    this.command = command;
  }
}

export interface TerminalManager {
  createTerminal(
    acpSessionId: string,
    command: string,
    args?: string[],
    cwd?: string,
    env?: Record<string, string>,
    outputByteLimit?: number
  ): Promise<string>;
  terminalOutput(
    acpSessionId: string,
    terminalId: string
  ): Promise<{
    output: string;
    truncated: boolean;
    exitStatus: TerminalExitStatus | null;
  }>;
  releaseTerminal(acpSessionId: string, terminalId: string): Promise<void>;
  waitForTerminalExit(acpSessionId: string, terminalId: string): Promise<TerminalExitStatus>;
  killTerminal(acpSessionId: string, terminalId: string): Promise<void>;
  disposeAll?(acpSessionId: string): Promise<void>;
}

interface TerminalState<THandle> {
  id: string;
  handle: THandle;
  output: Buffer;
  outputByteLimit: number;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  waiters: Array<(status: TerminalExitStatus) => void>;
}

interface TerminalHooks {
  onData(chunk: Buffer): void;
  onExit(exitCode: number | null, signal: NodeJS.Signals | null): void;
  onError?(error: Error): void;
}

interface BaseTerminalManagerOptions {
  logger: Logger;
  sessionLabel: string;
  getActiveAcpSessionId: () => string | null;
  defaultOutputByteLimit?: number;
}

const DEFAULT_TERMINAL_BYTE_LIMIT = 1024 * 1024; // 1MB of retained output

abstract class BaseTerminalManager<THandle> implements TerminalManager {
  protected terminals = new Map<string, TerminalState<THandle>>();
  protected readonly logger: Logger;
  protected readonly sessionLabel: string;
  private readonly getActiveSessionId: () => string | null;
  private readonly defaultOutputByteLimit: number;

  constructor(options: BaseTerminalManagerOptions) {
    this.logger = options.logger;
    this.sessionLabel = options.sessionLabel;
    this.getActiveSessionId = options.getActiveAcpSessionId;
    this.defaultOutputByteLimit = options.defaultOutputByteLimit ?? DEFAULT_TERMINAL_BYTE_LIMIT;
  }

  async createTerminal(
    acpSessionId: string,
    command: string,
    args?: string[],
    cwd?: string,
    env?: Record<string, string>,
    outputByteLimit?: number
  ): Promise<string> {
    this.ensureValidSession(acpSessionId);

    const terminalId = randomUUID();
    const state: TerminalState<THandle> = {
      id: terminalId,
      handle: null as unknown as THandle,
      output: Buffer.alloc(0),
      outputByteLimit: outputByteLimit ?? this.defaultOutputByteLimit,
      truncated: false,
      exitStatus: null,
      waiters: [],
    };

    const hooks: TerminalHooks = {
      onData: (chunk) => this.appendOutput(state, chunk),
      onExit: (exitCode, signal) => this.handleExit(state, exitCode, signal),
      onError: (error) => {
        this.logger.error(`[${this.sessionLabel}] Terminal ${terminalId} error: ${error.message}`);
        // A process error is terminal for this handle: the child either never
        // started or died outside the exit path. Without recording an exit
        // status here `terminal/wait_for_exit` would never resolve and the
        // agent's turn would hang forever.
        this.handleExit(state, null, null);
      },
    };

    state.handle = await this.startProcess(
      {
        terminalId,
        command,
        args: args ?? [],
        cwd,
        env,
      },
      hooks
    );

    this.terminals.set(terminalId, state);
    this.logger.debug(`[${this.sessionLabel}] Terminal ${terminalId} started: ${command}`);
    return terminalId;
  }

  async terminalOutput(acpSessionId: string, terminalId: string) {
    const state = this.getTerminal(acpSessionId, terminalId);
    return {
      // Use decodeBuffer to handle Windows code page encoding (e.g., CP936 for Chinese)
      // On non-Windows platforms, this is equivalent to toString('utf8')
      output: decodeBuffer(state.output),
      truncated: state.truncated,
      exitStatus: state.exitStatus,
    };
  }

  async releaseTerminal(acpSessionId: string, terminalId: string): Promise<void> {
    const state = this.getTerminal(acpSessionId, terminalId);
    try {
      await this.killHandle(state);
    } catch (error) {
      this.logger.debug(
        `[${this.sessionLabel}] Failed to kill terminal ${terminalId} on release: ${error}`
      );
    }
    if (!state.exitStatus) {
      state.exitStatus = { exitCode: null, signal: 'SIGTERM' };
      this.resolveWaiters(state);
    }
    await this.disposeHandle(state);
    this.terminals.delete(terminalId);
    this.logger.debug(`[${this.sessionLabel}] Terminal ${terminalId} released`);
  }

  async waitForTerminalExit(acpSessionId: string, terminalId: string): Promise<TerminalExitStatus> {
    const state = this.getTerminal(acpSessionId, terminalId);
    if (state.exitStatus) {
      return state.exitStatus;
    }

    return await new Promise<TerminalExitStatus>((resolve) => {
      state.waiters.push(resolve);
    });
  }

  async killTerminal(acpSessionId: string, terminalId: string): Promise<void> {
    const state = this.getTerminal(acpSessionId, terminalId);
    await this.killHandle(state);
  }

  async disposeAll(acpSessionId: string): Promise<void> {
    this.ensureValidSession(acpSessionId);
    const terminalIds = Array.from(this.terminals.keys());
    if (terminalIds.length === 0) {
      return;
    }
    await Promise.allSettled(
      terminalIds.map(async (terminalId) => {
        await this.releaseTerminal(acpSessionId, terminalId);
      })
    );
  }

  protected abstract startProcess(
    params: {
      terminalId: string;
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
    },
    hooks: TerminalHooks
  ): Promise<THandle>;

  protected abstract killHandle(state: TerminalState<THandle>): Promise<void>;

  protected abstract disposeHandle(state: TerminalState<THandle>): Promise<void>;

  private resolveWaiters(state: TerminalState<THandle>) {
    const exitStatus = state.exitStatus ?? { exitCode: null, signal: null };
    while (state.waiters.length) {
      const waiter = state.waiters.shift();
      if (waiter) {
        waiter(exitStatus);
      }
    }
  }

  private ensureValidSession(acpSessionId: string) {
    const active = this.getActiveSessionId();
    if (!active) {
      throw new Error('ACP session is not active yet.');
    }
    if (active !== acpSessionId) {
      throw new Error(`ACP session mismatch for terminal request: ${acpSessionId}`);
    }
  }

  private getTerminal(acpSessionId: string, terminalId: string): TerminalState<THandle> {
    this.ensureValidSession(acpSessionId);
    const state = this.terminals.get(terminalId);
    if (!state) {
      throw new Error(`Terminal ${terminalId} not found or already released`);
    }
    return state;
  }

  private handleExit(
    state: TerminalState<THandle>,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ) {
    // A released terminal keeps the status `releaseTerminal` already recorded.
    // A terminal that fails between `startProcess` and registration has no map
    // entry yet and still needs one, or a later wait would never resolve.
    if (!this.terminals.has(state.id) && state.exitStatus) {
      return;
    }
    state.exitStatus = {
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      signal: signal ?? undefined,
    };
    this.resolveWaiters(state);
  }

  private appendOutput(state: TerminalState<THandle>, chunk: Buffer) {
    if (state.outputByteLimit === 0) {
      if (chunk.length) {
        state.truncated = true;
      }
      return;
    }
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    state.output = Buffer.concat([state.output, data]);
    if (state.output.length > state.outputByteLimit) {
      state.truncated = true;
      state.output = truncateBuffer(state.output, state.outputByteLimit);
    }
  }
}

export interface ShellTerminalManagerOptions extends BaseTerminalManagerOptions {
  resolveWorkdir: (cwd?: string) => string;
  buildEnv: (overrides?: Record<string, string>) => NodeJS.ProcessEnv;
  sandbox: SessionSandbox;
  onResourceLimitExceeded?: (violation: SessionResourceLimitViolation) => Promise<void> | void;
  /** Defaults to the host platform; injected so both shell branches are testable. */
  platform?: NodeJS.Platform;
}

interface ShellTerminalHandle {
  processHandle: SessionProcessHandle;
  dispose(): void;
}

export class ShellTerminalManager
  extends BaseTerminalManager<ShellTerminalHandle>
  implements TerminalManager
{
  private readonly resolveWorkdir: ShellTerminalManagerOptions['resolveWorkdir'];
  private readonly buildEnv: ShellTerminalManagerOptions['buildEnv'];
  private readonly sandbox: ShellTerminalManagerOptions['sandbox'];
  private readonly onResourceLimitExceeded?: ShellTerminalManagerOptions['onResourceLimitExceeded'];
  private readonly platform: NodeJS.Platform;

  constructor(options: ShellTerminalManagerOptions) {
    super(options);
    this.resolveWorkdir = options.resolveWorkdir;
    this.buildEnv = options.buildEnv;
    this.sandbox = options.sandbox;
    this.onResourceLimitExceeded = options.onResourceLimitExceeded;
    this.platform = options.platform ?? process.platform;
  }

  protected async startProcess(
    params: {
      terminalId: string;
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
    },
    hooks: TerminalHooks
  ): Promise<ShellTerminalHandle> {
    const workdir = this.resolveWorkdir(params.cwd);
    const env = this.buildEnv(params.env);
    const target = await resolveTerminalSpawnTarget(
      params.command,
      params.args,
      workdir,
      this.platform
    );
    let processHandle: SessionProcessHandle;
    try {
      processHandle = await this.sandbox.spawn(target.command, target.args, {
        cwd: workdir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A fast terminal command can exit before spawn() returns; without
        // capture its output would be dropped before the agent ever sees it.
        captureOutput: true,
      });
    } catch (error) {
      throw toTerminalSpawnError(error, target.command);
    }

    const stdoutListener = (chunk: Buffer) => hooks.onData(chunk);
    const stderrListener = (chunk: Buffer) => hooks.onData(chunk);
    const closeListener = (code: number | null, signal: NodeJS.Signals | null) => {
      void processHandle
        .inspectExit(code, signal)
        .then((violation) => {
          if (violation) {
            this.logger.debug(
              `[${this.sessionLabel}] Terminal ${params.terminalId} exceeded a resource limit: ${violation.message}`
            );
            return this.onResourceLimitExceeded?.(violation);
          }
          return undefined;
        })
        .catch((error: unknown) => {
          hooks.onError?.(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          hooks.onExit(code, signal);
        });
    };
    const errorListener = (error: Error) => hooks.onError?.(error);

    const unsubscribeStdout = processHandle.onStdout(stdoutListener);
    const unsubscribeStderr = processHandle.onStderr(stderrListener);
    const unsubscribeClose = processHandle.onClose(closeListener);
    const unsubscribeError = processHandle.onError(errorListener);
    const dispose = () => {
      unsubscribeStdout();
      unsubscribeStderr();
      unsubscribeClose();
      unsubscribeError();
    };

    // Sandboxes that do not await the child's pid hand back a handle before the
    // OS has reported the failure, so an unresolvable executable would become a
    // live terminal id whose exit never arrives. Fail the request instead.
    try {
      await waitForSpawnConfirmation(processHandle);
    } catch (error) {
      dispose();
      throw toTerminalSpawnError(error, target.command);
    }

    return { processHandle, dispose };
  }

  protected async killHandle(state: TerminalState<ShellTerminalHandle>): Promise<void> {
    if (!state.exitStatus) {
      await state.handle.processHandle.terminate(false);
    }
  }

  protected async disposeHandle(state: TerminalState<ShellTerminalHandle>): Promise<void> {
    state.handle.dispose();
  }
}

/**
 * ACP `terminal/create` carries the executable in `command` and its argv in
 * `args`, and that pair is what gets spawned (see AGENTS.md). Some agents
 * instead put the whole shell line in `command` and leave `args` empty; spawned
 * literally, that fails with `ENOENT` and the agent loses its terminal.
 *
 * Only that exact shape falls back to a shell, and only when the line does not
 * name an existing file, so an executable path that merely contains a space is
 * still spawned directly. The shell is non-interactive and non-login (`sh -c`,
 * not `bash -lc`): the agent asked for one command, not for the user's login
 * profile to run.
 */
async function resolveTerminalSpawnTarget(
  command: string,
  args: string[],
  workdir: string,
  platform: NodeJS.Platform
): Promise<{ command: string; args: string[] }> {
  if (args.length > 0 || !/\s/.test(command)) {
    return { command, args };
  }
  if (await isExistingFile(path.resolve(workdir, command))) {
    return { command, args };
  }
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/c', command] }
    : { command: '/bin/sh', args: ['-c', command] };
}

async function isExistingFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve once the child has a pid, reject with its spawn error otherwise.
 * Node sets `pid` synchronously on success, so a started process costs nothing
 * here; only a failing spawn waits for the buffered `error` event.
 */
function waitForSpawnConfirmation(handle: SessionProcessHandle): Promise<void> {
  const child: ChildProcess = handle.child;
  if (typeof child.pid === 'number' && child.pid > 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const disposers: Array<() => void> = [];
    const settle = (report: () => void) => {
      if (settled) return;
      settled = true;
      for (const dispose of disposers) dispose();
      report();
    };
    const handleSpawn = () => settle(resolve);
    child.once('spawn', handleSpawn);
    disposers.push(() => child.off('spawn', handleSpawn));
    disposers.push(handle.onError((error) => settle(() => reject(error))));
  });
}

function toTerminalSpawnError(error: unknown, command: string): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EACCES') {
    return new TerminalSpawnError(code, command, error);
  }
  return error;
}

function truncateBuffer(buffer: Buffer, limit: number): Buffer {
  if (buffer.length <= limit) {
    return buffer;
  }
  let start = buffer.length - limit;
  while (start < buffer.length && isUtf8ContinuationByte(buffer[start])) {
    start += 1;
  }
  return buffer.slice(start);
}

function isUtf8ContinuationByte(byte: number | undefined): byte is number {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
