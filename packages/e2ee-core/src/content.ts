import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  checkHex,
  checkSigningKey,
  invariant,
  toHex,
  WebCryptoControl,
  ControlLogError,
} from './wire';

export type ContentPurpose =
  | 'doc-update'
  | 'doc-snapshot'
  | 'flock-update'
  | 'flock-snapshot'
  | 'blob'
  | 'epoch-history'
  | 'presence'
  | 'rpc-request'
  | 'rpc-response';
export interface ContentScope {
  readonly genesis: string;
  readonly epoch: number;
  /** Stable logical resource ID, not a transport URL. */
  readonly resource: string;
  readonly purpose: ContentPurpose;
}
export interface ContentAuthor {
  readonly actor: string;
  readonly memberInstance: string;
  readonly device: string;
}
export interface ContentHeader extends ContentScope, ContentAuthor {
  readonly messageId: string;
}
export interface ContentPolicy {
  /** Return a key from verified authority or throw. Called again after async crypto.
   * The caller owns freshness, historical-author rules and epoch eligibility.
   * This is NOT command execution authorization or durable replay protection. */
  authorize(header: Readonly<ContentHeader>): string;
}
export interface SealContent {
  readonly scope: ContentScope;
  readonly author: ContentAuthor;
  readonly epochKey: Uint8Array;
  readonly signingKey: CryptoKey;
  readonly plaintext: Uint8Array;
}

export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const SIGNATURE_BYTES = 64;
const DOMAIN = 'lody-content/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const signatureDomain = encoder.encode('lody-content-signature/v1\0');

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
function scopeParts(scope: ContentScope): string[] {
  checkHex(scope.genesis, 32);
  invariant(Number.isSafeInteger(scope.epoch) && scope.epoch >= 0, 'invalid-content-epoch');
  invariant(
    typeof scope.resource === 'string' && /^[\x21-\x7e]{1,1024}$/.test(scope.resource),
    'invalid-content-resource'
  );
  checkPurpose(scope.purpose);
  return [scope.genesis, String(scope.epoch), scope.resource, scope.purpose];
}
function checkPurpose(value: unknown): asserts value is ContentPurpose {
  invariant(
    typeof value === 'string' &&
      [
        'doc-update',
        'doc-snapshot',
        'flock-update',
        'flock-snapshot',
        'blob',
        'epoch-history',
        'presence',
        'rpc-request',
        'rpc-response',
      ].includes(value),
    'invalid-content-purpose'
  );
}
function headerBytes(header: ContentHeader): Uint8Array<ArrayBuffer> {
  const scope = scopeParts(header);
  for (const id of [header.actor, header.memberInstance, header.device])
    invariant(
      typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id),
      'invalid-content-author'
    );
  checkHex(header.messageId, 16);
  const encoded = encoder.encode(
    JSON.stringify([
      DOMAIN,
      ...scope,
      header.actor,
      header.memberInstance,
      header.device,
      header.messageId,
    ])
  );
  invariant(encoded.byteLength <= MAX_HEADER_BYTES, 'content-header-too-large');
  return encoded;
}
function copyKey(key: Uint8Array): Uint8Array<ArrayBuffer> {
  invariant(key instanceof Uint8Array && key.byteLength === 32, 'invalid-content-key');
  return new Uint8Array(key);
}
function parse(frame: Uint8Array) {
  invariant(
    frame instanceof Uint8Array &&
      frame.byteLength >= 2 + NONCE_BYTES + TAG_BYTES + SIGNATURE_BYTES &&
      frame.byteLength <=
        MAX_CONTENT_BYTES + MAX_HEADER_BYTES + 2 + NONCE_BYTES + TAG_BYTES + SIGNATURE_BYTES,
    'invalid-content-frame'
  );
  const wire = new Uint8Array(frame);
  const size = new DataView(wire.buffer).getUint16(0);
  const start = 2 + size;
  invariant(
    size > 0 &&
      size <= MAX_HEADER_BYTES &&
      wire.byteLength >= start + NONCE_BYTES + TAG_BYTES + SIGNATURE_BYTES,
    'invalid-content-frame'
  );
  invariant(
    wire.byteLength - start - NONCE_BYTES - TAG_BYTES - SIGNATURE_BYTES <= MAX_CONTENT_BYTES,
    'content-too-large'
  );
  const aad = wire.subarray(2, start);
  let text: string;
  let fields: unknown;
  try {
    text = decoder.decode(aad);
    fields = JSON.parse(text);
  } catch {
    // Native JSON errors can quote input bytes. Do not send payload snippets to diagnostics.
    throw new ControlLogError('invalid-content-header');
  }
  invariant(
    Array.isArray(fields) &&
      fields.length === 9 &&
      fields.every((field) => typeof field === 'string'),
    'invalid-content-header'
  );
  const values = fields;
  invariant(values[0] === DOMAIN, 'unsupported-content-version');
  invariant(/^(0|[1-9][0-9]*)$/.test(values[2]!), 'invalid-content-epoch');
  const purpose = values[4];
  checkPurpose(purpose);
  const header: ContentHeader = Object.freeze({
    genesis: values[1]!,
    epoch: Number(values[2]),
    resource: values[3]!,
    purpose,
    actor: values[5]!,
    memberInstance: values[6]!,
    device: values[7]!,
    messageId: values[8]!,
  });
  invariant(decoder.decode(headerBytes(header)) === text, 'noncanonical-content-header');
  return {
    header,
    aad,
    nonce: wire.subarray(start, start + NONCE_BYTES),
    ciphertext: wire.subarray(start + NONCE_BYTES, -SIGNATURE_BYTES),
    unsigned: wire.subarray(0, -SIGNATURE_BYTES),
    signature: toHex(wire.subarray(-SIGNATURE_BYTES)),
  };
}

