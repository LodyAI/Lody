import type { ISession } from '@/session/session-manager';
import { Effect } from 'effect';
import type { ExecutionResource } from '../inbox/execution-owner';

/** Registered Session/ACP adapter. Acquisition callbacks must journal before spawning. */
export const sessionExecutionResource = (session: ISession): ExecutionResource => {
  const observe = session.watchInboxRecoveryResources?.bind(session);
  return {
    key: session,
    observesAcquisitions: !!observe,
    terminate: Effect.tryPromise({ try: () => session.terminate(true), catch: (cause) => cause }),
    observe: (update) =>
      observe
        ? Effect.tryPromise({
            try: async () => {
              const detach = await observe((identity) => {
                Effect.runSync(update(identity));
              });
              return Effect.sync(detach);
            },
            catch: (cause) => cause,
          })
        : Effect.succeed(Effect.void),
  };
};
