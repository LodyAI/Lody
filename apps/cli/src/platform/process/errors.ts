import { Data } from 'effect';

/** The OS refused to start a process (for example ENOENT or EACCES). */
export class SpawnFailed extends Data.TaggedError('SpawnFailed')<{
  readonly command: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * A process tree could not be proven gone within the termination policy.
 *
 * `still-alive`: every signal was delivered but the tree outlived the bounded
 * wait. `signal-failed`: the final signal could not be delivered at all.
 * Callers must not treat either as success: the tree may still hold resources
 * (an ACP prompt, a port, a file lock) that a successor would contend with.
 */
export class TerminationFailed extends Data.TaggedError('TerminationFailed')<{
  readonly target: string;
  readonly reason: 'still-alive' | 'signal-failed';
  readonly message: string;
  readonly cause?: unknown;
}> {}
