import { Effect } from 'effect';
import { KeyOutbox, KeyDeliveryRemote } from '../ports/key-delivery';
import { checkDeliveryId, selectDeliveryFrame, observeDelivery } from '../pure/key-delivery';

/** Internal shared engine. The bound client supplies authorization, not application callers. */
export function deliverFrame<E, R>(
  id: string,
  frame: Uint8Array | undefined,
  authorize: (bytes: Uint8Array) => Effect.Effect<void, E, R>,
  prepare?: Effect.Effect<Uint8Array, E, R>
) {
  const proposed = frame === undefined ? undefined : new Uint8Array(frame);
  return Effect.gen(function* () {
    yield* checkDeliveryId(id);
    const outbox = yield* KeyOutbox;
    const remote = yield* KeyDeliveryRemote;
    return yield* outbox.exclusive((tx) =>
      Effect.gen(function* () {
        const saved = yield* tx.load(id);
        const candidate =
          !saved && proposed === undefined && prepare !== undefined ? yield* prepare : proposed;
        const bytes = yield* selectDeliveryFrame(saved, candidate);
        yield* authorize(new Uint8Array(bytes));
        if (!saved) yield* tx.save(id, new Uint8Array(bytes));
        yield* authorize(new Uint8Array(bytes));
        // Only transport failures are uncertain delivery. Defects, validation errors
        // and fiber interruption propagate and never masquerade as Pending.
        yield* remote
          .put(id, new Uint8Array(bytes))
          .pipe(Effect.catchTag('TransportError', () => Effect.void));
        const observed = yield* remote
          .read(id)
          .pipe(Effect.catchTag('TransportError', () => Effect.succeed(null)));
        return observeDelivery(bytes, observed);
      })
    );
  }).pipe(Effect.withSpan('e2ee.key-delivery'));
}
