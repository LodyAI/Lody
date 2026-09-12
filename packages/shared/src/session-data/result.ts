import type { SessionCommandResult } from './types';

/** Bridge for business operations that expose exceptions rather than command receipts.
 * An accepted write stays accepted even if a post-accept side effect failed.
 */
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
