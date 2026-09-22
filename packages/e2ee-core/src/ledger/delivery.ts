import { Effect, Layer } from 'effect';
import { runPromiseThrow } from '../effect-run';
import { copyBytes } from './cbor';
import { LedgerError } from './error';
import { deliverFrame } from '../workflows/key-delivery';
import { ValidationError } from '../pure/errors';
import { keyOutboxLayer, keyDeliveryRemoteLayer } from '../platform/key-delivery';

export interface LedgerKeyOutbox {
  exclusive<T>(
    work: (tx: {
      load(id: string): Promise<Uint8Array | null>;
      save(id: string, frame: Uint8Array): Promise<void>;
    }) => Promise<T>
  ): Promise<T>;
}

export interface LedgerKeyRemote {
  put(id: string, frame: Uint8Array): Promise<void>;
  read(id: string): Promise<Uint8Array | null>;
}

export class MemoryLedgerKeyOutbox implements LedgerKeyOutbox {
  readonly frames = new Map<string, Uint8Array>();
  private queue: Promise<void> = Promise.resolve();

  async exclusive<T>(
    work: (tx: {
      load(id: string): Promise<Uint8Array | null>;
      save(id: string, frame: Uint8Array): Promise<void>;
    }) => Promise<T>
  ): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work({
        load: async (id) => {
          const saved = this.frames.get(id);
          return saved === undefined ? null : copyBytes(saved);
        },
        save: async (id, frame) => {
          this.frames.set(id, copyBytes(frame));
        },
      });
    } finally {
      release();
    }
  }
}

/** Exact-byte epoch envelope outbox. Retry never re-encrypts. */
export class LedgerKeyDelivery {
  constructor(
    private readonly outbox: LedgerKeyOutbox,
    private readonly remote: LedgerKeyRemote
  ) {}

  async send(
    id: string,
    frame: Uint8Array | undefined,
    authorize: (frame: Uint8Array) => void | Promise<void>
  ): Promise<'observed' | 'unknown'> {
    return runPromiseThrow(this.sendEffect(id, frame, authorize));
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
        Effect.catchAll((error) =>
          error instanceof LedgerError
            ? Effect.fail(new ValidationError({ code: error.code, position: error.position }))
            : Effect.die(error)
        )
      )
    ).pipe(
      Effect.provide(Layer.merge(keyOutboxLayer(this.outbox), keyDeliveryRemoteLayer(this.remote))),
      Effect.map((result): 'observed' | 'unknown' =>
        result._tag === 'Observed' ? 'observed' : 'unknown'
      ),
      Effect.catchTag('ValidationError', (error) =>
        Effect.fail(new LedgerError(error.code, error.position))
      )
    );
  }
}
