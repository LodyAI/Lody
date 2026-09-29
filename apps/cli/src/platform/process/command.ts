import type { ChildProcess } from 'node:child_process';

import { Data, Deferred, Duration, Effect, Exit } from 'effect';

import { formatErrorMessage } from '@/utils/format-error';

import { SpawnFailed } from './errors';
import { spawnProcess, type ProcessExit } from './managed-process';
import { NodeProcess } from './node-process';
import type { TerminationPolicy } from './process-tree';

/** Node's `execFile` default, so migrated callers keep their output ceiling. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** How a command is ended when its caller stops waiting (timeout, interrupt, output limit). */
const ABANDONED_COMMAND_POLICY: TerminationPolicy = { graceMs: 0, killWaitMs: 2_000 };

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Without it stdin is ignored. */
  readonly input?: string | Buffer;
  /** Ends the whole process tree and fails with `CommandTimedOut` when exceeded. */
  readonly timeout?: Duration.DurationInput;
  /** Combined ceiling per stream; exceeding it fails with `CommandOutputTooLarge`. */
  readonly maxOutputBytes?: number;
  /** Runs right after the OS call, for a caller that must record the pid. */
  readonly onSpawned?: (child: ChildProcess) => void;
}

export interface CommandOutput extends ProcessExit {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export class CommandTimedOut extends Data.TaggedError('CommandTimedOut')<{
  readonly command: string;
  readonly message: string;
}> {}

export class CommandOutputTooLarge extends Data.TaggedError('CommandOutputTooLarge')<{
  readonly command: string;
  readonly message: string;
}> {}

/**
 * A command that exited unsuccessfully. Carries what `execFile` rejected with,
 * so callers that classify git or gh failures by stderr keep working.
 */
export class CommandFailed extends Data.TaggedError('CommandFailed')<{
  readonly command: string;
  readonly args: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}> {}

export type RunCommandError = SpawnFailed | CommandTimedOut | CommandOutputTooLarge;

const describe = (spec: Pick<CommandSpec, 'command' | 'args'>) =>
  [spec.command, ...spec.args].join(' ');

/**
 * Run a command to completion and collect its output, whatever its exit status.
 * The command leads its own process tree. A caller that stops waiting (timeout,
 * interruption, output over the limit) ends that whole tree; a command that
 * exits on its own keeps whatever it deliberately left running, as `execFile`
 * did (daemons such as an fsmonitor or an agent socket).
 */
export const runCommand = (
  spec: CommandSpec
): Effect.Effect<CommandOutput, RunCommandError, NodeProcess> =>
  Effect.scoped(
    Effect.gen(function* () {
      const maxBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const overflowed = yield* Deferred.make<never, CommandOutputTooLarge>();
      const overflow = () =>
        Deferred.unsafeDone(
          overflowed,
          Effect.fail(
            new CommandOutputTooLarge({
              command: spec.command,
              message: `${describe(spec)} wrote more than ${maxBytes} bytes to one stream`,
            })
          )
        );
      const managed = yield* Effect.acquireRelease(
        spawnProcess({
          command: spec.command,
          args: spec.args,
          options: {
            cwd: spec.cwd,
            env: spec.env,
            stdio: [spec.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          },
          processGroup: true,
          onSpawned: (child) => {
            spec.onSpawned?.(child);
            child.stdout?.on('data', (chunk: Buffer) => {
              stdoutBytes += chunk.length;
              if (stdoutBytes > maxBytes) overflow();
              else stdout.push(chunk);
            });
            child.stderr?.on('data', (chunk: Buffer) => {
              stderrBytes += chunk.length;
              if (stderrBytes > maxBytes) overflow();
              else stderr.push(chunk);
            });
            if (spec.input !== undefined && child.stdin) {
              // A child that exits without reading its input closes the pipe;
              // that is its choice, not a failure of this call.
              child.stdin.on('error', () => {});
              child.stdin.end(spec.input);
            }
          },
        }),
        (process, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : process
                .terminate(ABANDONED_COMMAND_POLICY)
                .pipe(
                  Effect.catchAll((error) =>
                    Effect.logWarning(
                      `Abandoned command ${describe(spec)} could not be terminated: ${error.message}`
                    )
                  )
                )
      );
      yield* managed.started;
      const finished = Effect.raceFirst(managed.closed, Deferred.await(overflowed));
      const exit = yield* spec.timeout
        ? finished.pipe(
            Effect.timeoutFail({
              duration: spec.timeout,
              onTimeout: () =>
                new CommandTimedOut({
                  command: spec.command,
                  message: `${describe(spec)} did not finish within ${Duration.format(spec.timeout ?? 0)}`,
                }),
            })
          )
        : finished;
      return { ...exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    })
  );

const toCommandFailed = (spec: CommandSpec, output: CommandOutput) =>
  new CommandFailed({
    command: spec.command,
    args: spec.args,
    code: output.code,
    signal: output.signal,
    stdout: output.stdout.toString('utf8'),
    stderr: output.stderr.toString('utf8'),
    message: `${describe(spec)} failed (${output.signal ?? `exit ${output.code}`}): ${output.stderr.toString('utf8').trim()}`,
  });

/** `runCommand`, failing with `CommandFailed` unless the command exits 0. */
export const runCommandOk = (
  spec: CommandSpec
): Effect.Effect<CommandOutput, RunCommandError | CommandFailed, NodeProcess> =>
  Effect.flatMap(runCommand(spec), (output) =>
    output.code === 0 && output.signal === null
      ? Effect.succeed(output)
      : Effect.fail(toCommandFailed(spec, output))
  );

/**
 * Blocking variant for callers that are synchronous by contract. It stalls the
 * daemon's event loop for the command's whole run, so it requires a timeout;
 * prefer `runCommand` wherever the caller can await.
 */
export const runCommandSync = (
  spec: CommandSpec & { readonly timeout: Duration.DurationInput }
): Effect.Effect<CommandOutput, RunCommandError, NodeProcess> =>
  Effect.gen(function* () {
    const np = yield* NodeProcess;
    const timeoutMs = Duration.toMillis(Duration.decode(spec.timeout));
    const result = np.spawnSync(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      input: spec.input,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      windowsHide: true,
      stdio: [spec.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (errorCode === 'ETIMEDOUT') {
      return yield* Effect.fail(
        new CommandTimedOut({
          command: spec.command,
          message: `${describe(spec)} did not finish within ${timeoutMs}ms`,
        })
      );
    }
    if (errorCode === 'ENOBUFS') {
      return yield* Effect.fail(
        new CommandOutputTooLarge({
          command: spec.command,
          message: `${describe(spec)} wrote more than its output limit`,
        })
      );
    }
    if (result.error) {
      return yield* Effect.fail(
        new SpawnFailed({
          command: spec.command,
          message: `Failed to spawn ${spec.command}: ${formatErrorMessage(result.error)}`,
          cause: result.error,
        })
      );
    }
    return {
      code: result.status,
      signal: result.signal,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: result.stderr ?? Buffer.alloc(0),
    };
  });

/** `runCommandSync`, failing with `CommandFailed` unless the command exits 0. */
export const runCommandSyncOk = (
  spec: CommandSpec & { readonly timeout: Duration.DurationInput }
): Effect.Effect<CommandOutput, RunCommandError | CommandFailed, NodeProcess> =>
  Effect.flatMap(runCommandSync(spec), (output) =>
    output.code === 0 && output.signal === null
      ? Effect.succeed(output)
      : Effect.fail(toCommandFailed(spec, output))
  );

/** Whether any process has this pid (`kill(pid, 0)`; EPERM still means alive). */
export const isPidAlive = (pid: number): Effect.Effect<boolean, never, NodeProcess> =>
  Effect.map(NodeProcess, (np) => {
    try {
      np.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
    }
  });
