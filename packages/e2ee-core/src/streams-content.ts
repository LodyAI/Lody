import type { PayloadProtectionContext, PayloadProtectionProvider } from '@loro-dev/streams-crdt';
import { ContentCipher, inspectContent, MAX_CONTENT_BYTES, type ContentAuthor } from './content';
import { invariant } from './wire';

export interface StreamsContentOptions {
  readonly cipher: ContentCipher;
  readonly genesis: string;
  readonly resource: string;
  readonly model: 'loro' | 'flock';
  /** Fixed for this room session; replace the session after draining an epoch change. */
  readonly writeEpoch: number;
  readonly author: ContentAuthor;
  readonly signingKey: CryptoKey;
  /** Local lookup only. Never fetch a URL or accept keys supplied by unverified headers. */
  readonly readKey: (epoch: number) => Uint8Array | undefined;
}

const MAX_AAD = 1024;
const HEADER = 1;

/** Incremental transport protection. Snapshots fail closed until source evidence is supported. */
export function createStreamsContentProvider(
  options: StreamsContentOptions
): PayloadProtectionProvider {
  const { cipher, genesis, resource, model, writeEpoch, signingKey, readKey } = options;
  const author = Object.freeze({ ...options.author });
  invariant(model === 'loro' || model === 'flock', 'invalid-content-model');
  const purpose = model === 'loro' ? 'doc-update' : 'flock-update';
  const headerBound = new TextEncoder().encode(
    JSON.stringify([
      'lody-content/v1',
      genesis,
      String(Number.MAX_SAFE_INTEGER),
      resource,
      purpose,
      author.actor,
      author.memberInstance,
      author.device,
      '0'.repeat(32),
    ])
  ).byteLength;
  const overhead = 1 + headerBound + 2 + 24 + 16 + 64 + 2 + MAX_AAD;
  invariant(overhead <= 4096, 'streams-content-overhead-too-large');
  function context(value: PayloadProtectionContext) {
    invariant(
      value.protocol === 'loro-streams-crdt-payload-protection' && value.version === 2,
      'unsupported-streams-context'
    );
    invariant(value.kind === 'update_batch', 'snapshot-evidence-required');
  }
  function aad(value: Uint8Array) {
    invariant(
      value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= MAX_AAD,
      'invalid-streams-aad'
    );
    return new Uint8Array(value);
  }
  function key(epoch: number) {
    const result = readKey(epoch);
    invariant(result !== undefined, 'missing-content-key');
    return result;
  }
  return {
    // Provider header + content header/length/nonce/tag/signature + inner AAD framing.
    maxSealOverheadBytes: overhead,
    async seal(input) {
      context(input.context);
      const header = new Uint8Array([HEADER]);
      const binding = aad(input.additionalData(header));
      invariant(
        input.plaintext instanceof Uint8Array &&
          input.plaintext.byteLength <= MAX_CONTENT_BYTES - 2 - binding.byteLength,
        'content-too-large'
      );
      const payload = new Uint8Array(2 + binding.byteLength + input.plaintext.byteLength);
      new DataView(payload.buffer).setUint16(0, binding.byteLength);
      payload.set(binding, 2);
      payload.set(input.plaintext, 2 + binding.byteLength);
      try {
        const sealed = await cipher.seal({
          scope: { genesis, resource, purpose, epoch: writeEpoch },
          author,
          signingKey,
          epochKey: key(writeEpoch),
          plaintext: payload,
        });
        return { header, sealed };
      } finally {
        payload.fill(0);
      }
    },
    async open(input) {
      context(input.context);
      invariant(
        input.header.byteLength === 1 && input.header[0] === HEADER,
        'unsupported-streams-header'
      );
      const binding = aad(input.additionalData);
      // Inspect bounds before copying; copy before calling the key resolver.
      const metadata = inspectContent(input.sealed);
      const frame = new Uint8Array(input.sealed);
      invariant(
        metadata.genesis === genesis &&
          metadata.resource === resource &&
          metadata.purpose === purpose,
        'content-context-mismatch'
      );
      const opened = await cipher.open(
        { genesis, resource, purpose, epoch: metadata.epoch },
        key(metadata.epoch),
        frame
      );
      try {
        const bytes = opened.plaintext;
        invariant(
          bytes.byteLength >= 2 + binding.byteLength &&
            new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0) ===
              binding.byteLength &&
            binding.every((byte, i) => bytes[2 + i] === byte),
          'streams-aad-mismatch'
        );
        return bytes.slice(2 + binding.byteLength);
      } finally {
        opened.plaintext.fill(0);
      }
    },
  };
}
