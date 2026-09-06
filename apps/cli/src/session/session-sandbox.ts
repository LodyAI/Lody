import { ChildProcess, type SpawnOptions } from 'child_process';
import * as fs from 'fs/promises';
import path from 'path';

import spawn from 'cross-spawn';
import { type SessionId } from '@lody/shared';

import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { applyExecutionProcessResourceProfile } from '@/utils/process-resource-profile';
import { terminateWindowsChildProcess } from '@/utils/windows-child-process';

const DEFAULT_CGROUP_MOUNT = '/sys/fs/cgroup';
const DEFAULT_SESSION_PARENT = 'lody-sessions';
const CGROUP_CLEANUP_RETRIES = 10;
const CGROUP_CLEANUP_RETRY_MS = 100;
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

type EventCounters = Record<string, number>;

type ExecSandboxFs = Pick<typeof fs, 'access' | 'mkdir' | 'readFile' | 'writeFile' | 'rmdir'>;

export interface SessionSandboxLimits {
  memoryMaxBytes?: number;
  memoryHighBytes?: number;
  cpuMax?: string;
  pidsMax?: number;
}

export interface MachineCapacitySnapshot {
  totalMemoryBytes: number;
  totalCpuCount: number;
}

export interface SessionResourceLimitViolation {
  kind: 'memory' | 'pids';
  message: string;
}

export type SessionResourceAccounting =
  | {
      kind: 'cgroup-v2';
      memoryBytes: number;
      cpuTimeMicros: number;
      processCount: number;
      memoryLimitBytes: number | null;
      cpuLimitCores: number | null;
      pidsLimit: number | null;
    }
  | {
      kind: 'process-tree';
      rootPids: number[];
      memoryLimitBytes: number | null;
      cpuLimitCores: number | null;
      pidsLimit: number | null;
    }
  | {
      kind: 'unavailable';
      reason: string;
    };

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
   * spawn() does async post-spawn work (pid wait, resource profile, cgroup
   * attachment), so a short-lived child can exit and have its stdio streams
   * destroyed — discarding whatever they had buffered — before the caller ever
   * gets the handle. Set this for commands whose output is the result.
   */
  captureOutput?: boolean;
}

export interface SessionProcessHandle {
  child: ChildProcess;
  inspectExit: (
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ) => Promise<SessionResourceLimitViolation | null>;
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
  terminate(force?: boolean): Promise<void>;
  cleanup(): Promise<void>;
}

export type SessionSandboxFactory = (sessionId: SessionId) => Promise<SessionSandbox>;

interface SessionSandboxDeps {
  platform: NodeJS.Platform;
  cgroupMount: string;
  fs: ExecSandboxFs;
  spawnProcess: typeof spawn;
  readSelfCgroupPath: () => Promise<string>;
  configureExecutionProcess: (pid: number, logger?: Logger) => Promise<void>;
  killPid: (pid: number, signal?: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
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
  sleep: async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
});

