import path from 'node:path';
import { Cause, Clock, Context, Data, Effect, FileSystem, Layer, Option } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import type { RepoId } from '@lody/shared';
import { LodyDataDirUnavailableError } from '@lody/shared/node/installation-profile';
import type { PlatformFacadeOptions } from '@/platform/process-options';
import { WorktreeGit, WorktreeGitCommandFailed, WorktreeGitExecutionFailed } from './git-execution';
import { worktreeGitLayer } from './git-execution';

export interface LocalWorktreeSource {
  readonly repoId: RepoId;
  readonly dataDir: string;
  readonly repoDir: string;
  readonly worktreesDir: string;
  readonly cacheDir: string;
  readonly originalRootPath: string;
  readonly sourceGitDir?: string;
}

export class LocalWorktreeSourceInvalid extends Data.TaggedError('LocalWorktreeSourceInvalid')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export const LOCAL_WORKTREE_SCRATCH_RELEASE_MS = 5_000;

/** Retains the uniquely owned scratch path and a bounded retry after failed release. */
export class LocalWorktreeScratchReleaseFailed extends Data.TaggedError(
  'LocalWorktreeScratchReleaseFailed'
)<{
  readonly directory: string;
  readonly cause: Cause.Cause<PlatformError | Cause.TimeoutError>;
  readonly retryCleanup: Effect.Effect<void, PlatformError | Cause.TimeoutError>;
}> {
  override get message() {
    return `Local worktree metadata scratch release failed: ${this.directory}`;
  }
}

export class LocalWorktreePreparation extends Context.Service<
  LocalWorktreePreparation,
  {
    /** The mutation owner already holds its repo lease. Persistent directories survive failure. */
    readonly prepareLocked: (
      source: LocalWorktreeSource
    ) => Effect.Effect<
      void,
      | WorktreeGitExecutionFailed
      | WorktreeGitCommandFailed
      | LocalWorktreeSourceInvalid
      | LodyDataDirUnavailableError
    >;
  }
>()('lody/LocalWorktreePreparation') {}

export const LocalWorktreePreparationLive = Layer.effect(
  LocalWorktreePreparation,
  Effect.gen(function* () {
    const filesystem = yield* FileSystem.FileSystem;
    const git = yield* WorktreeGit;
    const io = <A, R>(program: Effect.Effect<A, PlatformError, R>, message?: string) =>
      program.pipe(
        Effect.catchCause((cause) =>
          Effect.failCause(
            Cause.map(
              cause,
              (error) =>
                new WorktreeGitExecutionFailed({ message: message ?? error.message, cause: error })
            )
          )
        )
      );
    return LocalWorktreePreparation.of({
      prepareLocked: (source) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* filesystem
              .makeDirectory(source.dataDir, { recursive: true })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.failCause(
                    Cause.map(
                      cause,
                      (error) => new LodyDataDirUnavailableError(source.dataDir, error)
                    )
                  )
                )
              );
            yield* io(filesystem.makeDirectory(source.worktreesDir, { recursive: true }));
            const metadata = yield* io(
              filesystem.stat(source.originalRootPath),
              `[${source.repoId}] Local worktree source is missing: ${source.originalRootPath}`
            );
            if (metadata.type !== 'Directory')
              return yield* Effect.fail(
                new LocalWorktreeSourceInvalid({
                  message: `[${source.repoId}] Local worktree source is not a directory: ${source.originalRootPath}`,
                  cause: source.originalRootPath,
                })
              );
            yield* git
              .run({
                args: ['rev-parse', '--git-dir', '--is-inside-work-tree'],
                cwd: source.originalRootPath,
              })
              .pipe(
                Effect.catchCause(
                  (
                    cause
                  ): Effect.Effect<
                    never,
                    | LocalWorktreeSourceInvalid
                    | WorktreeGitCommandFailed
                    | WorktreeGitExecutionFailed
                  > => {
                    const error = Cause.findErrorOption(cause);
                    if (
                      cause.reasons.length === 1 &&
                      Option.isSome(error) &&
                      error.value instanceof WorktreeGitCommandFailed
                    )
                      return Effect.fail(
                        new LocalWorktreeSourceInvalid({
                          message: `[${source.repoId}] Local project is not a git repository: ${source.originalRootPath}`,
                          cause: error.value,
                        })
                      );
                    return Effect.failCause(cause);
                  }
                )
              );
            yield* io(filesystem.makeDirectory(source.cacheDir, { recursive: true }));
            yield* io(filesystem.makeDirectory(source.repoDir, { recursive: true }));
            const target = path.join(source.repoDir, 'meta.json');
            if (yield* io(filesystem.exists(target))) return undefined;
            const createdAtMs = yield* Clock.currentTimeMillis;
            // Own the directory before any file write. The pinned official temp-file helper
            // writes during acquisition and cannot release its directory if that write fails.
            const cleanup = (directory: string) =>
              filesystem
                .remove(directory, { recursive: true, force: true })
                .pipe(Effect.interruptible, Effect.timeout(LOCAL_WORKTREE_SCRATCH_RELEASE_MS));
            const scratchDir = yield* io(
              Effect.acquireRelease(
                filesystem.makeTempDirectory({
                  directory: source.repoDir,
                  prefix: '.lody-source-',
                }),
                (directory) =>
                  cleanup(directory).pipe(
                    Effect.catchCause((cause) =>
                      Effect.die(
                        new LocalWorktreeScratchReleaseFailed({
                          directory,
                          cause,
                          retryCleanup: cleanup(directory),
                        })
                      )
                    )
                  )
              )
            );
            const scratch = path.join(scratchDir, 'meta.json');
            yield* io(
              filesystem.writeFileString(
                scratch,
                JSON.stringify(
                  {
                    kind: 'local',
                    originalRootPath: source.originalRootPath,
                    ...(source.sourceGitDir ? { sourceGitDir: source.sourceGitDir } : {}),
                    createdAtMs,
                  },
                  null,
                  2
                ) + '\n'
              )
            );
            // One complete file is published exclusively. Only this local publication is
            // masked; source validation, Git and the preparatory write remain interruptible.
            yield* filesystem.link(scratch, target).pipe(
              Effect.uninterruptible,
              Effect.catchCause((cause) => {
                const error = Cause.findErrorOption(cause);
                return cause.reasons.length === 1 &&
                  Option.isSome(error) &&
                  error.value.reason._tag === 'AlreadyExists'
                  ? Effect.void
                  : Effect.failCause(
                      Cause.map(
                        cause,
                        (filesystemError) =>
                          new WorktreeGitExecutionFailed({
                            message: filesystemError.message,
                            cause: filesystemError,
                          })
                      )
                    );
              })
            );
            return undefined;
          })
        ),
    });
  })
);

/** This finite service borrows the mutation owner's repo lease; it owns no runtime. */
export const localWorktreePreparationLayer = (options: PlatformFacadeOptions = {}) =>
  LocalWorktreePreparationLive.pipe(Layer.provideMerge(worktreeGitLayer(options)));
