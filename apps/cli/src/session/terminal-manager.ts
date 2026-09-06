import { randomUUID } from 'crypto';

import type { Logger } from '@/utils/logger';
import { decodeBuffer } from '@/utils/encoding';
import type {
  SessionProcessHandle,
  SessionResourceLimitViolation,
  SessionSandbox,
} from './session-sandbox';

export type TerminalExitStatus = { exitCode: number | null; signal?: string | null };

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
  releasing?: Promise<void>;
  disposed: boolean;
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
      disposed: false,
    };

    const hooks: TerminalHooks = {
      onData: (chunk) => this.appendOutput(state, chunk),
      onExit: (exitCode, signal) => this.handleExit(state, exitCode, signal),
      onError: (error) => {
        this.logger.error(`[${this.sessionLabel}] Terminal ${terminalId} error: ${error.message}`);
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
    if (state.releasing) return state.releasing;
    const releasing = this.releaseState(state);
    state.releasing = releasing;
    try {
      await releasing;
    } finally {
      state.releasing = undefined;
    }
  }

  private async releaseState(state: TerminalState<THandle>): Promise<void> {
    if (!state.exitStatus) {
      let forced = false;
      try {
        await this.killHandle(state);
      } catch (error) {
        if (!this.isHandleLive(state)) throw error;
        await this.killHandle(state, true);
        forced = true;
      }
      if (!(await this.waitForObservedExit(state))) {
        if (!forced && this.isHandleLive(state)) {
          await this.killHandle(state, true);
          if (!(await this.waitForObservedExit(state))) {
            throw new Error('Terminal process did not report exit after forced termination');
          }
        } else {
          throw new Error('Terminal process did not report exit after termination');
        }
      }
    }
    await this.disposeHandle(state);
    state.disposed = true;
    this.terminals.delete(state.id);
    this.logger.debug(`[${this.sessionLabel}] Terminal ${state.id} released`);
  }

  private waitForObservedExit(state: TerminalState<THandle>): Promise<boolean> {
    if (state.exitStatus) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        resolve(false);
      }, 5_000);
      state.waiters.push(waiter);
    });
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
    const results = await Promise.allSettled(
      terminalIds.map(async (terminalId) => {
        await this.releaseTerminal(acpSessionId, terminalId);
      })
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) throw new AggregateError(failures, 'Terminal disposal failed');
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

  protected abstract killHandle(state: TerminalState<THandle>, force?: boolean): Promise<void>;
  protected abstract isHandleLive(state: TerminalState<THandle>): boolean;

  protected abstract disposeHandle(state: TerminalState<THandle>): Promise<void>;

  private resolveWaiters(state: TerminalState<THandle>) {
    const exitStatus = state.exitStatus;
    if (!exitStatus) return;
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
    if (state.disposed || state.exitStatus) {
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

  constructor(options: ShellTerminalManagerOptions) {
    super(options);
    this.resolveWorkdir = options.resolveWorkdir;
    this.buildEnv = options.buildEnv;
    this.sandbox = options.sandbox;
    this.onResourceLimitExceeded = options.onResourceLimitExceeded;
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
    const processHandle = await this.sandbox.spawn(params.command, params.args, {
      cwd: workdir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A fast terminal command can exit before spawn() returns; without
      // capture its output would be dropped before the agent ever sees it.
      captureOutput: true,
    });

    const stdoutListener = (chunk: Buffer) => hooks.onData(chunk);
    const stderrListener = (chunk: Buffer) => hooks.onData(chunk);
    const closeListener = (code: number | null, signal: NodeJS.Signals | null) => {
      // OS close is authoritative even if resource accounting is slow or stuck.
      hooks.onExit(code, signal);
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
        });
    };
    const errorListener = (error: Error) => hooks.onError?.(error);

    const unsubscribeStdout = processHandle.onStdout(stdoutListener);
    const unsubscribeStderr = processHandle.onStderr(stderrListener);
    const unsubscribeClose = processHandle.onClose(closeListener);
    const unsubscribeError = processHandle.onError(errorListener);

    return {
      processHandle,
      dispose: () => {
        unsubscribeStdout();
        unsubscribeStderr();
        unsubscribeClose();
        unsubscribeError();
      },
    };
  }

  protected isHandleLive(state: TerminalState<ShellTerminalHandle>): boolean {
    const child = state.handle.processHandle.child;
    return child.exitCode == null && child.signalCode == null;
  }

  protected async killHandle(
    state: TerminalState<ShellTerminalHandle>,
    force = false
  ): Promise<void> {
    if (!state.exitStatus) {
      await state.handle.processHandle.terminate(force);
    }
  }

  protected async disposeHandle(state: TerminalState<ShellTerminalHandle>): Promise<void> {
    state.handle.dispose();
  }
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
