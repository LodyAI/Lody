import { Effect, Exit, Fiber, Scope } from 'effect';
import type {
  E2eeDispatchInput,
  E2eeDispatchAck,
  E2eePreparedDispatch,
} from '@lody/shared/e2ee-rpc';
import type { LoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import { makeEncryptedStreamsRpc } from '@lody/loro-streams-rpc/e2ee-streams';

/** Promise boundary for the existing renderer runtime. The native kernel owns
 * its shared reader and pending calls; close cancels transport before token disposal. */
export function createEncryptedDispatchLegacy(options: {
  workspaceId: string;
  prepare: (machineId: string, input: E2eeDispatchInput) => Promise<E2eePreparedDispatch>;
  accept: (machineId: string, input: E2eeDispatchInput, frame: string) => Promise<E2eeDispatchAck>;
  client: (signal: AbortSignal) => Promise<LoroStreamsJsonStreamClient>;
}) {
  const scope = Scope.makeUnsafe();
  const controller = new AbortController();
  let closed = false;
  let device: string | undefined;
  let flight:
    | Fiber.Fiber<Effect.Success<ReturnType<typeof makeEncryptedStreamsRpc>>, unknown>
    | undefined;
  const channel = (prepared: E2eePreparedDispatch) =>
    Effect.gen(function* () {
      if (closed || (device && device !== prepared.requesterDevice))
        return yield* Effect.fail(new Error('e2ee_rpc_closed'));
      if (!flight) {
        device = prepared.requesterDevice;
        flight = yield* Effect.forkIn(
          Effect.gen(function* () {
            const client = yield* Effect.tryPromise({
              try: () => options.client(controller.signal),
              catch: () => new Error('e2ee_rpc_transport'),
            });
            return yield* makeEncryptedStreamsRpc({
              workspaceId: options.workspaceId,
              requesterDevice: prepared.requesterDevice,
              client,
              acceptResponse: (original, input, frame) =>
                options.accept(original.targetMachineId, input, frame),
              trace: (event) => console.debug('[e2ee-rpc-timing]', event),
            }).pipe(Scope.provide(scope));
          }),
          scope
        );
      }
      const selected = flight;
      return yield* Fiber.join(selected).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            if (flight === selected) flight = undefined;
          })
        )
      );
    });
  return {
    prepare: async (machineId: string, input: E2eeDispatchInput) => {
      if (closed) throw new Error('e2ee_rpc_closed');
      const started = Date.now();
      const original = await Effect.runPromise(
        Effect.tryPromise({
          try: () => options.prepare(machineId, input),
          catch: () => new Error('e2ee_rpc_prepare'),
        }).pipe(Effect.timeout('200 millis'))
      );
      if (closed) throw new Error('e2ee_rpc_closed');
      console.debug('[e2ee-rpc-timing]', {
        stage: 'send',
        requestId: original.requestId,
        userTurnId: input.userTurnId,
        at: started,
      });
      return {
        original,
        send: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const client = yield* channel(original);
              return yield* client.send(original, input);
            })
          ),
      };
    },
    close: () => {
      closed = true;
      controller.abort();
      return Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}
