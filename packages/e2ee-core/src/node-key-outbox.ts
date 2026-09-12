import type { KeyDeliveryStore } from './key-delivery';
import { inspectKeyEnvelope, MAX_KEY_ENVELOPE_BYTES } from './key-envelope';
import { SqliteTextStore } from './node-text-store';
import { checkHex, fromHex, invariant } from './wire';

const FORMAT = 'lody-key-outbox/v1';
/** Org-bound ciphertext only. Every dispatch must still verify history and current authority. */
export class SqliteKeyDeliveryStore implements KeyDeliveryStore {
  private readonly store: SqliteTextStore;
  constructor(
    path: string,
    private readonly genesis: string
  ) {
    checkHex(genesis, 32);
    this.store = new SqliteTextStore(path, 0x4c4b4431, 1);
  }
  private validate(id: string, hex: string): void {
    checkHex(id, 16);
    invariant(
      typeof hex === 'string' && hex.length <= MAX_KEY_ENVELOPE_BYTES * 2,
      'invalid-key-envelope'
    );
    checkHex(hex);
    invariant(
      inspectKeyEnvelope(fromHex(hex)).genesis === this.genesis,
      'key-outbox-anchor-mismatch'
    );
  }
  exclusive<T>(
    work: (tx: {
      load(id: string): Promise<string | null>;
      save(id: string, frameHex: string): Promise<void>;
    }) => Promise<T>
  ): Promise<T> {
    return this.store.exclusive(async (tx) => {
      const text = await tx.load();
      const entries = new Map<string, string>();
      const encode = (values: Map<string, string>) =>
        JSON.stringify([
          FORMAT,
          this.genesis,
          [...values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ]);
      if (text !== null) {
        const data: unknown = JSON.parse(text);
        invariant(
          Array.isArray(data) &&
            data.length === 3 &&
            data[0] === FORMAT &&
            data[1] === this.genesis &&
            Array.isArray(data[2]) &&
            data[2].length <= 4096,
          'invalid-key-outbox'
        );
        for (const row of data[2]) {
          invariant(
            Array.isArray(row) &&
              row.length === 2 &&
              typeof row[0] === 'string' &&
              typeof row[1] === 'string',
            'invalid-key-outbox'
          );
          this.validate(row[0], row[1]);
          invariant(!entries.has(row[0]), 'key-delivery-id-reused');
          entries.set(row[0], row[1]);
        }
        invariant(encode(entries) === text, 'noncanonical-key-outbox');
      }
      let active = true;
      try {
        return await work({
          load: async (id) => {
            invariant(active, 'journal-transaction-ended');
            checkHex(id, 16);
            return entries.get(id) ?? null;
          },
          save: async (id, hex) => {
            invariant(active, 'journal-transaction-ended');
            this.validate(id, hex);
            invariant(!entries.has(id) || entries.get(id) === hex, 'key-delivery-id-reused');
            const next = new Map(entries).set(id, hex);
            invariant(next.size <= 4096, 'key-outbox-full');
            await tx.save(encode(next));
            entries.set(id, hex);
          },
        });
      } finally {
        active = false;
      }
    });
  }
}
