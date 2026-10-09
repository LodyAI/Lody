import { Effect, Layer } from 'effect';
import { KeyOutbox } from '../ports/key-delivery';
import { ValidationError } from '../pure/errors';
import { keyDeliveryRemoteLayer } from '../platform/key-delivery';
import { deliverFrame } from '../workflows/key-delivery';
import { runLegacy } from './compat';
import { LedgerError } from './error';

export { MemoryKeyOutbox as MemoryLedgerKeyOutbox } from '../platform/memory-stores';
export type LedgerKeyOutbox = KeyOutbox['Service'];

export interface LedgerKeyRemote {
  put(id: string, frame: Uint8Array): Promise<void>;
  read(id: string): Promise<Uint8Array | null>;
}

/** Exact-byte epoch envelope outbox. Retry never re-encrypts. */
export class LedgerKeyDelivery {
  constructor(
    private readonly outbox: LedgerKeyOutbox,
    private readonly remote: LedgerKeyRemote
  ) {}

  send(
    id: string,
    frame: Uint8Array | undefined,
    authorize: (frame: Uint8Array) => void | Promise<void>
  ): Promise<'observed' | 'unknown'> {
    return runLegacy(this.sendEffect(id, frame, authorize));
  }

  sendEffect(
    id: string,
    frame: Uint8Array | undefined,
    authorize: (frame: Uint8Array) => void | Promise<void>
  ) {
    return deliverFrame(id, frame, (bytes) =>
      Effect.tryPromise({
        try: () => Promise.resolve(authorize(bytes)),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          error instanceof LedgerError
            ? Effect.fail(new ValidationError({ code: error.code, position: error.position }))
            : Effect.die(error)
        )
      )
    ).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(KeyOutbox, this.outbox), keyDeliveryRemoteLayer(this.remote))
      ),
      Effect.map((result): 'observed' | 'unknown' =>
        result._tag === 'Observed' ? 'observed' : 'unknown'
      ),
      Effect.catchTag('ValidationError', (error) =>
        Effect.fail(new LedgerError(error.code, error.position))
      )
    );
  }
}
