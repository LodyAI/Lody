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
    if (!/^[0-9a-f]{32}$/.test(id)) fail('canonical');
    return this.outbox.exclusive(async (tx) => {
      const saved = await tx.load(id);
      if (saved && frame && !bytesEqual(saved, frame)) fail('replay');
      const bytes = saved ?? (frame ? copyBytes(frame) : null);
      if (!bytes) fail('invalid-operation');
      await authorize(bytes);
      if (!saved) await tx.save(id, bytes);
      await authorize(bytes);
      try {
        await this.remote.put(id, copyBytes(bytes));
      } catch {
        /* lost ACK: read back */
      }
      let observed: Uint8Array | null;
      try {
        observed = await this.remote.read(id);
      } catch {
        return 'unknown';
      }
      if (!observed || !bytesEqual(observed, bytes)) return 'unknown';
      return 'observed';
    });
  }
}
