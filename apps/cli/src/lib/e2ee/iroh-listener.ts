import { Effect, Semaphore } from 'effect';
import type { E2eeIrohRelays } from '@lody/platform';
import type { IrohNative, IrohRequest } from '@lody/iroh-native';
import { e2eeRpcEnvelope } from '@lody/loro-streams-rpc/e2ee-streams';
import type { EncryptedFeatureReplySink } from './feature-rpc';

/** Concurrent request handlers, matching the Streams listener's four workers. */
const HANDLERS = 4;

/**
 * Hands the machine device seed to `open` and wipes it afterwards; in production
 * this is node custody's `withTransportSeed` for the retained machine identity.
 */
export type WithTransportSeed = <A>(
  open: (seed: Uint8Array) => Promise<A>
) => Effect.Effect<A, unknown>;

/**
 * Machine-side encrypted RPC over iroh. The endpoint key is the machine's ledger
 * device key, so senders dial its signing public key. Each request carries the
 * same `{id, frame}` envelope as Streams; `handle` runs the existing receivers with
 * a sink that writes replies on the request's own stream. Transport identity is
 * never authority: the receivers verify every frame against the ledger.
 *
 * Runs until interrupted; the endpoint is closed by its finalizer. A pull loop
 * takes a handler permit before reading the next request, so at most
 * {@link HANDLERS} requests are in progress and the native queue applies
 * backpressure beyond that.
 */
export const runMachineIrohListener = Effect.fnUntraced(function* (options: {
  native: IrohNative;
  relays: E2eeIrohRelays;
  withSeed: WithTransportSeed;
  handle: (
    envelope: { id: string; frame: string },
    sink: EncryptedFeatureReplySink
  ) => Effect.Effect<void, unknown>;
  /** Observation only: the opened endpoint's id and current direct addresses. */
  onOpen?: (endpoint: { endpointId: string; directAddrs(): string[] }) => void;
}) {
  const endpoint = yield* Effect.acquireRelease(
    options.withSeed((seed) =>
      options.native.openEndpoint(Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength), {
        relayUrls: [...options.relays.urls],
        ...(options.relays.token ? { relayToken: options.relays.token } : {}),
        accept: true,
      })
    ),
    (endpoint) => Effect.promise(() => endpoint.close())
  );
  options.onOpen?.(endpoint);
  const permits = yield* Semaphore.make(HANDLERS);
  const scope = yield* Effect.scope;
  while (true) {
    yield* Semaphore.take(permits, 1);
    const request = yield* Effect.tryPromise({
      try: () => endpoint.nextRequest(),
      catch: () => new Error('iroh_listener_closed'),
    }).pipe(Effect.onError(() => Semaphore.release(permits, 1)));
    if (!request) {
      yield* Semaphore.release(permits, 1);
      return yield* Effect.fail(new Error('iroh_listener_closed'));
    }
    yield* Effect.forkIn(
      serveRequest(request, options.handle).pipe(Effect.ensuring(Semaphore.release(permits, 1))),
      scope
    );
  }
});

const serveRequest = (
  request: IrohRequest,
  handle: (
    envelope: { id: string; frame: string },
    sink: EncryptedFeatureReplySink
  ) => Effect.Effect<void, unknown>
) =>
  Effect.gen(function* () {
    const envelope = yield* Effect.try({
      try: () => e2eeRpcEnvelope(JSON.parse(request.body.toString('utf8'))),
      catch: () => new Error('e2ee_rpc_invalid'),
    });
    const sink: EncryptedFeatureReplySink = {
      deliver: (id, frame) =>
        request.reply(
          Buffer.from(
            JSON.stringify(e2eeRpcEnvelope({ id, frame: Buffer.from(frame).toString('hex') })),
            'utf8'
          )
        ),
      end: () => request.finish(),
    };
    yield* handle(envelope, sink);
  }).pipe(
    // A malformed or failed request ends its stream; the sender falls back to
    // Streams RPC with the same original, never a new one.
    Effect.catch(() => Effect.promise(() => request.finish().catch(() => undefined))),
    Effect.asVoid
  );
