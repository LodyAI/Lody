import type { ChildProcess, SpawnOptions } from 'child_process';
import * as fs from 'fs/promises';

import spawn from 'cross-spawn';
import { Effect, Exit, Scope } from 'effect';
import { type SessionId } from '@lody/shared';

import { platformLayer, makePlatformRunner, type PlatformRunner } from '@/platform/promise-facade';
import { SpawnFailed } from '@/platform/process/errors';
import type { NodeProcessApi } from '@/platform/process/node-process';
import { makeCgroupContainer, type CgroupFs } from '@/platform/sandbox/cgroup-container';
import { makeNoopContainer } from '@/platform/sandbox/noop-container';
import {
  terminationPolicy,
  type MachineCapacitySnapshot,
  type ProcessContainer,
  type SessionResourceAccounting,
  type SessionResourceLimitViolation,
  type SessionSandboxLimits,
} from '@/platform/sandbox/types';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { applyExecutionProcessResourceProfile } from '@/utils/process-resource-profile';

export type {
  MachineCapacitySnapshot,
  SessionResourceAccounting,
  SessionResourceLimitViolation,
  SessionSandboxLimits,
};

/*
 * TEMPORARY Promise facade over the Effect process containers in
 * `@/platform/sandbox`. `Session` and `TerminalManager` still speak Promises;
 * when the session resource layer becomes an Effect it uses the containers
 * directly and this file goes away. Process lifecycle rules live in the
 * containers, not here: this file only adapts calls and replays events.
 */

const DEFAULT_CGROUP_MOUNT = '/sys/fs/cgroup';
const DEFAULT_EXECUTION_BUDGET_RATIO = 0.75;
const DEFAULT_CPU_MAX_PERIOD_US = 100_000;
const DEFAULT_SESSION_PIDS_MAX = 1024;
const MIB = 1024 * 1024;
/**
 * Ceiling on stdio held between spawn and the caller's subscription. Generous
 * next to what consumers keep (a terminal retains 1 MiB) but bounded, so a
 * noisy command during a slow post-spawn setup cannot grow the daemon heap.
 */
const MAX_BRIDGE_CAPTURE_BYTES = 4 * MIB;

export class SessionResourceLimitError extends Error {
  readonly sessionId: SessionId;
  readonly violation: SessionResourceLimitViolation;

  constructor(sessionId: SessionId, violation: SessionResourceLimitViolation) {
    super(violation.message);
    this.name = 'SessionResourceLimitError';
    this.sessionId = sessionId;
    this.violation = violation;
  }
}

export interface SessionSpawnOptions extends SpawnOptions {
  /**
   * Capture stdout/stderr from the moment the child is spawned instead of from
   * the moment the caller subscribes.
   *
   * spawn() does async post-spawn work (resource profile, cgroup attachment),
   * so a short-lived child can exit and have its stdio streams destroyed —
   * discarding whatever they had buffered — before the caller ever gets the
   * handle. Set this for commands whose output is the result.
   */
  captureOutput?: boolean;
}

export interface SessionProcessHandle {
  child: ChildProcess;
  inspectExit: (
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ) => Promise<SessionResourceLimitViolation | null>;
  /**
   * Terminate this process and every descendant: SIGTERM with a bounded grace
   * period (or SIGKILL at once when `force`), then a bounded wait. Rejects with
   * `TerminationFailed` when the tree cannot be proven gone.
   */
  terminate(force: boolean): Promise<void>;
  onExit(listener: ProcessExitListener): () => void;
  onClose(listener: ProcessExitListener): () => void;
  onError(listener: ProcessErrorListener): () => void;
  /**
   * Subscribe to stdout. With `captureOutput`, chunks that arrived before this
   * call are replayed synchronously, in order, before the listener returns.
   */
  onStdout(listener: ProcessOutputListener): () => void;
  onStderr(listener: ProcessOutputListener): () => void;
}

export interface SessionSandbox {
  readonly enabled: boolean;
  readonly description: string;
  applyLimits(limits: SessionSandboxLimits): Promise<void>;
  readResourceAccounting(): Promise<SessionResourceAccounting>;
  spawn(
    command: string,
    args: string[],
    options: SessionSpawnOptions
  ): Promise<SessionProcessHandle>;
  /** Terminate every process the sandbox started; rejects if any tree survives. */
  terminate(force?: boolean): Promise<void>;
  cleanup(): Promise<void>;
}

export type SessionSandboxFactory = (sessionId: SessionId) => Promise<SessionSandbox>;

