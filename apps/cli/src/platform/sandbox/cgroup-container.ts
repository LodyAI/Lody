import type * as fs from 'node:fs/promises';
import path from 'node:path';

import { Duration, Effect, Ref, Scope, Exit } from 'effect';
import { ChildProcessSpawner } from 'effect/process';

import { formatErrorMessage } from '@/utils/format-error';

import { SpawnFailed, TerminationFailed } from '@lody/shared/node/process';
import { spawnProcess, type ProcessExit } from '@lody/shared/node/process';
import { errnoCode, NodeProcess, type NodeProcessApi } from '@lody/shared/node/process';
import {
  terminateTree,
  waitUntilGone,
  type ProcessTree,
  type TreeSignal,
} from '@lody/shared/node/process';
import {
  FORCED_TERMINATION,
  SandboxIoError,
  SandboxUnavailable,
  type ProcessContainer,
  type SessionResourceAccounting,
  type SessionResourceLimitViolation,
  type SessionSandboxLimits,
} from './types';

export type CgroupFs = Pick<typeof fs, 'access' | 'mkdir' | 'readFile' | 'writeFile' | 'rmdir'>;

const SESSION_CGROUP_PARENT = 'lody-sessions';
const DEFAULT_CPU_MAX_PERIOD_US = 100_000;
const MIB = 1024 * 1024;
/** How long cleanup waits for the cgroup to empty before removing it anyway. */
const CLEANUP_DRAIN_WAIT = Duration.seconds(1);

type EventCounters = Record<string, number>;

/**
 * A container backed by a delegated cgroup v2 subtree: hard memory/CPU/pid
 * limits, kernel accounting, and `cgroup.kill` to end every member at once,
 * including daemonized descendants that left their process group.
 */
