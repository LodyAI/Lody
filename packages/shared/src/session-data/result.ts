import type { SessionCommandResult } from './types';

/** Translate a write result for callers whose public API throws on failure. */
export function requireSessionAccepted<T extends SessionCommandResult>(
  result: T
): Extract<T, { status: 'accepted' }> {
  if (result.status === 'accepted') return result as Extract<T, { status: 'accepted' }>;
  if (result.status === 'indeterminate')
    throw result.cause instanceof Error
      ? result.cause
      : new Error('Session write outcome is indeterminate; do not retry automatically', {
          cause: result.cause,
        });
  throw new Error(`Session write rejected: ${result.reason.code}`);
}
