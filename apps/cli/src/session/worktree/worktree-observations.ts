import path from 'node:path';
import { Cause, Context, Effect, FileSystem, Layer, Option, type PlatformError } from 'effect';
import type { RepoId, SessionId } from '@lody/shared';
import { FileLocks, type FileLockError } from '@lody/shared/node/file-lock';
import { errnoCode } from '@lody/shared/node/process';
import {
  WorktreeGit,
  WorktreeGitCommandFailed,
  WorktreeGitExecutionFailed,
  worktreeGitLayer,
} from './git-execution';
import type { PlatformFacadeOptions } from '@/platform/process-options';
import { getAllocatedSessionBranchName } from './branch-name-allocation';
import type { WorktreeInfo, WorktreeInspection } from './worktree-manager';

type GitError = WorktreeGitExecutionFailed | WorktreeGitCommandFailed;
export type WorktreeObservationError = GitError | FileLockError;
export interface WorktreeObservationSource {
  readonly repoId: RepoId;
  readonly worktreesDir: string;
  readonly localShared: boolean;
}
const safeSessionId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const checkSessionId = (sessionId: SessionId) =>
  safeSessionId.test(sessionId)
    ? Effect.void
    : Effect.fail(
        new WorktreeGitExecutionFailed({
          message: `Invalid sessionId ${JSON.stringify(sessionId)}: expected /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`,
          cause: sessionId,
        })
      );

// Recover only a completed single Git exit; never erase an accompanying release defect.
const recoverExit = <A>(
  program: Effect.Effect<A, GitError>,
  fallback: (error: WorktreeGitCommandFailed) => Effect.Effect<A, GitError>
) =>
  program.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.findErrorOption(cause);
      return cause.reasons.length === 1 &&
        Option.isSome(error) &&
        error.value instanceof WorktreeGitCommandFailed
        ? fallback(error.value)
        : Effect.failCause(cause);
    })
  );
const filesystemFailure = (error: PlatformError.PlatformError) =>
  new WorktreeGitExecutionFailed({ message: error.message, cause: error });
const observeFile = <A>(program: Effect.Effect<A, PlatformError.PlatformError>) =>
  program.pipe(Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, filesystemFailure))));
const optionalFile = <A, B>(program: Effect.Effect<A, PlatformError.PlatformError>, absent: B) =>
  program.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.findErrorOption(cause);
      return cause.reasons.length === 1 &&
        Option.isSome(error) &&
        error.value.reason._tag === 'NotFound'
        ? Effect.succeed(absent)
        : Effect.failCause(Cause.map(cause, filesystemFailure));
    })
  );

export class WorktreeObservations extends Context.Service<
  WorktreeObservations,
  {
    readonly currentBranch: (
      source: WorktreeObservationSource,
      sessionId: SessionId
    ) => Effect.Effect<string | null, GitError>;
    /** Read under the mutation caller's existing repo lock; this does not acquire a second lock. */
    readonly info: (
      source: WorktreeObservationSource,
      sessionId: SessionId
    ) => Effect.Effect<WorktreeInfo, GitError>;
    readonly inspect: (
      source: WorktreeObservationSource,
      sessionId: SessionId
    ) => Effect.Effect<WorktreeInspection, WorktreeObservationError>;
    readonly list: (
      source: WorktreeObservationSource
    ) => Effect.Effect<WorktreeInfo[], WorktreeObservationError>;
  }
>()('lody/WorktreeObservations') {}

