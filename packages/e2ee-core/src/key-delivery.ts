import { OrgKeyExchange } from './org-key-exchange';
import { MAX_KEY_ENVELOPE_BYTES } from './key-envelope';
import { checkHex, fromHex, invariant, toHex } from './wire';

export interface KeyDeliveryStore {
  /** Exclusive across processes; exact ciphertext must be durable before save resolves. */
  exclusive<T>(
    work: (tx: {
      load(id: string): Promise<string | null>;
      save(id: string, frameHex: string): Promise<void>;
    }) => Promise<T>
  ): Promise<T>;
}
export interface KeyDeliveryRemote {
  /** Org-bound, idempotent exact-byte storage; must not overwrite a different value. */
  put(id: string, frame: Uint8Array): Promise<void>;
  read(id: string): Promise<Uint8Array | null>;
}

/** Ciphertext delivery only. "observed" is remote storage, never recipient installation. */
export class KeyDelivery {
  constructor(
    private readonly exchange: OrgKeyExchange,
    private readonly store: KeyDeliveryStore,
    private readonly remote: KeyDeliveryRemote
  ) {}

  /** Caller retains a random 16-byte delivery ID; omit frame to retry saved bytes after restart. */
  async send(id: string, frame?: Uint8Array): Promise<'observed' | 'unknown'> {
    checkHex(id, 16);
    if (frame !== undefined)
      invariant(
        frame instanceof Uint8Array && frame.length <= MAX_KEY_ENVELOPE_BYTES,
        'invalid-key-envelope'
      );
    const supplied = frame === undefined ? undefined : toHex(frame);
    return this.store.exclusive(async (tx) => {
      const saved = await tx.load(id);
      invariant(
        saved === null || supplied === undefined || saved === supplied,
        'key-delivery-id-reused'
      );
      const hex = saved ?? supplied;
      invariant(
        hex !== undefined && hex.length <= MAX_KEY_ENVELOPE_BYTES * 2,
        'missing-key-delivery'
      );
      checkHex(hex);
      const bytes = fromHex(hex);
      (await this.exchange.authorizeDispatch(bytes))();
      if (saved === null) await tx.save(id, hex);
      // Storage may await; recheck authority after durability, not only before it.
      const check = await this.exchange.authorizeDispatch(bytes);
      check();
      try {
        await this.remote.put(id, new Uint8Array(bytes));
      } catch {
        /* A lost response may follow remote persistence. Read back exact bytes. */
      }
      let observed: Uint8Array | null;
      try {
        observed = await this.remote.read(id);
      } catch {
        return 'unknown';
      }
      if (observed === null) return 'unknown';
      invariant(
        observed instanceof Uint8Array &&
          observed.length === bytes.length &&
          toHex(observed) === hex,
        'key-delivery-remote-mismatch'
      );
      return 'observed';
    });
  }
}
