import { Effect, Exit, Fiber, Scope } from 'effect';
import type {
  E2eeDispatchInput,
  E2eeDispatchAck,
  E2eePreparedDispatch,
} from '@lody/shared/e2ee-rpc';
import {
  type LocalMachineRpcRequest,
  type LocalMachineRpcResponse,
} from '@lody/shared/local-machine-rpc';
import type { E2eeFeatureInput } from '@lody/shared/e2ee-rpc';
import type { LoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import { callEncryptedReadFeature } from '@lody/loro-streams-rpc';
import { makeEncryptedStreamsChannel } from '@lody/loro-streams-rpc/e2ee-streams';

type Call =
  | { kind: 'dispatch'; input: E2eeDispatchInput }
  | {
      kind: 'feature';
      input: E2eeFeatureInput;
    };
type Reply = E2eeDispatchAck | LocalMachineRpcResponse;
type Channel = {
  send: (
    prepared: E2eePreparedDispatch,
    call: Call,
    timeoutMs?: number
  ) => Effect.Effect<Reply | null, unknown>;
};

/** Promise boundary for the existing renderer runtime. The native kernel owns
 * its shared reader and pending calls; close cancels transport before token disposal. */
export function createEncryptedDispatchLegacy(options: {
  workspaceId: string;
  prepare: (machineId: string, input: E2eeDispatchInput) => Promise<E2eePreparedDispatch>;
  accept: (machineId: string, input: E2eeDispatchInput, frame: string) => Promise<E2eeDispatchAck>;
  prepareFeature?: (input: E2eeFeatureInput) => Promise<E2eePreparedDispatch>;
  acceptFeature?: (
    input: E2eeFeatureInput,
    frame: string
  ) => Promise<LocalMachineRpcResponse | null>;
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
            return yield* makeEncryptedStreamsChannel<Call, Reply>({
              workspaceId: options.workspaceId,
              requesterDevice: prepared.requesterDevice,
              client,
              acceptResponse: async (original, call, frame) => {
                if (call.kind === 'dispatch')
                  return options.accept(original.targetMachineId, call.input, frame);
                if (!options.acceptFeature) throw new Error('e2ee_rpc_unavailable');
                return (await options.acceptFeature(call.input, frame)) ?? undefined;
              },
              traceInput: (call) => (call.kind === 'dispatch' ? call.input.userTurnId : undefined),
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
  const requestFeature = async (
    request: LocalMachineRpcRequest
  ): Promise<LocalMachineRpcResponse> => {
    if (closed || !options.prepareFeature || !options.acceptFeature)
      throw new Error('e2ee_rpc_unavailable');
    const input = { requestId: crypto.randomUUID().replaceAll('-', ''), request };
    const original = await options.prepareFeature(input);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* channel(original);
        return yield* client.send(
          original,
          { kind: 'feature', input },
          request.timeoutMs ?? 30_000
        );
      })
    );
    return result && 'ok' in result
      ? result
      : { ok: false, error: 'Encrypted machine request timed out.' };
  };
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
              const result = yield* client.send(original, { kind: 'dispatch', input });
              return result && 'type' in result ? result : null;
            })
          ),
      };
    },
    requestFeature,
    query: (machineId: string, method: string, params: unknown, timeoutMs: number) =>
      callEncryptedReadFeature({
        workspaceId: options.workspaceId,
        machineId,
        method,
        params,
        timeoutMs,
        request: requestFeature,
      }),
    close: async () => {
      closed = true;
      controller.abort();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await options.closeClient?.();
    },
  };
}
