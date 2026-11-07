import type { ISession } from '@/session/session-manager';
import { Effect } from 'effect';
import type { ExecutionResource } from '../inbox/execution-owner';

/** Registered Session/ACP adapter for bounded background cleanup. */
export const sessionExecutionResource = (session: ISession): ExecutionResource => ({
  key: session,
  terminate: Effect.tryPromise({ try: () => session.terminate(true), catch: (cause) => cause }),
});
