import type { PayloadProtectionContext, PayloadProtectionProvider } from '@loro-dev/streams-crdt';
import {
  ContentCipher,
  inspectContent,
  MAX_CONTENT_BYTES,
  type ContentAuthor,
  type ContentPurpose,
} from './content';
import { invariant } from './wire';
export { deviceMayWriteDocument } from './pure/content-policy';

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
  /**
   * Honest-client seal check: device document-write, not account role or mere
   * possession of the epoch key. Applies to both update and snapshot seals.
   * Does not constrain a malicious client. Host publication uses
   * `./snapshot-admission`. Open of an admitted snapshot does not re-check
   * this (historical snapshots stay valid after later revoke).
   */
  readonly mayWriteDocument?: (author: ContentAuthor) => boolean;
}

const MAX_AAD = 1024;
const MAX_OFFSET = 1024;
const UPDATE_HEADER = 1;
const SNAPSHOT_HEADER = 2;
const encoder = new TextEncoder();

function continuationOffset(context: PayloadProtectionContext): string {
  const offset = (context as { continuationOffset?: unknown }).continuationOffset;
  invariant(
    typeof offset === 'string' &&
      offset.length > 0 &&
      offset.length <= MAX_OFFSET &&
      offset !== 'now',
    'invalid-snapshot-offset'
  );
  return offset;
}

/** Incremental transport protection plus authenticated content snapshots.
 * Promise streams-crdt SDK boundary; ContentCipher unwraps the Effect workflow. */
export function createStreamsContentProvider(
  options: StreamsContentOptions
): PayloadProtectionProvider {
  const { cipher, genesis, resource, model, writeEpoch, signingKey, readKey, mayWriteDocument } =
    options;
  const author = Object.freeze({ ...options.author });
  invariant(model === 'loro' || model === 'flock', 'invalid-content-model');
  const updatePurpose: ContentPurpose = model === 'loro' ? 'doc-update' : 'flock-update';
  const snapshotPurpose: ContentPurpose = model === 'loro' ? 'doc-snapshot' : 'flock-snapshot';
  const headerBound = new TextEncoder().encode(
    JSON.stringify([
      'lody-content/v1',
      genesis,
      String(Number.MAX_SAFE_INTEGER),
      resource,
      snapshotPurpose,
      author.actor,
      author.memberInstance,
      author.device,
      '0'.repeat(32),
    ])
  ).byteLength;
  const overhead = 1 + headerBound + 2 + 24 + 16 + 64 + 2 + MAX_AAD + 2 + MAX_OFFSET;
  invariant(overhead <= 4096, 'streams-content-overhead-too-large');
  function context(value: PayloadProtectionContext): 'update_batch' | 'snapshot' {
    invariant(
      value.protocol === 'loro-streams-crdt-payload-protection' && value.version === 2,
      'unsupported-streams-context'
    );
    invariant(
      value.kind === 'update_batch' || value.kind === 'snapshot',
      'unsupported-streams-kind'
    );
    return value.kind;
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
  function purposeFor(kind: 'update_batch' | 'snapshot'): ContentPurpose {
    return kind === 'snapshot' ? snapshotPurpose : updatePurpose;
  }
  return {
    // Provider header + content header/length/nonce/tag/signature + inner AAD/offset framing.
    maxSealOverheadBytes: overhead,
    async seal(input) {
      const kind = context(input.context);
      const isSnapshot = kind === 'snapshot';
      const offset = isSnapshot ? encoder.encode(continuationOffset(input.context)) : null;
      if (isSnapshot) {
        invariant(mayWriteDocument?.(author) === true, 'unauthorized');
      } else if (mayWriteDocument) {
        // Honest clients refuse update seals without document-write rights.
        // Malicious clients can omit the check; open still trusts host admission.
        invariant(mayWriteDocument(author) === true, 'unauthorized');
      }
      const header = new Uint8Array([isSnapshot ? SNAPSHOT_HEADER : UPDATE_HEADER]);
      const binding = aad(input.additionalData(header));
      const offsetBytes = 2 + (offset === null ? 0 : 2 + offset.byteLength);
      invariant(
        input.plaintext instanceof Uint8Array &&
          input.plaintext.byteLength <= MAX_CONTENT_BYTES - offsetBytes - binding.byteLength,
        'content-too-large'
      );
      const payload = new Uint8Array(
        2 +
          binding.byteLength +
          (offset === null ? 0 : 2 + offset.byteLength) +
          input.plaintext.byteLength
      );
      const view = new DataView(payload.buffer);
      view.setUint16(0, binding.byteLength);
      payload.set(binding, 2);
      let cursor = 2 + binding.byteLength;
      if (offset !== null) {
        view.setUint16(cursor, offset.byteLength);
        payload.set(offset, cursor + 2);
        cursor += 2 + offset.byteLength;
      }
      payload.set(input.plaintext, cursor);
      try {
        const sealed = await cipher.seal({
          scope: { genesis, resource, purpose: purposeFor(kind), epoch: writeEpoch },
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
      const kind = context(input.context);
      const expectedOffset = kind === 'snapshot' ? continuationOffset(input.context) : null;
      const expectedHeader = kind === 'snapshot' ? SNAPSHOT_HEADER : UPDATE_HEADER;
      invariant(
        input.header.byteLength === 1 && input.header[0] === expectedHeader,
        'unsupported-streams-header'
      );
      const binding = aad(input.additionalData);
      // Inspect bounds before copying; copy before calling the key resolver.
      const metadata = inspectContent(input.sealed);
      const frame = new Uint8Array(input.sealed);
      invariant(
        metadata.genesis === genesis &&
          metadata.resource === resource &&
          metadata.purpose === purposeFor(kind),
        'content-context-mismatch'
      );
      const opened = await cipher.open(
        { genesis, resource, purpose: purposeFor(kind), epoch: metadata.epoch },
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
        let cursor = 2 + binding.byteLength;
        if (expectedOffset !== null) {
          invariant(bytes.byteLength >= cursor + 2, 'invalid-snapshot-offset');
          const offsetLength = new DataView(
            bytes.buffer,
            bytes.byteOffset + cursor,
            bytes.byteLength - cursor
          ).getUint16(0);
          invariant(
            offsetLength > 0 &&
              offsetLength <= MAX_OFFSET &&
              bytes.byteLength >= cursor + 2 + offsetLength,
            'invalid-snapshot-offset'
          );
          const boundOffset = new TextDecoder('utf-8', { fatal: true }).decode(
            bytes.subarray(cursor + 2, cursor + 2 + offsetLength)
          );
          invariant(boundOffset === expectedOffset, 'snapshot-offset-mismatch');
          cursor += 2 + offsetLength;
        }
        return bytes.slice(cursor);
      } finally {
        opened.plaintext.fill(0);
      }
    },
  };
}
