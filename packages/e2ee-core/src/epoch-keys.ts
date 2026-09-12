import { checkHex, fromHex, invariant, toHex } from './wire';
import { ContentCipher, type ContentAuthor, type ContentScope } from './content';

export interface EpochHistoryInput {
  readonly genesis: string;
  readonly epoch: number;
  readonly epochKey: Uint8Array;
  readonly previousKey: Uint8Array;
  readonly author: ContentAuthor;
  readonly signingKey: CryptoKey;
}
const MAX_HISTORY_BYTES = 2 + 4096 + 24 + 32 + 16 + 64;
function historyScope(genesis: string, epoch: number): ContentScope {
  epochNumber(epoch);
  invariant(epoch > 0, 'no-previous-epoch');
  return { genesis, epoch, resource: 'previous-epoch-key', purpose: 'epoch-history' };
}

/** Prepare N -> N-1 only. Caller owns candidate durability/publication and sender authorization. */
export function sealEpochHistory(
  cipher: ContentCipher,
  input: EpochHistoryInput
): Promise<Uint8Array> {
  const scope = historyScope(input.genesis, input.epoch);
  invariant(
    input.previousKey instanceof Uint8Array && input.previousKey.length === 32,
    'invalid-epoch-key'
  );
  return cipher.seal({
    scope,
    author: input.author,
    signingKey: input.signingKey,
    epochKey: input.epochKey,
    plaintext: input.previousKey,
  });
}

/** Require a verified Owner/Admin publication commitment and current local eligibility, or throw.
 * This port must not read unverified metadata, trust a login token or silently refresh expiry. */
export interface EpochKeyPolicy {
  commitment(epoch: number): string;
}

function epochNumber(epoch: number) {
  invariant(Number.isSafeInteger(epoch) && epoch >= 0, 'invalid-key-epoch');
}

/** No epoch in the digest: reusing a key in the same Org reuses its commitment and is rejected. */
export async function commitEpochKey(genesis: string, secret: Uint8Array): Promise<string> {
  checkHex(genesis, 32);
  invariant(secret instanceof Uint8Array && secret.byteLength === 32, 'invalid-epoch-key');
  const domain = new TextEncoder().encode('lody-epoch-secret/v1\0');
  const bytes = new Uint8Array(domain.length + 64);
  bytes.set(domain);
  bytes.set(fromHex(genesis), domain.length);
  bytes.set(secret, domain.length + 32);
  try {
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  } finally {
    bytes.fill(0);
  }
}

/** Volatile verified keys, not a backup or persistent keystore. Call clear() on loss of eligibility. */
export class VerifiedEpochKeys {
  private readonly keys = new Map<number, { commitment: string; secret: Uint8Array }>();
  private generation = 0;
  constructor(
    private readonly genesis: string,
    private readonly policy: EpochKeyPolicy
  ) {
    checkHex(genesis, 32);
  }
  private expected(epoch: number): string {
    epochNumber(epoch);
    const commitment = this.policy.commitment(epoch);
    checkHex(commitment, 32);
    return commitment;
  }
  async install(epoch: number, secret: Uint8Array): Promise<void> {
    const generation = this.generation;
    const expected = this.expected(epoch);
    invariant(secret instanceof Uint8Array && secret.byteLength === 32, 'invalid-epoch-key');
    const copy = new Uint8Array(secret);
    try {
      invariant((await commitEpochKey(this.genesis, copy)) === expected, 'epoch-key-mismatch');
      invariant(this.expected(epoch) === expected, 'epoch-authority-changed');
      invariant(generation === this.generation, 'epoch-keys-cleared');
      const existing = this.keys.get(epoch);
      invariant(existing === undefined || existing.commitment === expected, 'epoch-key-conflict');
      if (!existing) this.keys.set(epoch, { commitment: expected, secret: new Uint8Array(copy) });
    } finally {
      copy.fill(0);
    }
  }
  read(epoch: number): Uint8Array {
    const expected = this.expected(epoch);
    const stored = this.keys.get(epoch);
    invariant(stored !== undefined, 'missing-content-key');
    invariant(stored.commitment === expected, 'epoch-authority-changed');
    return new Uint8Array(stored.secret);
  }
  /** Verify N -> N-1, verify the old key's ledger commitment, then install it.
   * No recursive network fetches; a missing intermediate epoch remains an explicit failure. */
  async importHistory(cipher: ContentCipher, epoch: number, frame: Uint8Array): Promise<void> {
    const scope = historyScope(this.genesis, epoch);
    invariant(
      frame instanceof Uint8Array && frame.length <= MAX_HISTORY_BYTES,
      'invalid-epoch-history'
    );
    const generation = this.generation;
    const key = this.read(epoch);
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = (await cipher.open(scope, key, frame)).plaintext;
      invariant(plaintext.length === 32, 'invalid-epoch-key');
      invariant(generation === this.generation, 'epoch-keys-cleared');
      // Current source authority may have changed while crypto was awaiting.
      const stillAuthorized = this.read(epoch);
      stillAuthorized.fill(0);
      await this.install(epoch - 1, plaintext);
    } finally {
      key.fill(0);
      plaintext?.fill(0);
    }
  }
  clear(): void {
    this.generation++;
    for (const key of this.keys.values()) key.secret.fill(0);
    this.keys.clear();
  }
}