export const makeCgroupContainer = (options: {
  readonly sessionId: string;
  readonly cgroupMount: string;
  readonly fs: CgroupFs;
  readonly readSelfCgroupPath: () => Promise<string>;
  readonly configureProcess: (pid: number) => Effect.Effect<void>;
}): Effect.Effect<
  ProcessContainer,
  SandboxUnavailable,
  NodeProcess | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const np = yield* NodeProcess;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Effect.scope;
    const io = <A>(operation: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          new SandboxIoError({
            operation,
            message: `cgroup ${operation} failed: ${formatErrorMessage(cause)}`,
            cause,
          }),
      });
    const exists = (filePath: string) =>
      io(`access ${path.basename(filePath)}`, () => options.fs.access(filePath)).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      );

    const cgroupDir = yield* initializeCgroup(options, io, exists).pipe(
      Effect.mapError((cause) => new SandboxUnavailable({ message: cause.message, cause }))
    );
    const currentDir = yield* Ref.make<string | null>(cgroupDir);
    const limits = yield* Ref.make<SessionSandboxLimits>({});

    const requireDir = Effect.flatMap(Ref.get(currentDir), (dir) =>
      dir
        ? Effect.succeed(dir)
        : Effect.fail(
            new SandboxIoError({
              operation: 'lookup',
              message: 'Session sandbox is not initialized',
              cause: null,
            })
          )
    );
    const readText = (fileName: string) =>
      Effect.flatMap(requireDir, (dir) =>
        io(`read ${fileName}`, async () =>
          String(await options.fs.readFile(path.join(dir, fileName), 'utf8'))
        )
      );
    const readEvents = (fileName: string) =>
      readText(fileName).pipe(
        Effect.map(parseEventCounters),
        Effect.catch(() => Effect.succeed<EventCounters>({}))
      );
    const readPids = readText('cgroup.procs').pipe(
      Effect.map(parsePids),
      Effect.catch(() => Effect.succeed<number[]>([]))
    );
    // `populated` covers nested cgroups too, whose members cgroup.procs omits.
    const readPopulated = Effect.map(
      readEvents('cgroup.events'),
      (events) => (events.populated ?? 0) > 0
    );
    const tree = cgroupTree(np, cgroupDir, readPids, readPopulated, exists, (value) =>
      io('write cgroup.kill', () =>
        options.fs.writeFile(path.join(cgroupDir, 'cgroup.kill'), value)
      )
    );

    const container: ProcessContainer = {
      enabled: true,
      description: 'linux-cgroup-v2',
      spawn: (spec) =>
        Effect.suspend(() =>
          scope.state._tag === 'Closed'
            ? Effect.fail(
                new SpawnFailed({
                  command: spec.command,
                  message: 'Session sandbox is not initialized',
                  cause: null,
                })
              )
            : Effect.acquireUseRelease(
                Scope.fork(scope),
                (childScope) =>
                  Scope.provide(
                    Effect.gen(function* () {
                      // After cleanup removed the cgroup, a spawn would run outside every limit.
                      yield* requireDir.pipe(
                        Effect.mapError(
                          (error) =>
                            new SpawnFailed({
                              command: spec.command,
                              message: error.message,
                              cause: error,
                            })
                        )
                      );
                      const baseline = {
                        memory: yield* readEvents('memory.events'),
                        pids: yield* readEvents('pids.events'),
                      };
                      const limitsAtSpawn = yield* Ref.get(limits);
                      const managed = yield* spawnProcess({ ...spec, processGroup: true }).pipe(
                        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
                      );
                      const attached = yield* managed.started.pipe(
                        Effect.tap((pid) => options.configureProcess(pid)),
                        Effect.flatMap((pid) =>
                          io('attach process', () =>
                            options.fs.writeFile(path.join(cgroupDir, 'cgroup.procs'), `${pid}\n`)
                          )
                        ),
                        Effect.result
                      );
                      if (attached._tag === 'Failure') {
                        const cause =
                          attached.failure instanceof SandboxIoError ||
                          attached.failure instanceof SpawnFailed
                            ? attached.failure.cause
                            : attached.failure;
                        // The child exited before it could join; nothing escaped the limits.
                        if (errnoCode(cause) !== 'ESRCH') {
                          // It may already have started children outside the limits: end the tree.
                          yield* managed.terminate(FORCED_TERMINATION).pipe(Effect.ignore);
                          return yield* Effect.fail(
                            new SpawnFailed({
                              command: spec.command,
                              message: `Failed to start ${spec.command} in the session sandbox: ${formatErrorMessage(cause)}`,
                              cause,
                            })
                          );
                        }
                      }
                      return {
                        ...managed,
                        inspectExit: (exit: ProcessExit) =>
                          Effect.gen(function* () {
                            const memory = yield* readEvents('memory.events');
                            const pids = yield* readEvents('pids.events');
                            return detectLimitViolation(
                              baseline,
                              { memory, pids },
                              exit,
                              limitsAtSpawn
                            );
                          }),
                      };
                    }),
                    childScope
                  ),
                (childScope, exit) =>
                  Exit.isFailure(exit) ? Scope.close(childScope, exit) : Effect.void
              )
        ),
      terminateAll: (policy) => terminateTree(tree, policy),
      applyLimits: (next) =>
        Effect.gen(function* () {
          const dir = yield* requireDir;
          const normalized = normalizeSessionSandboxLimits(next);
          yield* Ref.set(limits, normalized);
          // Rewritten whenever SessionManager rebalances active sessions, so each
          // cgroup reflects its current share of the machine's execution budget.
          yield* io('write memory.max', () =>
            options.fs.writeFile(
              path.join(dir, 'memory.max'),
              formatMemoryLimit(normalized.memoryMaxBytes)
            )
          );
          if (yield* exists(path.join(dir, 'memory.high'))) {
            yield* io('write memory.high', () =>
              options.fs.writeFile(
                path.join(dir, 'memory.high'),
                formatMemoryLimit(normalized.memoryHighBytes)
              )
            );
          }
          yield* io('write cpu.max', () =>
            options.fs.writeFile(path.join(dir, 'cpu.max'), formatCpuLimit(normalized.cpuMax))
          );
          yield* io('write pids.max', () =>
            options.fs.writeFile(path.join(dir, 'pids.max'), formatPidsLimit(normalized.pidsMax))
          );
        }),
      readAccounting: Effect.gen(function* () {
        const memoryBytes = yield* Effect.flatMap(readText('memory.current'), (raw) =>
          parseNonNegative('memory.current', raw)
        );
        const cpuCounters = parseEventCounters(yield* readText('cpu.stat'));
        const processCount = yield* Effect.flatMap(readText('pids.current'), (raw) =>
          parseNonNegative('pids.current', raw)
        );
        const cpuTimeMicros = cpuCounters.usage_usec;
        if (cpuTimeMicros === undefined) {
          return yield* Effect.fail(
            new SandboxIoError({
              operation: 'read cpu.stat',
              message: 'cpu.stat does not contain usage_usec',
              cause: null,
            })
          );
        }
        const current = yield* Ref.get(limits);
        return {
          kind: 'cgroup-v2',
          memoryBytes,
          cpuTimeMicros,
          processCount,
          memoryLimitBytes: current.memoryMaxBytes ?? null,
          cpuLimitCores: parseCpuLimitCores(current.cpuMax),
          pidsLimit: current.pidsMax ?? null,
        } satisfies SessionResourceAccounting;
      }),
      cleanup: Effect.gen(function* () {
        yield* container
          .terminateAll(FORCED_TERMINATION)
          .pipe(Effect.catch((error) => Effect.logWarning(error.message)));
        const dir = yield* Ref.get(currentDir);
        if (!dir) return;
        yield* waitUntilGone(tree, CLEANUP_DRAIN_WAIT).pipe(Effect.ignore);
        const removed = yield* io('remove cgroup', () => options.fs.rmdir(dir)).pipe(Effect.result);
        if (removed._tag === 'Success') {
          yield* Ref.set(currentDir, null);
        } else {
          yield* Effect.logDebug(
            `[${options.sessionId}] Failed to remove session cgroup ${dir}: ${removed.failure.message}`
          );
        }
      }),
    };
    yield* Effect.addFinalizer(() => container.cleanup);
    return container;
  });

