import { Cause, Deferred, Effect, Fiber, Queue, Result, Schedule } from 'effect';
import { z } from 'zod';
import type {
  E2eeDispatchAck,
  E2eeDispatchInput,
  E2eePreparedDispatch,
} from '@lody/shared/e2ee-rpc';
import {
  isTransientGatewayStatus,
  TRANSIENT_GATEWAY_RETRY_DELAYS_MS,
} from '@lody/shared/transient-gateway';
import type {
  LoroJsonStreamState,
  LoroStreamsJsonStreamClient,
  LoroJsonLiveBatchHandler,
} from './rpc';
import { e2eeRpcRequestStream, e2eeRpcResponseStream } from './e2ee-resource';

const envelopeSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  frame: z
    .string()
    .min(286)
    .max(2 * 1024 * 1024)
    .regex(/^(?:[0-9a-f]{2})+$/),
});
/** Random correlation ID and signed ciphertext only; transport metadata is never authority. */
export function e2eeRpcEnvelope(input: unknown) {
  return envelopeSchema.parse(input);
}
export type E2eeRpcTiming = {
  stage:
    | 'send'
    | 'append-start'
    | 'append-complete'
    | 'target-receive'
    | 'verified'
    | 'journal'
    | 'handler-start';
  requestId: string;
  at: number;
  userTurnId?: string;
};

const gatewayStatus = (cause: unknown) =>
  cause instanceof Error && 'status' in cause ? cause.status : undefined;
/**
 * Retry on an explicit gateway 502/503/504 with the shared short backoff; refusals, other
 * statuses and raw network failures fail at once. Envelope appends are idempotent by id:
 * receivers journal the exact original and requesters settle a request id once.
 * Interrupting the caller (its receipt timeout or scope close) stops the retries.
 */
export const retryTransientGateway = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    for (const delay of TRANSIENT_GATEWAY_RETRY_DELAYS_MS) {
      const attempt = yield* Effect.result(effect);
      if (Result.isSuccess(attempt)) return attempt.success;
      if (!isTransientGatewayStatus(gatewayStatus(attempt.failure)))
        return yield* Effect.fail(attempt.failure);
      yield* Effect.sleep(delay);
    }
    return yield* effect;
  });

/**
 * Deliver signed envelopes to response streams. A stream is ensured once per owner; a
 * missing stream (404) is re-ensured and appended once more. Ensure and append share
 * {@link retryTransientGateway}. `admit` runs right before every append and may throw.
 */
export const makeEncryptedStreamsEnvelopeDelivery = (client: LoroStreamsJsonStreamClient) => {
  const ensured = new Set<string>();
  const ensureOnce = async (stream: string) => {
    await client.ensureJsonStream(stream, 86400);
    if (ensured.size >= 128) ensured.clear();
    ensured.add(stream);
  };
  const attempt = (work: () => Promise<void>) =>
    retryTransientGateway(Effect.tryPromise({ try: work, catch: (cause) => cause }));
  return {
    ensure: (stream: string) =>
      attempt(async () => {
        if (!ensured.has(stream)) await ensureOnce(stream);
      }),
    deliver: (stream: string, envelope: { id: string; frame: string }, admit?: () => void) =>
      attempt(async () => {
        const value = e2eeRpcEnvelope(envelope);
        if (!ensured.has(stream)) await ensureOnce(stream);
        admit?.();
        try {
          await client.appendJson(stream, value);
        } catch (cause) {
          ensured.delete(stream);
          if (gatewayStatus(cause) !== 404) throw cause;
          await ensureOnce(stream);
          admit?.();
          await client.appendJson(stream, value);
        }
      }),
  };
};

// Aborting an Effect waiter is not completion of the raw SDK read. Keep its
// cancellation controller and await iterator/body cleanup before token release.
const readOwned = (
  client: LoroStreamsJsonStreamClient,
  stream: string,
  state: LoroJsonStreamState,
  onBatch: LoroJsonLiveBatchHandler
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => ({
      controller: new AbortController(),
      raw: undefined as Promise<void> | undefined,
    })),
    (owner) =>
      Effect.tryPromise({
        try: () => {
          owner.raw = client.readJsonLive(stream, state, onBatch, {
            signal: owner.controller.signal,
          });
          return owner.raw;
        },
        catch: () => new Error('e2ee_rpc_transport'),
      }),
    (owner) =>
      Effect.promise(async () => {
        owner.controller.abort();
        await owner.raw?.catch(() => undefined);
      })
  );

