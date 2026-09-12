import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import {
  checkHex,
  checkSigningKey,
  ControlLogError,
  fromHex,
  invariant,
  toHex,
  WebCryptoControl,
} from './wire';
import type { ContentAuthor } from './content';

export interface KeyRecipient {
  readonly kind: 'device' | 'recovery';
  readonly actor: string;
  readonly memberInstance: string;
  /** Device ID or recovery-key ID, as established by the verified ledger. */
  readonly id: string;
}
export interface KeyEnvelopeContext {
  readonly genesis: string;
  readonly epoch: number;
  /** A verified control record, not an append acknowledgement. */
  readonly controlHead: string;
  readonly sender: ContentAuthor;
  readonly recipient: KeyRecipient;
}
export interface KeyEnvelopeAuthority {
  readonly senderSigningKey: string;
  readonly recipientEncryptionKey: string;
}
export interface KeyEnvelopePolicy {
  /** Require verified admission/current eligibility before sending; validate history and
   * current recipient eligibility when receiving. Called again before releasing bytes.
   * Must throw on missing/stale evidence. No server directory or implicit defaults. */
  authorize(
    context: Readonly<KeyEnvelopeContext>,
    operation: 'send' | 'receive'
  ): KeyEnvelopeAuthority;
}

const domain = 'lody-epoch-key/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const info = encoder.encode('lody-epoch-key-hpke/v1');
const signatureDomain = encoder.encode('lody-epoch-key-signature/v1\0');
const MAX_HEADER = 2048;
const BODY_SIZE = 32 + 48 + 64; // HPKE enc, 32-byte secret + tag, Ed25519 signature
export const MAX_KEY_ENVELOPE_BYTES = 2 + MAX_HEADER + BODY_SIZE;

function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
function header(context: KeyEnvelopeContext): Uint8Array<ArrayBuffer> {
  checkHex(context.genesis, 32);
  checkHex(context.controlHead, 32);
  invariant(Number.isSafeInteger(context.epoch) && context.epoch >= 0, 'invalid-key-epoch');
  invariant(
    context.recipient.kind === 'device' || context.recipient.kind === 'recovery',
    'invalid-key-recipient'
  );
  const identifiers = [
    context.sender.actor,
    context.sender.memberInstance,
    context.sender.device,
    context.recipient.actor,
    context.recipient.memberInstance,
    context.recipient.id,
  ];
  for (const id of identifiers)
    invariant(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id), 'invalid-key-identity');
  const result = encoder.encode(
    JSON.stringify([
      domain,
      context.genesis,
      String(context.epoch),
      context.controlHead,
      ...identifiers.slice(0, 3),
      context.recipient.kind,
      ...identifiers.slice(3),
    ])
  );
  invariant(result.length <= MAX_HEADER, 'key-header-too-large');
  return result;
}
function parseHeader(bytes: Uint8Array): Readonly<KeyEnvelopeContext> {
  let fields: unknown;
  try {
    fields = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new ControlLogError('invalid-key-header');
  }
  invariant(
    Array.isArray(fields) && fields.length === 11 && fields.every((f) => typeof f === 'string'),
    'invalid-key-header'
  );
  invariant(fields[0] === domain, 'unsupported-key-envelope');
  invariant(/^(0|[1-9][0-9]*)$/.test(fields[2]!), 'invalid-key-epoch');
  invariant(fields[7] === 'device' || fields[7] === 'recovery', 'invalid-key-recipient');
  const context = Object.freeze({
    genesis: fields[1]!,
    epoch: Number(fields[2]),
    controlHead: fields[3]!,
    sender: Object.freeze({ actor: fields[4]!, memberInstance: fields[5]!, device: fields[6]! }),
    recipient: Object.freeze({
      kind: fields[7],
      actor: fields[8]!,
      memberInstance: fields[9]!,
      id: fields[10]!,
    }),
  });
  invariant(decoder.decode(header(context)) === decoder.decode(bytes), 'noncanonical-key-header');
  return context;
}

/** UNVERIFIED routing metadata only. Never use this result as admission or key authority. */
export function inspectKeyEnvelope(frame: Uint8Array): Readonly<KeyEnvelopeContext> {
  invariant(
    frame instanceof Uint8Array &&
      frame.length >= 2 + BODY_SIZE &&
      frame.length <= MAX_KEY_ENVELOPE_BYTES,
    'invalid-key-envelope'
  );
  const size = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(0);
  invariant(
    size > 0 && size <= MAX_HEADER && frame.length === 2 + size + BODY_SIZE,
    'invalid-key-envelope'
  );
  return parseHeader(frame.subarray(2, 2 + size));
}

/** Only encrypts one 32-byte content epoch key. No network, admission, keyring writes or fallback. */
export class KeyEnvelopeCipher {
  private readonly suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
  private readonly verifier = new WebCryptoControl();
  constructor(private readonly policy: KeyEnvelopePolicy) {}

