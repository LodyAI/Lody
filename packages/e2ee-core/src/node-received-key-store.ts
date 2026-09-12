import {
  inspectKeyEnvelope,
  type KeyEnvelopeContext,
  type KeyRecipient,
  MAX_KEY_ENVELOPE_BYTES,
} from './key-envelope';
import { OrgKeyExchange } from './org-key-exchange';
import { SqliteTextStore } from './node-text-store';
import { checkHex, fromHex, invariant, toHex } from './wire';

const FORMAT = 'lody-received-keys/v1';
const MAX_KEYS = 4096;

/** Stores original HPKE ciphertext only. Its recipient private key must already be
 * durably OS-protected by the device identity store. This is NOT a recovery backup. */
export class SqliteReceivedKeyStore {
  private readonly store: SqliteTextStore;
  private readonly recipient: KeyRecipient;
  constructor(
    path: string,
    private readonly genesis: string,
    recipient: KeyRecipient
  ) {
    checkHex(genesis, 32);
    this.recipient = {
      kind: recipient.kind,
      actor: recipient.actor,
      memberInstance: recipient.memberInstance,
      id: recipient.id,
    };
    invariant(
      recipient.kind === 'device' || recipient.kind === 'recovery',
      'invalid-key-recipient'
    );
    for (const id of [recipient.actor, recipient.memberInstance, recipient.id])
      invariant(
        typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id),
        'invalid-key-identity'
      );
    this.store = new SqliteTextStore(path, 0x4c524b31, 1);
  }

  private matches(context: KeyEnvelopeContext): void {
    invariant(
      context.genesis === this.genesis &&
        context.recipient.kind === this.recipient.kind &&
        context.recipient.actor === this.recipient.actor &&
        context.recipient.memberInstance === this.recipient.memberInstance &&
        context.recipient.id === this.recipient.id,
      'received-key-scope-mismatch'
    );
  }

  private decode(text: string | null): Map<number, string> {
    if (text === null) return new Map();
    const data: unknown = JSON.parse(text);
    invariant(
      Array.isArray(data) &&
        data.length === 4 &&
        data[0] === FORMAT &&
        data[1] === this.genesis &&
        data[2] === JSON.stringify(this.recipient) &&
        Array.isArray(data[3]) &&
        data[3].length <= MAX_KEYS,
      'invalid-received-key-store'
    );
    const entries = new Map<number, string>();
    for (const hex of data[3]) {
      invariant(
        typeof hex === 'string' && hex.length <= MAX_KEY_ENVELOPE_BYTES * 2,
        'invalid-key-envelope'
      );
      checkHex(hex);
      const context = inspectKeyEnvelope(fromHex(hex));
      this.matches(context);
      invariant(!entries.has(context.epoch), 'received-epoch-reused');
      entries.set(context.epoch, hex);
    }
    invariant(this.encode(entries) === text, 'noncanonical-received-key-store');
    return entries;
  }

  private encode(entries: Map<number, string>): string {
    invariant(entries.size <= MAX_KEYS, 'received-key-store-full');
    return JSON.stringify([
      FORMAT,
      this.genesis,
      JSON.stringify(this.recipient),
      [...entries.entries()].sort(([a], [b]) => a - b).map(([, hex]) => hex),
    ]);
  }

  /** Verifies before the first save and again afterward. A failed final check may leave
   * ciphertext on disk, never plaintext or restored membership. No key installation occurs. */
  async receive(
    context: KeyEnvelopeContext,
    frame: Uint8Array,
    keys: CryptoKeyPair,
    exchange: OrgKeyExchange
  ): Promise<void> {
    this.matches(context);
    invariant(
      frame instanceof Uint8Array && frame.length <= MAX_KEY_ENVELOPE_BYTES,
      'invalid-key-envelope'
    );
    const bytes = new Uint8Array(frame);
    const expected = structuredClone(context);
    const recipientKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey };
    const verified = await exchange.open(expected, bytes, recipientKeys);
    verified.fill(0);
    const saved = await this.store.exclusive(async (tx) => {
      const entries = this.decode(await tx.load());
      // First authenticated ciphertext wins; re-encryption of the same committed key is normal.
      const existing = entries.get(expected.epoch);
      if (existing !== undefined) return fromHex(existing);
      entries.set(expected.epoch, toHex(bytes));
      await tx.save(this.encode(entries));
      return bytes;
    });
    // An existing disk entry is untrusted too; do not inherit success from its index.
    const checked = await exchange.open(inspectKeyEnvelope(saved), saved, recipientKeys);
    checked.fill(0);
  }

  /** Re-verifies historic sender, current recipient and commitment after every restart.
   * The caller owns temporary-secret erasure and runtime installation. */
  async restore(epoch: number, keys: CryptoKeyPair, exchange: OrgKeyExchange): Promise<Uint8Array> {
    invariant(Number.isSafeInteger(epoch) && epoch >= 0, 'invalid-key-epoch');
    const recipientKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey };
    const bytes = await this.store.exclusive(async (tx) => {
      const hex = this.decode(await tx.load()).get(epoch);
      invariant(hex !== undefined, 'missing-received-key');
      return fromHex(hex);
    });
    return exchange.open(inspectKeyEnvelope(bytes), bytes, recipientKeys);
  }
}
