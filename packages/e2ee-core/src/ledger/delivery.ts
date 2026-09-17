import { Effect } from 'effect';
import { runPromiseThrow } from '../effect-run';
import { bytesEqual, copyBytes } from './cbor';
import { fail } from './error';

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
  ): Effect.Effect<'observed' | 'unknown', unknown> {
    if (!/^[0-9a-f]{32}$/.test(id)) fail('canonical');
    return Effect.tryPromise({
      try: (signal) =>
        this.outbox.exclusive(async (tx) => {
          const saved = await tx.load(id);
          if (saved && frame && !bytesEqual(saved, frame)) fail('replay');
          const bytes = saved ?? (frame ? copyBytes(frame) : null);
          if (!bytes) fail('invalid-operation');
          await authorize(bytes);
          if (!saved) await tx.save(id, bytes);
          // remote.put/read are not cancellable server-side; aborting the local
          // wait releases the outbox lock and the next send reconciles by read-back.
          await authorize(bytes);
          throwIfAborted(signal);
          try {
            await abortable(this.remote.put(id, copyBytes(bytes)), signal);
          } catch (error) {
            throwIfAborted(signal);
            void error;
            /* lost ACK: read back */
          }
          let observed: Uint8Array | null;
          try {
            observed = await abortable(this.remote.read(id), signal);
          } catch (error) {
            throwIfAborted(signal);
            void error;
            return 'unknown';
          }
          if (!observed || !bytesEqual(observed, bytes)) return 'unknown';
          return 'observed';
        }),
      catch: (error) => error,
    });
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new Error('interrupted');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortable<A>(promise: Promise<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