export const WorktreeObservationsLive = Layer.effect(
  WorktreeObservations,
  Effect.gen(function* () {
    const filesystem = yield* FileSystem.FileSystem;
    const git = yield* WorktreeGit;
    const locks = yield* FileLocks;
    const hostPath = (source: WorktreeObservationSource, sessionId: SessionId) =>
      Effect.gen(function* () {
        yield* checkSessionId(sessionId);
        const root = yield* optionalFile(
          filesystem.realPath(source.worktreesDir),
          source.worktreesDir
        );
        return path.join(root, sessionId);
      });
    const currentBranchAt = (cwd: string): Effect.Effect<string | null, GitError> =>
      recoverExit(
        git
          .run({ args: ['branch', '--show-current'], cwd })
          .pipe(Effect.map((branch) => branch || null)),
        (error) =>
          error.code === 129 && /(?:unknown|unrecognized) option/.test(error.stderr)
            ? git
                .run({ args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd })
                .pipe(Effect.map((branch) => branch || null))
            : Effect.fail(error)
      );
    const currentBranch = (source: WorktreeObservationSource, sessionId: SessionId) =>
      Effect.gen(function* () {
        const cwd = yield* hostPath(source, sessionId);
        if (!(yield* observeFile(filesystem.exists(cwd)))) return null;
        return yield* currentBranchAt(cwd);
      });
    const infoAt = (source: WorktreeObservationSource, sessionId: SessionId, cwd: string) =>
      Effect.gen(function* () {
        const current = yield* currentBranchAt(cwd);
        const status = yield* git.run({ args: ['status', '--porcelain'], cwd });
        const headSha = yield* recoverExit<string | null>(
          git.run({ args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd }),
          (error) =>
            Effect.gen(function* () {
              if (error.code !== 128 || !current) return yield* Effect.fail(error);
              // An unborn branch has no ref. An existing broken ref must keep failing.
              const unborn = yield* recoverExit(
                git
                  .run({ args: ['show-ref', '--verify', '--quiet', `refs/heads/${current}`], cwd })
                  .pipe(Effect.as(false)),
                (refError) => (refError.code === 1 ? Effect.succeed(true) : Effect.fail(refError))
              );
              if (!unborn) return yield* Effect.fail(error);
              return null;
            })
        );
        return {
          sessionId,
          hostPath: cwd,
          branch: current ?? getAllocatedSessionBranchName(sessionId, source.localShared),
          headSha,
          isClean: status.length === 0,
        };
      });
    const info = (source: WorktreeObservationSource, sessionId: SessionId) =>
      Effect.flatMap(hostPath(source, sessionId), (cwd) => infoAt(source, sessionId, cwd));
    const withRepoLock = <A, E>(source: WorktreeObservationSource, body: Effect.Effect<A, E>) =>
      locks.withLock(`worktree-${source.repoId}`, body, { timeout: 120_000 });
    return WorktreeObservations.of({
      currentBranch,
      info,
      inspect: (source, sessionId) =>
        withRepoLock(
          source,
          Effect.gen(function* () {
            const cwd = yield* hostPath(source, sessionId);
            if (!(yield* observeFile(filesystem.exists(cwd))))
              return { state: 'missing', path: cwd } as const;
            // A failed Git exit is an explicit inspection failure. Infrastructure and
            // mixed release failure stay in the error/Cause channel.
            return yield* recoverExit<WorktreeInspection>(
              infoAt(source, sessionId, cwd).pipe(
                Effect.map((record) => ({
                  state: record.isClean ? 'clean' : 'dirty',
                  path: cwd,
                  info: record,
                }))
              ),
              (error) => Effect.succeed({ state: 'failed', path: cwd, message: error.message })
            );
          })
        ),
      list: (source) =>
        withRepoLock(
          source,
          Effect.gen(function* () {
            const entries = yield* optionalFile(filesystem.readDirectory(source.worktreesDir), []);
            const result: WorktreeInfo[] = [];
            for (const entry of entries) {
              if (!safeSessionId.test(entry)) {
                yield* Effect.logDebug(
                  `Skipping invalid worktree directory name: ${JSON.stringify(entry)}`
                );
                continue;
              }
              const entryPath = path.join(source.worktreesDir, entry);
              // Official stat follows symlinks. Preserve the previous Dirent policy by
              // checking readLink first; EINVAL specifically means this entry is not a link.
              const link = yield* filesystem.readLink(entryPath).pipe(
                Effect.catchCause((cause) => {
                  const error = Cause.findErrorOption(cause);
                  if (cause.reasons.length === 1 && Option.isSome(error)) {
                    if (error.value.reason._tag === 'NotFound') return Effect.succeed(true);
                    if (errnoCode(error.value.reason.cause) === 'EINVAL')
                      return Effect.succeed(false);
                  }
                  return Effect.failCause(Cause.map(cause, filesystemFailure));
                }),
                Effect.map((value) => (typeof value === 'string' ? true : value))
              );
              if (link) continue;
              const stat = yield* optionalFile(
                filesystem.stat(entryPath).pipe(Effect.map((metadata) => metadata.type)),
                undefined
              );
              if (stat !== 'Directory') continue;
              result.push(yield* info(source, entry as SessionId));
            }
            return result;
          })
        ),
    });
  })
);

/** FileLocks comes from the owning application runtime, never a second lock coordinator. */
export const worktreeObservationLayer = (options: PlatformFacadeOptions = {}) =>
  WorktreeObservationsLive.pipe(Layer.provideMerge(worktreeGitLayer(options)));