/** One scoped shared response reader, with independently bounded pending calls.
 * Native verification runs before a receipt can settle a waiter. A timeout leaves
 * the saved original and durable dispatch intact, and never resends a new intent. */
export const makeEncryptedStreamsChannel = Effect.fnUntraced(function* <Input, Output>(options: {
  workspaceId: string;
  requesterDevice: string;
  client: LoroStreamsJsonStreamClient;
  acceptResponse: (
    prepared: E2eePreparedDispatch,
    input: Input,
    frame: string
  ) => Promise<Output | undefined>;
  trace?: (event: E2eeRpcTiming) => void;
  traceInput?: (input: Input) => string | undefined;
}) {
  const scope = yield* Effect.scope;
  const responseStream = e2eeRpcResponseStream(options.workspaceId, options.requesterDevice);
  const pending = new Map<
    string,
    {
      prepared: E2eePreparedDispatch;
      input: Input;
      result: Deferred.Deferred<Output>;
    }
  >();
  const state: LoroJsonStreamState = { nextOffset: '0' };
  let closed = false;
  let responseNeedsEnsure = true;
  const replies = yield* Queue.dropping<{
    envelope: z.infer<typeof envelopeSchema>;
    call: NonNullable<ReturnType<typeof pending.get>>;
  }>(128);
  for (let worker = 0; worker < 4; worker++)
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          if (closed) return;
          const { envelope, call } = yield* Queue.take(replies);
          if (closed) return;
          if (pending.get(envelope.id) !== call) continue;
          const verified = yield* Effect.tryPromise({
            try: () => options.acceptResponse(call.prepared, call.input, envelope.frame),
            catch: () => new Error('e2ee_rpc_response_invalid'),
          }).pipe(Effect.result);
          if (
            verified._tag === 'Success' &&
            verified.success !== undefined &&
            !closed &&
            pending.get(envelope.id) === call
          )
            yield* Deferred.succeed(call.result, verified.success);
        }
      }),
      scope
    );
  const trace = (stage: E2eeRpcTiming['stage'], prepared: E2eePreparedDispatch, input: Input) => {
    try {
      options.trace?.({
        stage,
        requestId: prepared.requestId,
        userTurnId: options.traceInput?.(input),
        at: Date.now(),
      });
    } catch {
      /* Observational only. */
    }
  };
  const read = readOwned(options.client, responseStream, state, (batch) => {
    for (const message of batch.messages) {
      if (closed) return;
      const parsed = envelopeSchema.safeParse(message);
      if (!parsed.success) continue;
      const call = pending.get(parsed.data.id);
      if (!call) continue;
      Queue.offerUnsafe(replies, { envelope: parsed.data, call });
    }
  }).pipe(
    Effect.catch(() => {
      responseNeedsEnsure = true;
      return Effect.sleep('1 second');
    })
  );
  const reader = yield* Effect.forkIn(
    Effect.gen(function* () {
      while (true) {
        if (closed) return;
        if (responseNeedsEnsure) {
          yield* Effect.tryPromise({
            try: () => options.client.ensureJsonStream(responseStream, 86400),
            catch: () => new Error('e2ee_rpc_response_transport'),
          }).pipe(Effect.retry(Schedule.spaced('1 second')));
          responseNeedsEnsure = false;
        }
        yield* read;
      }
    }),
    scope
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      for (const call of pending.values()) yield* Deferred.interrupt(call.result);
      pending.clear();
      yield* Fiber.interrupt(reader);
    })
  );
  return {
    /** Receipt timeout is an acceleration budget; the caller always keeps durable dispatch active. */
    send: (prepared: E2eePreparedDispatch, input: Input, timeoutMs = 800) =>
      Effect.gen(function* () {
        if (
          closed ||
          prepared.requesterDevice !== options.requesterDevice ||
          pending.size >= 128 ||
          pending.has(prepared.requestId)
        )
          return null;
        const result = yield* Deferred.make<Output>();
        const call = { prepared, input, result };
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            pending.set(prepared.requestId, call);
            trace('send', prepared, input);
          }),
          () =>
            Effect.gen(function* () {
              trace('append-start', prepared, input);
              const stream = yield* Effect.try({
                try: () => e2eeRpcRequestStream(options.workspaceId, prepared.targetMachineId),
                catch: () => new Error('e2ee_rpc_append'),
              });
              for (const frame of prepared.frames ?? [prepared.frameHex])
                yield* retryTransientGateway(
                  Effect.tryPromise({
                    try: () =>
                      options.client.appendJson(
                        stream,
                        e2eeRpcEnvelope({ id: prepared.requestId, frame })
                      ),
                    catch: (cause) => cause,
                  })
                );
              trace('append-complete', prepared, input);
              return yield* Deferred.await(result);
            }).pipe(
              Effect.timeout(timeoutMs),
              Effect.catch(() => Effect.succeed(null))
            ),
          () =>
            Effect.sync(() => {
              if (pending.get(prepared.requestId) === call) pending.delete(prepared.requestId);
            })
        );
      }),
  };
});

