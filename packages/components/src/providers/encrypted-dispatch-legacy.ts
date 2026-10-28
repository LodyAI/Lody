import { Effect, Exit, Fiber, Scope } from 'effect';
import { isE2eeReadQuery, type E2eeReadQueryMethod } from '@lody/shared/e2ee-rpc';
import type {
  E2eeDispatchInput,
  E2eeDispatchAck,
  E2eePreparedDispatch,
  E2eeQueryInput,
  E2eeQueryResult,
} from '@lody/shared/e2ee-rpc';
import type { LoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import { makeEncryptedStreamsRpc } from '@lody/loro-streams-rpc/e2ee-streams';

type Input =
  | { kind: 'dispatch'; input: E2eeDispatchInput }
  | { kind: 'query'; input: E2eeQueryInput };
type Output = E2eeDispatchAck | E2eeQueryResult;
type Channel = Effect.Success<ReturnType<typeof makeEncryptedStreamsRpc<Input, Output>>>;

/** Promise boundary for the existing renderer runtime. The native kernel owns
 * its shared reader and pending calls; close cancels transport before token disposal. */
export function createEncryptedDispatchLegacy(options: {
  workspaceId: string;
  prepare: (machineId: string, input: E2eeDispatchInput) => Promise<E2eePreparedDispatch>;
  accept: (machineId: string, input: E2eeDispatchInput, frame: string) => Promise<E2eeDispatchAck>;
  prepareQuery?: (machineId: string, input: E2eeQueryInput) => Promise<E2eePreparedDispatch>;
  acceptQueryResponse?: (
    machineId: string,
    input: E2eeQueryInput,
    frame: string
  ) => Promise<E2eeQueryResult | null>;
  closeClient?: () => Promise<void>;
  client: (signal: AbortSignal) => Promise<LoroStreamsJsonStreamClient>;
}) {
  const scope = Scope.makeUnsafe();
  const controller = new AbortController();
  let closed = false;
  let device: string | undefined;
  let flight: Fiber.Fiber<Channel, unknown> | undefined;
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
            return yield* makeEncryptedStreamsRpc<Input, Output>({
              workspaceId: options.workspaceId,
              requesterDevice: prepared.requesterDevice,
              client,
              acceptResponse: (original, input, frame) =>
                input.kind === 'dispatch'
                  ? options.accept(original.targetMachineId, input.input, frame)
                  : options.acceptQueryResponse!(original.targetMachineId, input.input, frame),
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
              const reply = yield* client.send(original, { kind: 'dispatch', input });
              return reply && 'type' in reply ? reply : null;
            })
          ),
      };
    },
    query: async (
      machineId: string,
      method: string,
      params: unknown,
      timeoutMs: number
    ): Promise<E2eeQueryResult | null> => {
      if (
        closed ||
        !options.prepareQuery ||
        !options.acceptQueryResponse ||
        !isE2eeReadQuery(method, params)
      )
        throw new Error('e2ee_rpc_unavailable');
      const input: E2eeQueryInput = {
        queryId: crypto.randomUUID(),
        method: method as E2eeReadQueryMethod,
        params,
      };
      const original = await options.prepareQuery(machineId, input);
      const reply = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* channel(original);
          return yield* client.send(
            original,
            { kind: 'query', input },
            Math.min(timeoutMs, 60_000)
          );
        })
      );
      return reply && !('type' in reply) ? reply : null;
    },
    close: async () => {
      closed = true;
      controller.abort();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await options.closeClient?.();
    },
  };
}