/** Unverified metadata for selecting a known epoch key; never an identity/permission assertion. */
export function inspectContent(frame: Uint8Array): Readonly<ContentHeader> {
  return parse(frame).header;
}

/** Stateless content protection only. No key storage, network, CRDT import or plaintext fallback. */
export class ContentCipher {
  private readonly verifier = new WebCryptoControl();
  constructor(
    private readonly policy: ContentPolicy,
    private readonly platform: Pick<Crypto, 'subtle' | 'getRandomValues'> = globalThis.crypto
  ) {}

  private authorize(header: ContentHeader, expected?: string): string {
    const key = this.policy.authorize(header);
    checkSigningKey(key);
    invariant(expected === undefined || key === expected, 'content-authority-changed');
    return key;
  }
  private async derive(
    key: Uint8Array<ArrayBuffer>,
    header: ContentHeader
  ): Promise<Uint8Array<ArrayBuffer>> {
    try {
      const info = encoder.encode(JSON.stringify(['lody-content-key/v1', ...scopeParts(header)]));
      const material = await this.platform.subtle.importKey('raw', key, 'HKDF', false, [
        'deriveBits',
      ]);
      return new Uint8Array(
        await this.platform.subtle.deriveBits(
          { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('lody-content-hkdf/v1'), info },
          material,
          256
        )
      );
    } finally {
      key.fill(0);
    }
  }
  async seal(input: SealContent): Promise<Uint8Array<ArrayBuffer>> {
    invariant(
      input.plaintext instanceof Uint8Array && input.plaintext.byteLength <= MAX_CONTENT_BYTES,
      'content-too-large'
    );
    // Copy all caller-owned bytes/metadata before the first await.
    const epochKey = copyKey(input.epochKey);
    const plaintext = new Uint8Array(input.plaintext);
    const signingKey = input.signingKey;
    let key: Uint8Array | undefined;
    try {
      const header = Object.freeze({
        genesis: input.scope.genesis,
        epoch: input.scope.epoch,
        resource: input.scope.resource,
        purpose: input.scope.purpose,
        actor: input.author.actor,
        memberInstance: input.author.memberInstance,
        device: input.author.device,
        messageId: toHex(this.platform.getRandomValues(new Uint8Array(16))),
      });
      const aad = headerBytes(header);
      const publicKey = this.authorize(header);
      const nonce = this.platform.getRandomValues(new Uint8Array(NONCE_BYTES));
      key = await this.derive(epochKey, header);
      const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
      const length = new Uint8Array(2);
      new DataView(length.buffer).setUint16(0, aad.byteLength);
      const unsigned = concat(length, aad, nonce, ciphertext);
      const message = concat(signatureDomain, unsigned);
      const signature = new Uint8Array(
        await this.platform.subtle.sign('Ed25519', signingKey, message)
      );
      invariant(
        await this.verifier.verify(publicKey, message, toHex(signature)),
        'bad-content-signature'
      );
      this.authorize(header, publicKey);
      return concat(unsigned, signature);
    } finally {
      epochKey.fill(0);
      key?.fill(0);
      plaintext.fill(0);
    }
  }
  async open(
    scope: ContentScope,
    epochKey: Uint8Array,
    frame: Uint8Array
  ): Promise<{ header: Readonly<ContentHeader>; plaintext: Uint8Array }> {
    const expected = JSON.stringify(scopeParts(scope));
    const parsed = parse(frame);
    invariant(JSON.stringify(scopeParts(parsed.header)) === expected, 'content-context-mismatch');
    const copied = copyKey(epochKey);
    let key: Uint8Array | undefined;
    try {
      const publicKey = this.authorize(parsed.header);
      invariant(
        await this.verifier.verify(
          publicKey,
          concat(signatureDomain, parsed.unsigned),
          parsed.signature
        ),
        'bad-content-signature'
      );
      key = await this.derive(copied, parsed.header);
      // No await between the final authority check, authenticated decryption and return.
      this.authorize(parsed.header, publicKey);
      try {
        return {
          header: parsed.header,
          plaintext: xchacha20poly1305(key, parsed.nonce, parsed.aad).decrypt(parsed.ciphertext),
        };
      } catch {
        throw new ControlLogError('content-authentication-failed');
      }
    } finally {
      copied.fill(0);
      key?.fill(0);
    }
  }
}