  private authority(
    context: KeyEnvelopeContext,
    operation: 'send' | 'receive',
    expected?: KeyEnvelopeAuthority
  ) {
    const result = this.policy.authorize(context, operation);
    const value = {
      senderSigningKey: result.senderSigningKey,
      recipientEncryptionKey: result.recipientEncryptionKey,
    };
    checkSigningKey(value.senderSigningKey);
    checkHex(value.recipientEncryptionKey, 32);
    // RFC 7748 decoding aliases must not create two ledger identities for one key.
    const coordinate = BigInt('0x' + value.recipientEncryptionKey.match(/../g)!.reverse().join(''));
    invariant(coordinate < (1n << 255n) - 19n, 'noncanonical-encryption-key');
    invariant(
      expected === undefined ||
        (expected.senderSigningKey === value.senderSigningKey &&
          expected.recipientEncryptionKey === value.recipientEncryptionKey),
      'key-authority-changed'
    );
    return value;
  }

  async seal(
    context: KeyEnvelopeContext,
    epochKey: Uint8Array,
    signingKey: CryptoKey
  ): Promise<Uint8Array> {
    const aad = header(context);
    const frozen = parseHeader(aad);
    invariant(epochKey instanceof Uint8Array && epochKey.length === 32, 'invalid-epoch-key');
    const secret = new Uint8Array(epochKey);
    try {
      const authority = this.authority(frozen, 'send');
      const recipientPublicKey = await this.suite.kem.deserializePublicKey(
        fromHex(authority.recipientEncryptionKey)
      );
      // Base mode only: a fresh ephemeral KEM key for each single-shot invocation.
      const sealed = await this.suite.seal({ recipientPublicKey, info }, secret, aad);
      invariant(sealed.enc.byteLength === 32 && sealed.ct.byteLength === 48, 'invalid-hpke-output');
      const prefix = new Uint8Array(2);
      new DataView(prefix.buffer).setUint16(0, aad.length);
      const unsigned = join(prefix, aad, new Uint8Array(sealed.enc), new Uint8Array(sealed.ct));
      const message = join(signatureDomain, unsigned);
      const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', signingKey, message));
      invariant(
        await this.verifier.verify(authority.senderSigningKey, message, toHex(signature)),
        'bad-key-signature'
      );
      this.authority(frozen, 'send', authority);
      return join(unsigned, signature);
    } finally {
      secret.fill(0);
    }
  }

  /** Authenticate stored ciphertext before dispatch; does not prove its plaintext commitment. */
  async verifyForSend(expected: KeyEnvelopeContext, frame: Uint8Array): Promise<void> {
    const expectedHeader = header(expected);
    const context = inspectKeyEnvelope(frame);
    invariant(
      decoder.decode(header(context)) === decoder.decode(expectedHeader),
      'key-context-mismatch'
    );
    const bytes = new Uint8Array(frame);
    const trusted = this.authority(context, 'send');
    invariant(
      await this.verifier.verify(
        trusted.senderSigningKey,
        join(signatureDomain, bytes.subarray(0, -64)),
        toHex(bytes.subarray(-64))
      ),
      'bad-key-signature'
    );
    this.authority(context, 'send', trusted);
  }

  async open(
    expected: KeyEnvelopeContext,
    recipientKey: CryptoKeyPair,
    frame: Uint8Array
  ): Promise<Uint8Array> {
    const expectedHeader = header(expected);
    invariant(
      frame instanceof Uint8Array &&
        frame.length >= 2 + BODY_SIZE &&
        frame.length <= MAX_KEY_ENVELOPE_BYTES,
      'invalid-key-envelope'
    );
    const wire = new Uint8Array(frame);
    const size = new DataView(wire.buffer).getUint16(0);
    invariant(
      size > 0 && size <= MAX_HEADER && wire.length === 2 + size + BODY_SIZE,
      'invalid-key-envelope'
    );
    const aad = wire.subarray(2, 2 + size);
    const frozen = parseHeader(aad);
    invariant(decoder.decode(aad) === decoder.decode(expectedHeader), 'key-context-mismatch');
    const keys = { publicKey: recipientKey.publicKey, privateKey: recipientKey.privateKey };
    const authority = this.authority(frozen, 'receive');
    invariant(
      await this.verifier.verify(
        authority.senderSigningKey,
        join(signatureDomain, wire.subarray(0, -64)),
        toHex(wire.subarray(-64))
      ),
      'bad-key-signature'
    );
    const localPublic = toHex(
      new Uint8Array(await this.suite.kem.serializePublicKey(keys.publicKey))
    );
    invariant(localPublic === authority.recipientEncryptionKey, 'key-recipient-mismatch');
    let plaintext: Uint8Array | undefined;
    try {
      try {
        plaintext = new Uint8Array(
          await this.suite.open(
            { recipientKey: keys, enc: wire.subarray(2 + size, 2 + size + 32), info },
            wire.subarray(2 + size + 32, -64),
            aad
          )
        );
      } catch {
        throw new ControlLogError('key-decryption-failed');
      }
      invariant(plaintext.length === 32, 'invalid-epoch-key');
      this.authority(frozen, 'receive', authority);
      return new Uint8Array(plaintext);
    } finally {
      plaintext?.fill(0);
    }
  }
}
