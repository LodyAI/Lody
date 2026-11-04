import { Data } from 'effect';

/** The current remote route cannot establish catalog freshness; retry may restore it. */
export class FlockSyncUnavailableError extends Data.TaggedError('FlockSyncUnavailableError')<{
  message: string;
  reason: 'no-route' | 'transport-changed';
}> {}