interface SessionSandboxDeps {
  platform: NodeJS.Platform;
  cgroupMount: string;
  fs: CgroupFs;
  spawnProcess: typeof spawn;
  readSelfCgroupPath: () => Promise<string>;
  configureExecutionProcess: (pid: number, logger?: Logger) => Promise<void>;
  killPid: (pid: number, signal?: NodeJS.Signals | 0) => void;
}

interface CreateSessionSandboxFactoryOptions {
  logger: Logger;
  deps?: Partial<SessionSandboxDeps>;
}

type ProcessExitListener = (exitCode: number | null, signal: NodeJS.Signals | null) => void;
type ProcessErrorListener = (error: Error) => void;
type ProcessOutputListener = (chunk: Buffer) => void;

const defaultSandboxDeps = (): SessionSandboxDeps => ({
  platform: process.platform,
  cgroupMount: DEFAULT_CGROUP_MOUNT,
  fs,
  spawnProcess: spawn,
  readSelfCgroupPath: async () => {
    const content = (await fs.readFile('/proc/self/cgroup', 'utf8')) as string;
    const line = content
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item.startsWith('0::'));
    if (!line) {
      throw new Error('Unable to determine current cgroup path from /proc/self/cgroup');
    }
    const cgroupPath = line.slice(3).trim();
    return cgroupPath || '/';
  },
  configureExecutionProcess: async (pid: number, logger?: Logger) => {
    await applyExecutionProcessResourceProfile(pid, logger);
  },
  killPid: (pid: number, signal?: NodeJS.Signals | 0) => {
    process.kill(pid, signal);
  },
});

const toNodeProcess = (deps: SessionSandboxDeps): NodeProcessApi => ({
  platform: deps.platform,
  spawn: (command, args, options) => deps.spawnProcess(command, [...args], options),
  kill: (pid, signal) => deps.killPid(pid, signal),
});

const configureProcessBestEffort =
  (deps: Pick<SessionSandboxDeps, 'configureExecutionProcess'>, logger?: Logger, prefix = '') =>
  (pid: number): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () => deps.configureExecutionProcess(pid, logger),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.logDebug(
          `${prefix}Failed to apply execution-plane process resource profile to pid ${pid}: ${formatErrorMessage(cause)}`
        )
      )
    );

export function createSessionSandboxFactory(
  options: CreateSessionSandboxFactoryOptions
): SessionSandboxFactory {
  const deps: SessionSandboxDeps = {
    ...defaultSandboxDeps(),
    ...(options.deps ?? {}),
  };
  const facade = { logger: options.logger, nodeProcess: toNodeProcess(deps) };
  const run = makePlatformRunner(facade);
  let warnedUnsupportedPlatform = false;

  return async (sessionId: SessionId): Promise<SessionSandbox> => {
    if (deps.platform !== 'linux') {
      if (!warnedUnsupportedPlatform) {
        warnedUnsupportedPlatform = true;
        options.logger.debug(
          `[ExecSandbox] Native execution sandbox is enabled by default, but hard resource limits are only supported on Linux (current platform=${deps.platform})`
        );
      }
      return createNoopSandbox(facade, run, deps, `unsupported-platform:${deps.platform}`);
    }

    const scope = await run(Scope.make());
    const cgroup = await run(
      Scope.extend(
        makeCgroupContainer({
          sessionId,
          cgroupMount: deps.cgroupMount,
          fs: deps.fs,
          readSelfCgroupPath: deps.readSelfCgroupPath,
          configureProcess: configureProcessBestEffort(deps, options.logger, `[${sessionId}] `),
        }),
        scope
      ).pipe(Effect.either)
    );
    if (cgroup._tag === 'Right') {
      return new ContainerSessionSandbox(cgroup.right, scope, run, options.logger);
    }
    await run(Scope.close(scope, Exit.void));
    options.logger.debug(
      `[${sessionId}] Execution sandbox unavailable; continuing without hard resource limits: ${cgroup.left.message}`
    );
    return createNoopSandbox(facade, run, deps, 'cgroup-init-failed');
  };
}

export function createSessionResourceLimitError(
  sessionId: SessionId,
  violation: SessionResourceLimitViolation
): SessionResourceLimitError {
  return new SessionResourceLimitError(sessionId, violation);
}

export function createNoopSessionSandbox(
  spawnProcess: typeof spawn = spawn,
  description: string = 'noop'
): SessionSandbox {
  const deps: SessionSandboxDeps = { ...defaultSandboxDeps(), spawnProcess };
  const facade = { nodeProcess: toNodeProcess(deps) };
  return createNoopSandbox(facade, makePlatformRunner(facade), deps, description);
}