export function createSessionSandboxFactory(
  options: CreateSessionSandboxFactoryOptions
): SessionSandboxFactory {
  const deps: SessionSandboxDeps = {
    ...defaultSandboxDeps(),
    ...(options.deps ?? {}),
  };
  let warnedUnsupportedPlatform = false;

  return async (sessionId: SessionId): Promise<SessionSandbox> => {
    if (deps.platform !== 'linux') {
      if (!warnedUnsupportedPlatform) {
        warnedUnsupportedPlatform = true;
        options.logger.debug(
          `[ExecSandbox] Native execution sandbox is enabled by default, but hard resource limits are only supported on Linux (current platform=${deps.platform})`
        );
      }
      return new NoopSessionSandbox(
        {
          platform: deps.platform,
          spawnProcess: deps.spawnProcess,
          configureExecutionProcess: deps.configureExecutionProcess,
          killPid: deps.killPid,
        },
        options.logger,
        `unsupported-platform:${deps.platform}`
      );
    }

    const sandbox = new LinuxCgroupSessionSandbox(sessionId, options.logger, deps);
    try {
      await sandbox.initialize();
      return sandbox;
    } catch (error) {
      options.logger.debug(
        `[${sessionId}] Execution sandbox unavailable; continuing without hard resource limits: ${formatErrorMessage(
          error
        )}`
      );
      return new NoopSessionSandbox(
        {
          platform: deps.platform,
          spawnProcess: deps.spawnProcess,
          configureExecutionProcess: deps.configureExecutionProcess,
          killPid: deps.killPid,
        },
        options.logger,
        'cgroup-init-failed'
      );
    }
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
  return new NoopSessionSandbox(
    {
      platform: process.platform,
      spawnProcess,
      configureExecutionProcess: async (pid: number, logger?: Logger) => {
        await applyExecutionProcessResourceProfile(pid, logger);
      },
      killPid: (pid, signal) => {
        process.kill(pid, signal);
      },
    },
    undefined,
    description
  );
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

class NoopSessionSandbox implements SessionSandbox {
  readonly enabled = false;
  private readonly trackedProcesses = new Map<number, { child: ChildProcess; detached: boolean }>();

  constructor(
    private readonly deps: Pick<
      SessionSandboxDeps,
      'platform' | 'spawnProcess' | 'configureExecutionProcess' | 'killPid'
    >,
    private readonly logger: Logger | undefined,
    readonly description: string
  ) {}

  async applyLimits(_limits: SessionSandboxLimits): Promise<void> {}

  async readResourceAccounting(): Promise<SessionResourceAccounting> {
    return {
      kind: 'process-tree',
      rootPids: Array.from(this.trackedProcesses.keys()),
      memoryLimitBytes: null,
      cpuLimitCores: null,
      pidsLimit: null,
    };
  }

  async spawn(
    command: string,
    args: string[],
    options: SessionSpawnOptions
  ): Promise<SessionProcessHandle> {
    // On POSIX fallback, spawn each process in its own group so terminate() can
    // signal the whole subtree even without cgroup support.
    const detached = this.deps.platform !== 'win32';
    const { captureOutput, ...spawnOptions } = options;
    const child = this.deps.spawnProcess(command, args, {
      // The daemon runs without a console on Windows; without CREATE_NO_WINDOW
      // every console-subsystem child (git, node, agent CLIs) pops a visible
      // console window and steals focus.
      windowsHide: true,
      ...spawnOptions,
      detached,
    });
    const processHandle = createBufferedSessionProcessHandle(
      child,
      async () => null,
      async (force) => {
        if (this.deps.platform === 'win32' || (typeof child.pid === 'number' && child.pid > 0)) {
          await this.terminateProcessTree(child, force, detached);
          return;
        }
        await terminateChildProcessDirectly(child, force);
      },
      { captureOutput, logger: this.logger }
    );
    if (typeof child.pid === 'number' && child.pid > 0) {
      this.trackedProcesses.set(child.pid, { child, detached });
      const trackedPid = child.pid;
      const cleanupTrackedProcess = () => {
        this.trackedProcesses.delete(trackedPid);
      };
      child.once('exit', cleanupTrackedProcess);
      child.once('close', cleanupTrackedProcess);
      // A kill error is retryable; only observed process exit releases ownership.
      await configureExecutionProcessBestEffort(child.pid, this.deps, this.logger);
    }
    return processHandle;
  }

  async terminate(force: boolean = false): Promise<void> {
    const failures: unknown[] = [];
    for (const { child, detached } of this.trackedProcesses.values()) {
      try {
        await this.terminateProcessTree(child, force, detached);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Session process tree termination failed');
  }

  async cleanup(): Promise<void> {
    this.trackedProcesses.clear();
  }

  private async terminateProcessTree(
    child: ChildProcess,
    force: boolean,
    detached: boolean
  ): Promise<void> {
    if (this.deps.platform === 'win32') {
      await terminateWindowsChildProcess(child, force);
      return;
    }

    const pid = child.pid;
    if (pid === undefined) return;
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    const targetPid = detached ? -pid : pid;
    try {
      this.deps.killPid(targetPid, signal);
    } catch (error) {
      if (isMissingProcessError(error)) {
        return;
      }
      throw error;
    }
  }
}

class LinuxCgroupSessionSandbox implements SessionSandbox {
  readonly enabled = true;
  readonly description = 'linux-cgroup-v2';

  private cgroupDir: string | null = null;
  private limits: SessionSandboxLimits = {};

  constructor(
    private readonly sessionId: SessionId,
    private readonly logger: Logger,
    private readonly deps: SessionSandboxDeps
  ) {}

  async initialize(): Promise<void> {
    const cgroupMountPath = path.join(this.deps.cgroupMount, 'cgroup.controllers');
    if (!(await this.pathExists(cgroupMountPath))) {
      throw new Error(`cgroup v2 mount not available at ${this.deps.cgroupMount}`);
    }

    const selfCgroupPath = await this.deps.readSelfCgroupPath();
    const parentDir = path.join(
      this.deps.cgroupMount,
      trimLeadingSlash(selfCgroupPath),
      DEFAULT_SESSION_PARENT
    );
    const cgroupDir = path.join(parentDir, `lody-session-${sanitizePathSegment(this.sessionId)}`);

    await this.deps.fs.mkdir(parentDir, { recursive: true });
    await this.deps.fs.mkdir(cgroupDir, { recursive: true });

    this.cgroupDir = cgroupDir;

    await this.ensureRequiredFilesExist();
    await this.ensureOomGroupEnabled();
  }

  async applyLimits(limits: SessionSandboxLimits): Promise<void> {
    const cgroupDir = this.requireCgroupDir();
    this.limits = normalizeSessionSandboxLimits(limits);

    // Limits are reapplied whenever SessionManager rebalances active sessions, so each
    // session cgroup always reflects the current share of the machine-wide execution
    // budget. See docs/exec-sandbox.md.
    await this.deps.fs.writeFile(
      path.join(cgroupDir, 'memory.max'),
      formatMemoryLimit(this.limits.memoryMaxBytes)
    );
    if (await this.pathExists(path.join(cgroupDir, 'memory.high'))) {
      await this.deps.fs.writeFile(
        path.join(cgroupDir, 'memory.high'),
        formatMemoryLimit(this.limits.memoryHighBytes)
      );
    }
    await this.deps.fs.writeFile(
      path.join(cgroupDir, 'cpu.max'),
      formatCpuLimit(this.limits.cpuMax)
    );
    await this.deps.fs.writeFile(
      path.join(cgroupDir, 'pids.max'),
      formatPidsLimit(this.limits.pidsMax)
    );
  }

  async readResourceAccounting(): Promise<SessionResourceAccounting> {
    const cgroupDir = this.requireCgroupDir();
    const [memoryCurrent, cpuStat, pidsCurrent] = await Promise.all([
      this.readRequiredNumber(path.join(cgroupDir, 'memory.current')),
      this.deps.fs.readFile(path.join(cgroupDir, 'cpu.stat'), 'utf8'),
      this.readRequiredNumber(path.join(cgroupDir, 'pids.current')),
    ]);
    const cpuCounters = parseEventCounters(String(cpuStat));
    const cpuTimeMicros = cpuCounters.usage_usec;
    if (cpuTimeMicros === undefined) {
      throw new Error('cpu.stat does not contain usage_usec');
    }
    return {
      kind: 'cgroup-v2',
      memoryBytes: memoryCurrent,
      cpuTimeMicros,
      processCount: pidsCurrent,
      memoryLimitBytes: this.limits.memoryMaxBytes ?? null,
      cpuLimitCores: parseCpuLimitCores(this.limits.cpuMax),
      pidsLimit: this.limits.pidsMax ?? null,
    };
  }

  async spawn(
    command: string,
    args: string[],
    options: SessionSpawnOptions
  ): Promise<SessionProcessHandle> {
    const cgroupDir = this.requireCgroupDir();
    const baseline = await this.captureLimitEvents();
    const limitsAtSpawn = { ...this.limits };
    const { captureOutput, ...spawnOptions } = options;
    const child = this.deps.spawnProcess(command, args, spawnOptions);
    const processHandle = createBufferedSessionProcessHandle(
      child,
      async (exitCode, signal) => {
        return await this.detectLimitViolation(baseline, exitCode, signal, limitsAtSpawn);
      },
      undefined,
      { captureOutput, logger: this.logger }
    );

    try {
      const pid = await waitForChildPid(child);
      await configureExecutionProcessBestEffort(pid, this.deps, this.logger, this.sessionId);
      await this.deps.fs.writeFile(path.join(cgroupDir, 'cgroup.procs'), `${pid}\n`);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : null;
      if (code === 'ESRCH') {
        return processHandle;
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore best-effort cleanup
      }
      throw error;
    }

    return processHandle;
  }

  async terminate(force: boolean = false): Promise<void> {
    const cgroupDir = this.cgroupDir;
    if (!cgroupDir) {
      return;
    }

    if (force && (await this.pathExists(path.join(cgroupDir, 'cgroup.kill')))) {
      await this.deps.fs.writeFile(path.join(cgroupDir, 'cgroup.kill'), '1\n');
      return;
    }

    const signal = force ? 'SIGKILL' : 'SIGTERM';
    const pids = await this.readPids();
    for (const pid of pids) {
      try {
        this.deps.killPid(pid, signal);
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code)
            : null;
        if (code === 'ESRCH') {
          continue;
        }
        throw error;
      }
    }
  }

  async cleanup(): Promise<void> {
    const cgroupDir = this.cgroupDir;
    if (!cgroupDir) {
      return;
    }

    for (let attempt = 0; attempt < CGROUP_CLEANUP_RETRIES; attempt += 1) {
      const pids = await this.readPids();
      if (pids.length === 0) {
        break;
      }
      await this.deps.sleep(CGROUP_CLEANUP_RETRY_MS);
    }

    try {
      await this.deps.fs.rmdir(cgroupDir);
      this.cgroupDir = null;
    } catch (error) {
      this.logger.debug(
        `[${this.sessionId}] Failed to remove session cgroup ${cgroupDir}: ${formatErrorMessage(
          error
        )}`
      );
    }
  }

  private async ensureRequiredFilesExist(): Promise<void> {
    const cgroupDir = this.requireCgroupDir();
    const requiredFiles = [
      path.join(cgroupDir, 'cgroup.procs'),
      path.join(cgroupDir, 'memory.events'),
      path.join(cgroupDir, 'memory.max'),
      path.join(cgroupDir, 'cpu.max'),
      path.join(cgroupDir, 'pids.max'),
      path.join(cgroupDir, 'pids.events'),
    ];

    const results = await Promise.all(requiredFiles.map((file) => this.pathExists(file)));
    for (let i = 0; i < requiredFiles.length; i++) {
      if (!results[i]) {
        throw new Error(
          `required controller file is unavailable in delegated cgroup subtree: ${path.basename(requiredFiles[i]!)}`
        );
      }
    }
  }

  private async ensureOomGroupEnabled(): Promise<void> {
    const cgroupDir = this.requireCgroupDir();
    if (await this.pathExists(path.join(cgroupDir, 'memory.oom.group'))) {
      await this.deps.fs.writeFile(path.join(cgroupDir, 'memory.oom.group'), '1\n');
    }
  }

  private async captureLimitEvents(): Promise<{ memory: EventCounters; pids: EventCounters }> {
    const [memory, pids] = await Promise.all([
      this.readEventFile('memory.events'),
      this.readEventFile('pids.events'),
    ]);
    return { memory, pids };
  }

  private async detectLimitViolation(
    baseline: { memory: EventCounters; pids: EventCounters },
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    limitsAtSpawn: SessionSandboxLimits
  ): Promise<SessionResourceLimitViolation | null> {
    const [memoryEvents, pidsEvents] = await Promise.all([
      this.readEventFile('memory.events'),
      this.readEventFile('pids.events'),
    ]);

    const oomKillDelta =
      diffCounter(memoryEvents, baseline.memory, 'oom_kill') +
      diffCounter(memoryEvents, baseline.memory, 'oom_group_kill');
    if (oomKillDelta > 0) {
      const memoryText =
        limitsAtSpawn.memoryMaxBytes === undefined
          ? 'the configured session memory limit'
          : `memory.max (${formatBytes(limitsAtSpawn.memoryMaxBytes)})`;
      return {
        kind: 'memory',
        message: `Session exceeded ${memoryText} and was killed by the kernel`,
      };
    }

    const memoryMaxDelta = diffCounter(memoryEvents, baseline.memory, 'max');
    if (memoryMaxDelta > 0 && (signal === 'SIGKILL' || exitCode === 137)) {
      const memoryText =
        limitsAtSpawn.memoryMaxBytes === undefined
          ? 'the configured session memory limit'
          : `memory.max (${formatBytes(limitsAtSpawn.memoryMaxBytes)})`;
      return {
        kind: 'memory',
        message: `Session hit ${memoryText} and exited under memory pressure`,
      };
    }

    const pidsMaxDelta = diffCounter(pidsEvents, baseline.pids, 'max');
    if (pidsMaxDelta > 0 && exitCode !== 0) {
      const pidsText =
        limitsAtSpawn.pidsMax === undefined
          ? 'the configured process limit'
          : `pids.max (${limitsAtSpawn.pidsMax})`;
      return {
        kind: 'pids',
        message: `Session exceeded ${pidsText} and could not spawn additional processes`,
      };
    }

    return null;
  }

  private async readPids(): Promise<number[]> {
    const cgroupDir = this.cgroupDir;
    if (!cgroupDir) {
      return [];
    }
    let content: string;
    try {
      content = (await this.deps.fs.readFile(
        path.join(cgroupDir, 'cgroup.procs'),
        'utf8'
      )) as string;
    } catch {
      return [];
    }
    return Array.from(
      new Set(
        content
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => parseInt(line, 10))
          .filter((pid) => Number.isInteger(pid) && pid > 0)
      )
    );
  }

  private async readRequiredNumber(filePath: string): Promise<number> {
    const raw = String(await this.deps.fs.readFile(filePath, 'utf8')).trim();
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid non-negative number in ${path.basename(filePath)}`);
    }
    return value;
  }

  private async readEventFile(fileName: string): Promise<EventCounters> {
    const cgroupDir = this.cgroupDir;
    if (!cgroupDir) {
      return {};
    }
    let content: string;
    try {
      content = (await this.deps.fs.readFile(path.join(cgroupDir, fileName), 'utf8')) as string;
    } catch {
      return {};
    }
    return parseEventCounters(content);
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await this.deps.fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private requireCgroupDir(): string {
    if (!this.cgroupDir) {
      throw new Error('Session sandbox is not initialized');
    }
    return this.cgroupDir;
  }
}

async function configureExecutionProcessBestEffort(
  pid: number,
  deps: Pick<SessionSandboxDeps, 'configureExecutionProcess'>,
  logger?: Logger,
  sessionId?: SessionId
): Promise<void> {
  try {
    await deps.configureExecutionProcess(pid, logger);
  } catch (error) {
    const prefix = sessionId ? `[${sessionId}] ` : '';
    logger?.debug(
      `${prefix}Failed to apply execution-plane process resource profile to pid ${pid}: ${formatErrorMessage(
        error
      )}`
    );
  }
}

function parseEventCounters(content: string): EventCounters {
  const counters: EventCounters = {};
  for (const line of content.split('\n')) {
    const [name, rawValue] = line.trim().split(/\s+/, 2);
    if (!name || !rawValue) {
      continue;
    }
    const value = Number.parseInt(rawValue, 10);
    if (Number.isFinite(value)) {
      counters[name] = value;
    }
  }
  return counters;
}

function createBufferedSessionProcessHandle(
  child: ChildProcess,
  inspectExit: SessionProcessHandle['inspectExit'],
  terminate: SessionProcessHandle['terminate'] = async (force) => {
    await terminateChildProcessDirectly(child, force);
  },
  options: { captureOutput?: boolean; logger?: Logger } = {}
): SessionProcessHandle {
  // sandbox.spawn() may need async post-spawn work (for example cgroup attachment),
  // so process lifecycle events can fire before callers finish awaiting the handle.
  // Buffer and replay exit/close/error so late subscribers still observe them.
  // Stdio has the same problem with a worse failure mode: a stream destroyed on
  // child exit drops its buffered data, so a late `on('data')` subscriber reads
  // an empty result that is indistinguishable from a command that printed
  // nothing. `captureOutput` starts reading now and replays on subscribe.
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
  const stdout = createProcessOutputChannel(child.stdout, capture, reportOverflow('stdout'));
  const stderr = createProcessOutputChannel(child.stderr, capture, reportOverflow('stderr'));

  return {
    child,
    inspectExit,
    terminate,
    onExit: (listener) => subscribeBufferedProcessEvent(exitListeners, listener, exitEvent),
    onClose: (listener) => subscribeBufferedProcessEvent(closeListeners, listener, closeEvent),
    onError: (listener) => subscribeBufferedProcessEvent(errorListeners, listener, errorEvent),
    onStdout: stdout,
    onStderr: stderr,
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

async function terminateChildProcessDirectly(child: ChildProcess, force: boolean): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if (isMissingProcessError(error)) {
      return;
    }
    throw error;
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

function diffCounter(after: EventCounters, before: EventCounters, key: string): number {
  return Math.max(0, (after[key] ?? 0) - (before[key] ?? 0));
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function formatBytes(bytes: number): string {
  const gib = 1024 * 1024 * 1024;
  if (bytes % gib === 0) {
    return `${bytes / gib} GiB`;
  }
  return `${Math.round((bytes / MIB) * 10) / 10} MiB`;
}

function normalizeSessionSandboxLimits(limits: SessionSandboxLimits): SessionSandboxLimits {
  const memoryMaxBytes = normalizePositiveInteger(limits.memoryMaxBytes);
  const cpuMax = normalizeCpuMax(limits.cpuMax);
  const pidsMax = normalizePositiveInteger(limits.pidsMax);

  let memoryHighBytes = normalizePositiveInteger(limits.memoryHighBytes);
  if (
    memoryMaxBytes !== undefined &&
    memoryHighBytes !== undefined &&
    memoryHighBytes > memoryMaxBytes
  ) {
    memoryHighBytes = memoryMaxBytes;
  }

  return {
    memoryMaxBytes,
    memoryHighBytes,
    cpuMax,
    pidsMax,
  };
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeCpuMax(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) {
    return undefined;
  }
  const quota = parts[0];
  const period = parts[1];
  if (!quota || !period || !/^\d+$/.test(period)) {
    return undefined;
  }
  if (quota !== 'max' && !/^\d+$/.test(quota)) {
    return undefined;
  }
  if (Number.parseInt(period, 10) <= 0) {
    return undefined;
  }
  if (quota !== 'max' && Number.parseInt(quota, 10) <= 0) {
    return undefined;
  }
  return `${quota} ${period}`;
}

function parseCpuLimitCores(value: string | undefined): number | null {
  const normalized = normalizeCpuMax(value);
  if (!normalized) return null;
  const [quotaText, periodText] = normalized.split(/\s+/, 2);
  if (!quotaText || !periodText || quotaText === 'max') return null;
  const quota = Number(quotaText);
  const period = Number(periodText);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return null;
  return quota / period;
}

function formatMemoryLimit(value: number | undefined): string {
  return value === undefined ? 'max\n' : `${value}\n`;
}

function formatCpuLimit(value: string | undefined): string {
  return value === undefined ? `max ${DEFAULT_CPU_MAX_PERIOD_US}\n` : `${value}\n`;
}

function formatPidsLimit(value: number | undefined): string {
  return value === undefined ? 'max\n' : `${value}\n`;
}

async function waitForChildPid(child: ChildProcess): Promise<number> {
  if (typeof child.pid === 'number' && child.pid > 0) {
    return child.pid;
  }

  await new Promise<void>((resolve, reject) => {
    const handleSpawn = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('spawn', handleSpawn);
      child.off('error', handleError);
    };

    child.once('spawn', handleSpawn);
    child.once('error', handleError);
  });

  if (typeof child.pid !== 'number' || child.pid <= 0) {
    throw new Error('Spawned process PID is unavailable');
  }
  return child.pid;
}