const initializeCgroup = (
  options: {
    readonly sessionId: string;
    readonly cgroupMount: string;
    readonly fs: CgroupFs;
    readonly readSelfCgroupPath: () => Promise<string>;
  },
  io: <A>(operation: string, run: () => Promise<A>) => Effect.Effect<A, SandboxIoError>,
  exists: (filePath: string) => Effect.Effect<boolean>
): Effect.Effect<string, SandboxIoError> =>
  Effect.gen(function* () {
    if (!(yield* exists(path.join(options.cgroupMount, 'cgroup.controllers')))) {
      return yield* Effect.fail(
        new SandboxIoError({
          operation: 'probe',
          message: `cgroup v2 mount not available at ${options.cgroupMount}`,
          cause: null,
        })
      );
    }
    const selfCgroupPath = yield* io('read self cgroup', options.readSelfCgroupPath);
    const parentDir = path.join(
      options.cgroupMount,
      selfCgroupPath.replace(/^\/+/, ''),
      SESSION_CGROUP_PARENT
    );
    const cgroupDir = path.join(
      parentDir,
      `lody-session-${options.sessionId.replace(/[^a-zA-Z0-9._-]/g, '-')}`
    );
    yield* io('create parent', () => options.fs.mkdir(parentDir, { recursive: true }));
    yield* io('create session cgroup', () => options.fs.mkdir(cgroupDir, { recursive: true }));

    for (const fileName of [
      'cgroup.procs',
      'memory.events',
      'memory.max',
      'cpu.max',
      'pids.max',
      'pids.events',
    ]) {
      if (!(yield* exists(path.join(cgroupDir, fileName)))) {
        return yield* Effect.fail(
          new SandboxIoError({
            operation: 'probe',
            message: `required controller file is unavailable in delegated cgroup subtree: ${fileName}`,
            cause: null,
          })
        );
      }
    }
    if (yield* exists(path.join(cgroupDir, 'memory.oom.group'))) {
      yield* io('write memory.oom.group', () =>
        options.fs.writeFile(path.join(cgroupDir, 'memory.oom.group'), '1\n')
      );
    }
    return cgroupDir;
  });

/**
 * The whole cgroup as one tree: alive while it or a nested cgroup has a
 * member, SIGTERM to each direct member, SIGKILL through `cgroup.kill` (which
 * reaches nested cgroups) when the kernel offers it.
 */