/** Dispatch keeps its typed receipt contract over the shared encrypted channel. */
export const makeEncryptedStreamsRpc = (options: {
  workspaceId: string;
  requesterDevice: string;
  client: LoroStreamsJsonStreamClient;
  acceptResponse: (
    prepared: E2eePreparedDispatch,
    input: E2eeDispatchInput,
    frame: string
  ) => Promise<E2eeDispatchAck>;
  trace?: (event: E2eeRpcTiming) => void;
}) =>
  makeEncryptedStreamsChannel({
    ...options,
    traceInput: (input: E2eeDispatchInput) => input.userTurnId,
  });

/** Native receive owner: four bounded handlers, one stream reader, no network wait
 * in workspace startup. A bad request or failed ACK never stops sibling intake. */
export const makeEncryptedRpcListener = Effect.fnUntraced(function* (options: {
  workspaceId: string;
  machineId: string;
  client: LoroStreamsJsonStreamClient;
  receive: (envelope: { id: string; frame: string }) => Effect.Effect<void, unknown>;
  onFailure?: () => void;
  trace?: (event: E2eeRpcTiming) => void;
}) {
  const scope = yield* Effect.scope;
  const queue = yield* Queue.dropping<z.infer<typeof envelopeSchema>>(128);
  const stream = e2eeRpcRequestStream(options.workspaceId, options.machineId);
  const state: LoroJsonStreamState = { nextOffset: '0' };
  let closed = false;
  let needsEnsure = true;
  for (let worker = 0; worker < 4; worker++)
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          if (closed) return;
          const envelope = yield* Queue.take(queue);
          if (closed) return;
          yield* Effect.suspend(() => options.receive(envelope)).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.sync(() => {
                    try {
                      options.onFailure?.();
                    } catch {
                      /* Diagnostics never own intake. */
                    }
                  })
            )
          );
        }
      }),
      scope
    );
  yield* Effect.forkIn(
    Effect.gen(function* () {
      while (true) {
        if (closed) return;
        if (needsEnsure) {
          yield* Effect.tryPromise({
            try: () => options.client.ensureJsonStream(stream, 86400),
            catch: () => new Error('e2ee_rpc_transport'),
          }).pipe(Effect.retry(Schedule.spaced('1 second')));
          needsEnsure = false;
        }
        yield* readOwned(options.client, stream, state, (batch) => {
          if (closed) return;
          for (const message of batch.messages) {
            const parsed = envelopeSchema.safeParse(message);
            if (parsed.success) {
              try {
                options.trace?.({
                  stage: 'target-receive',
                  requestId: parsed.data.id,
                  at: Date.now(),
                });
              } catch {
                /* Observation only. */
              }
              Queue.offerUnsafe(queue, parsed.data);
            }
          }
        }).pipe(
          Effect.catch(() => {
            needsEnsure = true;
            return Effect.sleep('1 second');
          })
        );
      }
    }),
    scope
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    })
  );
});