function createNoopSandbox(
  facade: { logger?: Logger; nodeProcess: NodeProcessApi },
  run: PlatformRunner,
  deps: SessionSandboxDeps,
  description: string
): SessionSandbox {
  // Building the noop container is synchronous, which keeps
  // `createNoopSessionSandbox` usable as a constructor default.
  const build = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const container = yield* Scope.extend(
      makeNoopContainer({
        description,
        configureProcess: configureProcessBestEffort(deps, facade.logger),
      }),
      scope
    );
    return { scope, container };
  });
  const { scope, container } = Effect.runSync(Effect.provide(build, platformLayer(facade)));
  return new ContainerSessionSandbox(container, scope, run, facade.logger);
}

class ContainerSessionSandbox implements SessionSandbox {
  constructor(
    private readonly container: ProcessContainer,
    private readonly scope: Scope.CloseableScope,
    private readonly run: PlatformRunner,
    private readonly logger: Logger | undefined
  ) {}

  get enabled(): boolean {
    return this.container.enabled;
  }

  get description(): string {
    return this.container.description;
  }

  async applyLimits(limits: SessionSandboxLimits): Promise<void> {
    await this.run(this.container.applyLimits(limits));
  }

  async readResourceAccounting(): Promise<SessionResourceAccounting> {
    return await this.run(this.container.readAccounting);
  }

  async spawn(
    command: string,
    args: string[],
    options: SessionSpawnOptions
  ): Promise<SessionProcessHandle> {
    const { captureOutput, ...spawnOptions } = options;
    let events: ProcessEvents | undefined;
    const contained = await this.run(
      this.container.spawn({
        command,
        args,
        options: spawnOptions,
        onSpawned: (child) => {
          events = attachProcessEvents(child, { captureOutput, logger: this.logger });
        },
      })
    ).catch((error: unknown) => {
      // Callers classify the OS error itself (ENOENT, EACCES), as they did
      // before the process layer wrapped it.
      throw error instanceof SpawnFailed && error.cause instanceof Error ? error.cause : error;
    });
    if (!events) {
      throw new Error(`Process events were not attached for ${command}`);
    }
    const run = this.run;
    return {
      child: contained.child,
      inspectExit: (exitCode, signal) => run(contained.inspectExit({ code: exitCode, signal })),
      terminate: (force) => run(contained.terminate(terminationPolicy(force))),
      ...events,
    };
  }

  async terminate(force: boolean = false): Promise<void> {
    await this.run(this.container.terminateAll(terminationPolicy(force)));
  }

  async cleanup(): Promise<void> {
    await this.run(Effect.zipRight(this.container.cleanup, Scope.close(this.scope, Exit.void)));
  }
}

// Default Linux policy reserves 25% of effective memory (cgroup-aware) and CPU for the
// control plane (daemon, Loro docs, system services) and evenly splits the remaining 75%
// across active sessions. The higher headroom prevents runaway sessions from starving the
// kernel and system services, which previously caused full-machine lockups. See
// docs/exec-sandbox.md and specs/container-resources.md for the design rationale.
export function calculateAutomaticSessionSandboxLimits(
  machineCapacity: MachineCapacitySnapshot,
  activeSessionCount: number
): SessionSandboxLimits {
  const totalMemoryBytes = Math.max(1, Math.floor(machineCapacity.totalMemoryBytes));
  const totalCpuCount = Math.max(1, Math.floor(machineCapacity.totalCpuCount));
  const sessionCount = Math.max(1, Math.floor(activeSessionCount));

  const executionMemoryBudgetBytes = Math.max(
    1,
    Math.floor(totalMemoryBytes * DEFAULT_EXECUTION_BUDGET_RATIO)
  );
  const executionCpuBudgetMicros = Math.max(
    1,
    Math.floor(totalCpuCount * DEFAULT_CPU_MAX_PERIOD_US * DEFAULT_EXECUTION_BUDGET_RATIO)
  );

  return {
    memoryMaxBytes: Math.max(1, Math.floor(executionMemoryBudgetBytes / sessionCount)),
    cpuMax: `${Math.max(1, Math.floor(executionCpuBudgetMicros / sessionCount))} ${DEFAULT_CPU_MAX_PERIOD_US}`,
    pidsMax: DEFAULT_SESSION_PIDS_MAX,
  };
}

type ProcessEvents = Pick<
  SessionProcessHandle,
  'onExit' | 'onClose' | 'onError' | 'onStdout' | 'onStderr'
>;

/**
 * Buffer lifecycle events and (optionally) stdio from the instant of spawn.
 *
 * The container does async post-spawn work (resource profile, cgroup
 * attachment), so events can fire before callers finish awaiting the handle.
 * Exit/close/error replay to late subscribers. Stdio has the same problem with
 * a worse failure mode: a stream destroyed on child exit drops its buffered
 * data, so a late `on('data')` subscriber reads an empty result that is
 * indistinguishable from a command that printed nothing. `captureOutput`
 * starts reading now and replays on subscribe.
 */
