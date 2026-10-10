import { Effect } from 'effect';
import {
  ProcessCleanupFailed,
  ProcessReleaseFailed,
  runPromiseSquashedLegacy,
} from '@lody/shared/node/process';
import type { PlatformFacadeOptions } from '@/platform/process-options';
import {
  WorktreeGit,
  WorktreeGitExecutionFailed,
  WorktreeGitCommandFailed,
  worktreeGitLayer,
  type WorktreeGitCommand,
  type CredentialHelperProbe,
} from './git-execution';

const executeLegacy = async <A, E>(
  program: Effect.Effect<A, E, WorktreeGit>,
  options: PlatformFacadeOptions
): Promise<A> => {
  try {
    return await runPromiseSquashedLegacy(program.pipe(Effect.provide(worktreeGitLayer(options))), {
      signal: options.signal,
    });
  } catch (error) {
    if (
      error instanceof WorktreeGitCommandFailed ||
      error instanceof WorktreeGitExecutionFailed ||
      error instanceof ProcessCleanupFailed ||
      error instanceof ProcessReleaseFailed
    )
      throw error;
    // Pure interruption is squashed to an ordinary Error in pinned v4. Keep it
    // distinguishable from a Git exit, including logger defects at this boundary.
    throw new WorktreeGitExecutionFailed({
      message: error instanceof Error ? error.message : 'Worktree Git execution failed',
      cause: error,
    });
  }
};

/**
 * @deprecated Only for WorktreeManager's unmigrated Promise orchestration.
 * Delete when that owner composes WorktreeGit in its own Effect workflow.
 */
export const worktreeGitLegacy = {
  run: (command: WorktreeGitCommand, options: PlatformFacadeOptions = {}) =>
    executeLegacy(
      Effect.flatMap(WorktreeGit, (git) => git.run(command)),
      options
    ),
  probeCredentials: (probe: CredentialHelperProbe, options: PlatformFacadeOptions = {}) =>
    executeLegacy(
      Effect.flatMap(WorktreeGit, (git) => git.probeCredentials(probe)),
      options
    ),
};

/** Promise catches must not turn a transport or unresolved release into a fallback. */
export function rethrowWorktreeGitInfrastructureFailure(error: unknown): void {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof WorktreeGitExecutionFailed ||
      current instanceof ProcessCleanupFailed ||
      current instanceof ProcessReleaseFailed
    )
      throw error;
    current = (current as { cause?: unknown }).cause;
  }
}
