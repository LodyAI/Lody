import { createWriteStream, mkdirSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Cause, Clock, Effect, Fiber, FiberMap, Option } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { spawnProcess } from '@lody/shared/node/process';
import type { AutomationResult, AutomationRunExit, AutomationWait } from '@lody/shared/automations';

/** Output beyond this many bytes is dropped from the log; the tail keeps updating. */
export const MANAGED_RUN_LOG_LIMIT_BYTES = 16 * 1024 * 1024;
/** The bounded output tail returned with the exit facts. */
export const MANAGED_RUN_TAIL_BYTES = 4 * 1024;
/** Logs older than this are removed when another run starts in the same directory. */
export const MANAGED_RUN_LOG_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface ManagedRunStart {
  readonly command: string;
  readonly args: readonly string[];
  /** Absolute, already validated working directory. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logPath: string;
}

export interface ManagedRuns {
  /** Starts at most one process per wait id in the owner's Scope. */
  readonly start: (id: string, run: ManagedRunStart) => Effect.Effect<void>;
  readonly has: (id: string) => boolean;
  /** Interrupts the owner, which terminates the process tree, and joins it. */
  readonly stop: (id: string) => Effect.Effect<void>;
}

const pruneLogs = (directory: string, now: number) =>
  Effect.promise(async () => {
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (!name.endsWith('.log')) continue;
      const file = path.join(directory, name);
      const info = await stat(file).catch(() => undefined);
      if (info && now - info.mtimeMs > MANAGED_RUN_LOG_RETENTION_MS)
        await unlink(file).catch(() => undefined);
    }
  });

/**
 * Processes belong to the calling Scope, never to the check that started them:
 * cancelling a check leaves the run alive, and closing the Scope terminates every run
 * without recording an exit. A later check then reports that run as interrupted.
 */
export const makeManagedRuns = Effect.fnUntraced(function* (options: {
  readonly onStarted: (id: string, pid: number) => Effect.Effect<void>;
  readonly onExit: (id: string, exit: AutomationRunExit) => Effect.Effect<void>;
  readonly report: (cause: unknown) => Effect.Effect<void>;
}) {
  const fibers = yield* FiberMap.make<string>();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const supervise = (id: string, run: ManagedRunStart) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(run.logPath);
        yield* Effect.sync(() => mkdirSync(directory, { recursive: true }));
        yield* pruneLogs(directory, yield* Clock.currentTimeMillis);
        const log = yield* Effect.acquireRelease(
          Effect.sync(() => createWriteStream(run.logPath, { flags: 'a' })),
          (stream) =>
            Effect.callback<void>((resume) => {
              stream.end(() => resume(Effect.void));
            }).pipe(Effect.timeoutOption('5 seconds'), Effect.asVoid)
        );
        let written = 0;
        let truncated = false;
        let tail = Buffer.alloc(0);
        const capture = (chunk: Buffer) => {
          tail = Buffer.concat([tail, chunk]);
          if (tail.length > MANAGED_RUN_TAIL_BYTES)
            tail = tail.subarray(tail.length - MANAGED_RUN_TAIL_BYTES);
          if (truncated) return;
          if (written + chunk.length > MANAGED_RUN_LOG_LIMIT_BYTES) {
            truncated = true;
            log.write(`\n[Lody: log limit of ${MANAGED_RUN_LOG_LIMIT_BYTES} bytes reached]\n`);
            return;
          }
          written += chunk.length;
          log.write(chunk);
        };
        const facts = (
          outcome: AutomationRunExit['outcome'],
          endedAt: number,
          exit?: { code: number | null; signal: string | null },
          error?: string
        ): AutomationRunExit => ({
          endedAt,
          outcome,
          exitCode: exit?.code ?? null,
          signal: exit?.signal ?? null,
          ...(error ? { error: error.slice(0, 2000) } : {}),
          tail: tail.toString('utf8').replace(/^�+/, ''),
          logTruncated: truncated,
        });
        const child = yield* spawnProcess({
          command: run.command,
          args: [...run.args],
          options: { cwd: run.cwd, env: run.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
          processGroup: true,
          onSpawned: (process) => {
            process.stdout?.on('data', capture);
            process.stderr?.on('data', capture);
          },
        }).pipe(Effect.result);
        if (child._tag === 'Failure') {
          yield* options.onExit(
            id,
            facts('spawn_failed', yield* Clock.currentTimeMillis, undefined, child.failure.message)
          );
          return;
        }
        const pid = yield* child.success.started.pipe(Effect.result);
        if (pid._tag === 'Failure') {
          yield* options.onExit(
            id,
            facts('spawn_failed', yield* Clock.currentTimeMillis, undefined, pid.failure.message)
          );
          return;
        }
        yield* options.onStarted(id, pid.success);
        const exit = yield* child.success.exited;
        // Descendants may hold the pipes; release the group, then drain within a bound.
        yield* child.success
          .terminate({ graceMs: 2_000, killWaitMs: 2_000 })
          .pipe(Effect.catchCause(options.report));
        yield* child.success.closed.pipe(Effect.timeoutOption('5 seconds'));
        yield* Effect.callback<void>((resume) => {
          log.write('', () => resume(Effect.void));
        }).pipe(Effect.timeoutOption('5 seconds'));
        yield* options.onExit(id, facts('exited', yield* Clock.currentTimeMillis, exit));
      })
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : options.report(cause)
      )
    );
  return {
    start: (id, run) =>
      FiberMap.run(fibers, id, supervise(id, run), { onlyIfMissing: true }).pipe(Effect.asVoid),
    has: (id) => FiberMap.hasUnsafe(fibers, id),
    stop: (id) =>
      Effect.suspend(() => {
        const fiber = FiberMap.getUnsafe(fibers, id);
        return Option.isSome(fiber) ? Fiber.interrupt(fiber.value) : Effect.void;
      }),
  } satisfies ManagedRuns;
});

const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}h ${minutes}m ${rest}s` : minutes ? `${minutes}m ${rest}s` : `${rest}s`;
};

/** The continuation states only what the Host observed about the run. */
export const managedRunResult = (
  wait: Pick<AutomationWait, 'run'>,
  exit: AutomationRunExit
): Exclude<AutomationResult, false> => {
  const run = wait.run!;
  const command = [run.command, ...run.args].join(' ').slice(0, 1000);
  const durationMs = run.startedAt === undefined ? undefined : exit.endedAt - run.startedAt;
  const after = durationMs === undefined ? '' : ` after ${formatDuration(durationMs)}`;
  const outcome =
    exit.outcome === 'spawn_failed'
      ? `could not start: ${exit.error ?? 'unknown error'}`
      : exit.outcome === 'interrupted'
        ? `stopped being observed${after}: Lody stopped or restarted before the exit was seen. Lody did not run it again; it may have been terminated or may still be running${run.pid ? ` (pid ${run.pid})` : ''}`
        : exit.signal
          ? `was terminated by ${exit.signal}${after}`
          : `exited with code ${exit.exitCode ?? 'unknown'}${after}`;
  return {
    resumeText: `The Lody-managed command \`${command}\` ${outcome}. Output log: ${run.logPath}`,
    payload: {
      command,
      ...(run.cwd ? { cwd: run.cwd } : {}),
      outcome: exit.outcome,
      exitCode: exit.exitCode,
      signal: exit.signal,
      ...(durationMs === undefined ? {} : { durationMs }),
      logPath: run.logPath,
      logTruncated: exit.logTruncated,
      outputTail: exit.tail,
    },
  };
};