function attachProcessEvents(
  child: ChildProcess,
  options: { captureOutput?: boolean; logger?: Logger }
): ProcessEvents {
  let exitEvent: [number | null, NodeJS.Signals | null] | null = null;
  let closeEvent: [number | null, NodeJS.Signals | null] | null = null;
  let errorEvent: [Error] | null = null;

  const exitListeners = new Set<ProcessExitListener>();
  const closeListeners = new Set<ProcessExitListener>();
  const errorListeners = new Set<ProcessErrorListener>();

  child.once('exit', (exitCode, signal) => {
    exitEvent = [exitCode, signal];
    for (const listener of Array.from(exitListeners)) {
      listener(exitCode, signal);
    }
  });

  child.once('close', (exitCode, signal) => {
    closeEvent = [exitCode, signal];
    for (const listener of Array.from(closeListeners)) {
      listener(exitCode, signal);
    }
  });

  child.once('error', (error) => {
    errorEvent = [error];
    for (const listener of Array.from(errorListeners)) {
      listener(error);
    }
  });

  const reportOverflow = (streamName: 'stdout' | 'stderr') => (droppedBytes: number) => {
    options.logger?.debug(
      `Dropped ${droppedBytes} bytes of buffered ${streamName} before the reader attached (cap ${MAX_BRIDGE_CAPTURE_BYTES} bytes)`
    );
  };
  const capture = options.captureOutput === true;

  return {
    onExit: (listener) => subscribeBufferedProcessEvent(exitListeners, listener, exitEvent),
    onClose: (listener) => subscribeBufferedProcessEvent(closeListeners, listener, closeEvent),
    onError: (listener) => subscribeBufferedProcessEvent(errorListeners, listener, errorEvent),
    onStdout: createProcessOutputChannel(child.stdout, capture, reportOverflow('stdout')),
    onStderr: createProcessOutputChannel(child.stderr, capture, reportOverflow('stderr')),
  };
}

/**
 * Build a subscribe function for one child stdio stream.
 *
 * When `capture` is set, data is read immediately and held until the first
 * subscriber arrives, which replays it synchronously and then receives the rest
 * live. Without it, subscribing is a plain `on('data')` and output produced
 * before the subscription is lost.
 *
 * The bridge buffer is capped. Consumers apply their own output limits only
 * once they subscribe (terminals retain 1 MiB), so an unbounded buffer would
 * let a noisy command grow the daemon's heap for the whole spawn window. On
 * overflow the OLDEST chunks go first, matching the terminal's own
 * keep-the-tail truncation.
 */
function createProcessOutputChannel(
  stream: NodeJS.ReadableStream | null,
  capture: boolean,
  onOverflow?: (droppedBytes: number) => void
): (listener: ProcessOutputListener) => () => void {
  if (!stream) {
    return () => () => {};
  }

  if (!capture) {
    return (listener) => {
      stream.on('data', listener);
      return () => {
        stream.off('data', listener);
      };
    };
  }

  let buffered: Buffer[] | null = [];
  let bufferedBytes = 0;
  let droppedBytes = 0;
  const listeners = new Set<ProcessOutputListener>();

  stream.on('data', (chunk: Buffer) => {
    if (buffered) {
      buffered.push(chunk);
      bufferedBytes += chunk.length;
      // Keep the newest chunk even when it alone exceeds the cap.
      while (bufferedBytes > MAX_BRIDGE_CAPTURE_BYTES && buffered.length > 1) {
        const evicted = buffered.shift();
        if (!evicted) {
          break;
        }
        bufferedBytes -= evicted.length;
        droppedBytes += evicted.length;
      }
      return;
    }
    for (const listener of Array.from(listeners)) {
      listener(chunk);
    }
  });

  return (listener) => {
    listeners.add(listener);
    const replay = buffered;
    // Stop buffering once someone is listening; later subscribers join live.
    buffered = null;
    if (replay) {
      for (const chunk of replay) {
        listener(chunk);
      }
    }
    if (droppedBytes > 0) {
      onOverflow?.(droppedBytes);
      droppedBytes = 0;
    }
    return () => {
      listeners.delete(listener);
    };
  };
}

function subscribeBufferedProcessEvent<TArgs extends unknown[]>(
  listeners: Set<(...args: TArgs) => void>,
  listener: (...args: TArgs) => void,
  bufferedArgs: TArgs | null
): () => void {
  if (bufferedArgs) {
    let active = true;
    setImmediate(() => {
      if (active) {
        listener(...bufferedArgs);
      }
    });
    return () => {
      active = false;
    };
  }

  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
