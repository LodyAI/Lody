import { Effect, Layer } from 'effect';
import type { LedgerKeyRemote } from '../ledger/delivery';
import { LedgerError } from '../ledger/error';
import { KeyDeliveryRemote } from '../ports/key-delivery';
import { TransportError, ValidationError } from '../pure/errors';

export function keyDeliveryRemoteLayer(remote: LedgerKeyRemote): Layer.Layer<KeyDeliveryRemote> {
  const call = <A>(operation: 'read' | 'deliver', work: () => Promise<A>) =>
    Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
      Effect.catch((error): Effect.Effect<never, TransportError | ValidationError> => {
        if (error instanceof LedgerError)
          return Effect.fail(new ValidationError({ code: error.code, position: error.position }));
        if (error instanceof TypeError || error instanceof ReferenceError) return Effect.die(error);
        return Effect.fail(new TransportError({ operation }));
      })
    );
  return Layer.succeed(KeyDeliveryRemote, {
    put: (id, bytes) => {
      const owned = new Uint8Array(bytes);
      return call('deliver', () => remote.put(id, new Uint8Array(owned)));
    },
    read: (id) =>
      call('read', () => remote.read(id)).pipe(
        Effect.map((bytes) => (bytes === null ? null : new Uint8Array(bytes)))
      ),
  });
}
