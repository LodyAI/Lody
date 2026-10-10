import { Cause, Context, Data, Effect, FileSystem, Layer, Option } from 'effect';
import { NodeFileSystem } from '@effect/platform-node-shared';
import { ChildProcessSpawner } from 'effect/process';
import {
  CommandTimedOut,
  errnoCode,
  runCommand,
  type CommandOutput,
  type RunCommandError,
} from '@lody/shared/node/process';
import { platformLayer, type PlatformFacadeOptions } from '@/platform/process-options';
import { GitExecutableNotFoundError } from './git-process-error';

export const WORKTREE_GIT_TIMEOUT_MS = 10 * 60 * 1000;
export const CREDENTIAL_HELPER_PROBE_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Infrastructure failures are never evidence of a missing ref or best-effort fetch. */
export class WorktreeGitExecutionFailed extends Data.TaggedError('WorktreeGitExecutionFailed')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class WorktreeGitCommandFailed extends Data.TaggedError('WorktreeGitCommandFailed')<{
  readonly message: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}> {}

export interface WorktreeGitCommand {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}
export interface CredentialHelperProbe {
  readonly helperPath: string;
  readonly host: string;
  readonly repoFullName: string;
  readonly env: NodeJS.ProcessEnv;
}
export interface CredentialHelperProbeResult {
  readonly exitCode: number | null;
  readonly returnedCredentials: boolean;
  readonly stderrNonEmpty: boolean;
}

export class WorktreeGitHost extends Context.Service<
  WorktreeGitHost,
  { readonly env: Effect.Effect<NodeJS.ProcessEnv> }
>()('lody/WorktreeGitHost') {}

export class WorktreeGit extends Context.Service<
  WorktreeGit,
  {
    readonly run: (
      command: WorktreeGitCommand
    ) => Effect.Effect<string, WorktreeGitExecutionFailed | WorktreeGitCommandFailed>;
    readonly probeCredentials: (
      probe: CredentialHelperProbe
    ) => Effect.Effect<CredentialHelperProbeResult, WorktreeGitExecutionFailed>;
  }
>()('lody/WorktreeGit') {}

export const WorktreeGitLive = Layer.effect(
  WorktreeGit,
  Effect.gen(function* () {
    const filesystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* WorktreeGitHost;
    const executionFailed = (error: RunCommandError) =>
      new WorktreeGitExecutionFailed({ message: error.message, cause: error });
    const text = (output: CommandOutput) => ({
      stdout: output.stdout.toString('utf8'),
      stderr: output.stderr.toString('utf8'),
    });
    return WorktreeGit.of({
      run: (command) =>
        Effect.gen(function* () {
          const env = { ...(yield* host.env), ...command.env, GIT_TERMINAL_PROMPT: '0' };
          yield* Effect.logDebug(`Running git ${command.args.join(' ')}`);
          const output = yield* runCommand({
            command: 'git',
            args: command.args,
            cwd: command.cwd,
            env,
            timeout: WORKTREE_GIT_TIMEOUT_MS,
            maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const failure = Cause.findErrorOption(cause);
                // v4 catch/mapError select one Fail reason; preserve a release defect
                // or interruption alongside it instead of replacing the whole Cause.
                if (cause.reasons.length !== 1 || Option.isNone(failure))
                  return yield* Effect.failCause(Cause.map(cause, executionFailed));
                const error = failure.value;
                if (error._tag === 'SpawnFailed' && errnoCode(error.cause) === 'ENOENT') {
                  const exists = yield* filesystem.exists(command.cwd).pipe(
                    Effect.mapError(
                      (filesystemError) =>
                        new WorktreeGitExecutionFailed({
                          message: `Cannot inspect git working directory: ${command.cwd}`,
                          cause: filesystemError,
                        })
                    )
                  );
                  if (exists)
                    return yield* Effect.fail(
                      new WorktreeGitExecutionFailed({
                        message:
                          'Git is unavailable: Lody could not find the Git executable in PATH.',
                        cause: new GitExecutableNotFoundError(error),
                      })
                    );
                }
                return yield* Effect.fail(
                  error instanceof CommandTimedOut
                    ? new WorktreeGitExecutionFailed({
                        message: `git ${command.args.join(' ')} timed out after ${WORKTREE_GIT_TIMEOUT_MS}ms`,
                        cause: error,
                      })
                    : executionFailed(error)
                );
              })
            )
          );
          const { stdout, stderr } = text(output);
          if (output.code !== 0 || output.signal !== null)
            return yield* Effect.fail(
              new WorktreeGitCommandFailed({
                args: command.args,
                cwd: command.cwd,
                code: output.code,
                signal: output.signal,
                stdout,
                stderr,
                message: (stderr || stdout).trim() || `git exited with code ${output.code}`,
              })
            );
          return stdout.trim();
        }),
      probeCredentials: (probe) =>
        runCommand({
          command: 'node',
          args: [probe.helperPath, 'get'],
          env: probe.env,
          input: `protocol=https\nhost=${probe.host}\npath=/${probe.repoFullName}.git\n\n`,
          timeout: CREDENTIAL_HELPER_PROBE_TIMEOUT_MS,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, executionFailed))),
          Effect.map((output) => {
            const { stdout, stderr } = text(output);
            return {
              exitCode: output.code,
              returnedCredentials:
                stdout.includes('username=') &&
                stdout.includes('\npassword=') &&
                stdout.includes('\n\n'),
              stderrNonEmpty: stderr.trim().length > 0,
            };
          })
        ),
    });
  })
);

/** Passive composition. Every command owns its process Scope; the service owns no background fiber. */
export const worktreeGitLayer = (options: PlatformFacadeOptions = {}) =>
  WorktreeGitLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeFileSystem.layer,
        Layer.succeed(WorktreeGitHost, { env: Effect.sync(() => ({ ...process.env })) }),
        platformLayer(options)
      )
    )
  );
