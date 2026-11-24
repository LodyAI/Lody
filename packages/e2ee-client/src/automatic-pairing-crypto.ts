import { Effect, Semaphore } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { z } from 'zod';
import { fromHex, toHex } from './bytes';

/** Immutable, account/workspace-bound start of one automatic device verification. */
export const AutomaticPairingContextSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[0-9a-f]{32}$/),
    accountId: z.string().min(1).max(256),
    workspaceId: z.string().min(1).max(256),
    genesisHash: z.string().regex(/^[0-9a-f]{64}$/),
    deviceName: z.string().min(1).max(128),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
/** The start message is discovery only; it grants no access. */
export type AutomaticPairingContext = z.infer<typeof AutomaticPairingContextSchema>;
/** The responder commits before learning the requester's ephemeral public key. */
export const AutomaticPairingCommitmentSchema = z
  .object({
    peerId: z.string().regex(/^[0-9a-f]{32}$/),
    commitment: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
/** Only this public commitment may precede the requester's public key. */
export type AutomaticPairingCommitment = z.infer<typeof AutomaticPairingCommitmentSchema>;
/** A P-256 public-key reveal, never a private device or account key. */
export const AutomaticPairingRevealSchema = z
  .object({
    publicKey: z.string().regex(/^04[0-9a-f]{128}$/),
    nonce: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
/** The committed responder's public material. */
export type AutomaticPairingReveal = z.infer<typeof AutomaticPairingRevealSchema>;

const domain = 'lody-e2ee/automatic-pairing/v1';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const fail = () => Object.assign(new Error('e2ee_pairing-tampered'), { code: 'pairing-tampered' });
const contextBytes = (input: AutomaticPairingContext) => {
  const c = AutomaticPairingContextSchema.parse(input);
  return bytes([
    domain,
    c.version,
    c.id,
    c.accountId,
    c.workspaceId,
    c.genesisHash,
    c.deviceName,
    c.expiresAt,
  ]);
};
const join = (...arrays: readonly Uint8Array[]) => {
  const out = new Uint8Array(arrays.reduce((size, value) => size + value.length, 0));
  let offset = 0;
  for (const value of arrays) {
    out.set(value, offset);
    offset += value.length;
  }
  return out;
};
const arrayBuffer = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;

/** Ephemeral exchange owner. Dispose on account change or terminal settlement. */
export interface AutomaticPairingExchange {
  /** Public start frozen before any network request. */
  readonly context: AutomaticPairingContext;
  /** The responder's commitment; the requester has none. */
  readonly commitment?: AutomaticPairingCommitment;
  /** Requester: freezes the first commitment before revealing its key. A conflicting retry is refused. */
  requestKey(commitment: AutomaticPairingCommitment): Effect.Effect<string, unknown>;
  /** Responder: freezes the requester's key and returns the original reveal. */
  reveal(requesterKey: string): Effect.Effect<AutomaticPairingReveal, unknown>;
  /** Derives a request-bound secret and visual comparison code only after commitment verification. */
  finish(input: AutomaticPairingReveal | string): Effect.Effect<AutomaticPairingChannel, unknown>;
  /** Fences late operations and drops the opaque ephemeral key. */
  dispose(): void;
}
/** Temporary channel material. The pairing secret stays behind the application runtime port. */
export interface AutomaticPairingChannel {
  /** Six decimal digits; equal only after an untampered committed exchange, except bounded SAS guessing. */
  readonly comparisonCode: string;
  /** Borrowed 128-bit secret for the existing request/approval HMAC protocol. */
  readonly secret: Uint8Array;
  /** Wipes the secret when the owner no longer needs the channel. */
  dispose(): void;
}

/**
 * Commitment-based SAS bootstrap over WebCrypto P-256 ECDH, SHA-256 and HKDF.
 * The responder MUST commit before seeing the requester's key, as in the SAS
 * commitment pattern; no service status or device name authenticates a peer.
 * A person must compare the code on both devices before authorizing. Native
 * crypto settles before the owner permits disposal or publishing its result.
 */
export const makeAutomaticPairingExchange = Effect.fnUntraced(function* (options: {
  readonly context: AutomaticPairingContext;
  readonly role: 'requester' | 'approver';
  readonly crypto: Pick<Crypto, 'subtle' | 'getRandomValues'>;
}) {
  const context = Object.freeze(
    yield* Effect.try({
      try: () => AutomaticPairingContextSchema.parse(options.context),
      catch: () => fail(),
    })
  );
  const start = contextBytes(context);
  const { subtle } = options.crypto;
  const generated = yield* Effect.tryPromise({
    try: () => subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    catch: () =>
      Object.assign(new Error('e2ee_pairing-unavailable'), { code: 'pairing-unavailable' }),
  }).pipe(Effect.uninterruptible);
  let pair: CryptoKeyPair | undefined = generated;
  const pub = toHex(
    new Uint8Array(
      yield* Effect.tryPromise(() => subtle.exportKey('raw', generated.publicKey)).pipe(
        Effect.uninterruptible
      )
    )
  );
  const nonce = options.crypto.getRandomValues(new Uint8Array(32));
  const peerId = toHex(options.crypto.getRandomValues(new Uint8Array(16)));
  const commitment =
    options.role === 'approver'
      ? Object.freeze({
          peerId,
          commitment: toHex(sha256(join(start, bytes([peerId, pub, toHex(nonce)])))),
        })
      : undefined;
  let selected: AutomaticPairingCommitment | undefined;
  let peerKey: string | undefined;
  let channel: AutomaticPairingChannel | undefined;
  let closed = false;
  const check = () => {
    if (closed || !pair) throw fail();
  };
  const ensure = () => Effect.try({ try: check, catch: () => fail() });
  const gate = yield* Semaphore.make(1);
  const requestKey = Effect.fnUntraced(function* (input: AutomaticPairingCommitment) {
    yield* ensure();
    if (options.role !== 'requester') return yield* Effect.fail(fail());
    const candidate = yield* Effect.try({
      try: () => AutomaticPairingCommitmentSchema.parse(input),
      catch: () => fail(),
    });
    if (
      selected &&
      (candidate.peerId !== selected.peerId || candidate.commitment !== selected.commitment)
    )
      return yield* Effect.fail(fail());
    selected ??= Object.freeze({ ...candidate });
    return pub;
  });
  const reveal = Effect.fnUntraced(function* (key: string) {
    yield* ensure();
    if (
      options.role !== 'approver' ||
      !/^04[0-9a-f]{128}$/.test(key) ||
      (peerKey && peerKey !== key)
    )
      return yield* Effect.fail(fail());
    peerKey ??= key;
    return { publicKey: pub, nonce: toHex(nonce) };
  });
  const finish = Effect.fnUntraced(function* (input: AutomaticPairingReveal | string) {
    yield* ensure();
    let requesterKey: string, responder: AutomaticPairingReveal, selectedPeer: string;
    if (options.role === 'requester') {
      if (!selected || typeof input === 'string') return yield* Effect.fail(fail());
      responder = yield* Effect.try({
        try: () => AutomaticPairingRevealSchema.parse(input),
        catch: () => fail(),
      });
      const actual = toHex(
        sha256(join(start, bytes([selected.peerId, responder.publicKey, responder.nonce])))
      );
      if (actual !== selected.commitment || (peerKey && peerKey !== responder.publicKey))
        return yield* Effect.fail(fail());
      peerKey ??= responder.publicKey;
      requesterKey = pub;
      selectedPeer = selected.peerId;
    } else {
      if (!peerKey || typeof input !== 'string' || input !== peerKey)
        return yield* Effect.fail(fail());
      requesterKey = peerKey;
      responder = { publicKey: pub, nonce: toHex(nonce) };
      selectedPeer = peerId;
    }
    if (channel) return channel;
    const otherKey = options.role === 'requester' ? responder.publicKey : requesterKey;
    const privateKey = pair!.privateKey;
    const shared = yield* Effect.tryPromise({
      try: async () => {
        const imported = await subtle.importKey(
          'raw',
          arrayBuffer(fromHex(otherKey)),
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        );
        return new Uint8Array(
          await subtle.deriveBits({ name: 'ECDH', public: imported }, privateKey, 256)
        );
      },
      catch: () => fail(),
    }).pipe(Effect.uninterruptible);
    try {
      yield* ensure();
      const transcript = sha256(
        join(start, bytes([selectedPeer, requesterKey, responder.publicKey, responder.nonce]))
      );
      const secret = hkdf(
        sha256,
        shared,
        transcript,
        new TextEncoder().encode(`${domain}/pairing-secret`),
        16
      );
      const sas = hkdf(
        sha256,
        shared,
        transcript,
        new TextEncoder().encode(`${domain}/comparison`),
        5
      );
      let number = 0;
      for (const byte of sas) number = number * 256 + byte;
      sas.fill(0);
      channel = {
        comparisonCode: String(number % 1_000_000).padStart(6, '0'),
        secret,
        dispose: () => secret.fill(0),
      };
      return channel;
    } finally {
      shared.fill(0);
    }
  });
  return {
    context,
    commitment,
    requestKey,
    reveal,
    finish: (input) => gate.withPermit(finish(input)),
    dispose() {
      closed = true;
      channel?.dispose();
      nonce.fill(0);
      pair = undefined;
    },
  } satisfies AutomaticPairingExchange;
});