const cgroupTree = (
  np: NodeProcessApi,
  cgroupDir: string,
  readPids: Effect.Effect<number[]>,
  readPopulated: Effect.Effect<boolean>,
  exists: (filePath: string) => Effect.Effect<boolean>,
  writeKill: (value: string) => Effect.Effect<void, SandboxIoError>
): ProcessTree => {
  const description = `session cgroup ${path.basename(cgroupDir)}`;
  const signalEach = (signal: TreeSignal, pids: number[]) =>
    Effect.forEach(
      pids,
      (pid) =>
        Effect.try({ try: () => np.kill(pid, signal), catch: (cause) => cause }).pipe(
          Effect.catch((cause) =>
            errnoCode(cause) === 'ESRCH'
              ? Effect.void
              : Effect.fail(
                  new TerminationFailed({
                    target: description,
                    reason: 'signal-failed',
                    message: `Failed to send ${signal} to pid ${pid} in ${description}: ${formatErrorMessage(cause)}`,
                    cause,
                  })
                )
          )
        ),
      { discard: true }
    );
  return {
    description,
    isAlive: Effect.gen(function* () {
      return (yield* readPids).length > 0 || (yield* readPopulated);
    }),
    signal: (signal) =>
      Effect.gen(function* () {
        const pids = yield* readPids;
        if (pids.length === 0 && !(yield* readPopulated)) return 'gone' as const;
        if (signal === 'SIGKILL' && (yield* exists(path.join(cgroupDir, 'cgroup.kill')))) {
          yield* writeKill('1\n').pipe(
            Effect.mapError(
              (error) =>
                new TerminationFailed({
                  target: description,
                  reason: 'signal-failed',
                  message: error.message,
                  cause: error,
                })
            )
          );
          return 'delivered' as const;
        }
        yield* signalEach(signal, pids);
        return 'delivered' as const;
      }),
  };
};

const detectLimitViolation = (
  baseline: { memory: EventCounters; pids: EventCounters },
  after: { memory: EventCounters; pids: EventCounters },
  exit: ProcessExit,
  limitsAtSpawn: SessionSandboxLimits
): SessionResourceLimitViolation | null => {
  const memoryText =
    limitsAtSpawn.memoryMaxBytes === undefined
      ? 'the configured session memory limit'
      : `memory.max (${formatBytes(limitsAtSpawn.memoryMaxBytes)})`;

  const oomKillDelta =
    diffCounter(after.memory, baseline.memory, 'oom_kill') +
    diffCounter(after.memory, baseline.memory, 'oom_group_kill');
  if (oomKillDelta > 0) {
    return {
      kind: 'memory',
      message: `Session exceeded ${memoryText} and was killed by the kernel`,
    };
  }

  const memoryMaxDelta = diffCounter(after.memory, baseline.memory, 'max');
  if (memoryMaxDelta > 0 && (exit.signal === 'SIGKILL' || exit.code === 137)) {
    return {
      kind: 'memory',
      message: `Session hit ${memoryText} and exited under memory pressure`,
    };
  }

  const pidsMaxDelta = diffCounter(after.pids, baseline.pids, 'max');
  if (pidsMaxDelta > 0 && exit.code !== 0) {
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
};

const parseNonNegative = (fileName: string, raw: string) => {
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(
        new SandboxIoError({
          operation: `read ${fileName}`,
          message: `Invalid non-negative number in ${fileName}`,
          cause: null,
        })
      );
};

const parsePids = (content: string): number[] =>
  Array.from(
    new Set(
      content
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    )
  );

const parseEventCounters = (content: string): EventCounters => {
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
};

const diffCounter = (after: EventCounters, before: EventCounters, key: string): number =>
  Math.max(0, (after[key] ?? 0) - (before[key] ?? 0));

const formatBytes = (bytes: number): string => {
  const gib = 1024 * 1024 * 1024;
  if (bytes % gib === 0) {
    return `${bytes / gib} GiB`;
  }
  return `${Math.round((bytes / MIB) * 10) / 10} MiB`;
};

export const normalizeSessionSandboxLimits = (
  limits: SessionSandboxLimits
): SessionSandboxLimits => {
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

  return { memoryMaxBytes, memoryHighBytes, cpuMax, pidsMax };
};

const normalizePositiveInteger = (value: number | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
};

const normalizeCpuMax = (value: string | undefined): string | undefined => {
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
};

const parseCpuLimitCores = (value: string | undefined): number | null => {
  const normalized = normalizeCpuMax(value);
  if (!normalized) return null;
  const [quotaText, periodText] = normalized.split(/\s+/, 2);
  if (!quotaText || !periodText || quotaText === 'max') return null;
  const quota = Number(quotaText);
  const period = Number(periodText);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return null;
  return quota / period;
};

const formatMemoryLimit = (value: number | undefined): string =>
  value === undefined ? 'max\n' : `${value}\n`;

const formatCpuLimit = (value: string | undefined): string =>
  value === undefined ? `max ${DEFAULT_CPU_MAX_PERIOD_US}\n` : `${value}\n`;

const formatPidsLimit = (value: number | undefined): string =>
  value === undefined ? 'max\n' : `${value}\n`;
