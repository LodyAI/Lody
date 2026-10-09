import type { PayloadProtectionContext, PayloadProtectionProvider } from '@loro-dev/streams-crdt';
import {
  ContentCipher,
  inspectContent,
  MAX_CONTENT_BYTES,
  CONTENT_OVERHEAD_BYTES,
  type ContentAuthor,
  type ContentPurpose,
} from './content';
import { invariant } from './wire';
import {
  STREAMS_UPDATE_HEADER as UPDATE_HEADER,
  STREAMS_SNAPSHOT_HEADER as SNAPSHOT_HEADER,
} from './pure/streams-content';
export { streamsContentAdditionalData } from './pure/streams-content';
export { contentAuthorKey, deviceMayWriteDocument, maySealNewContent } from './pure/content-policy';

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
  const overhead = 1 + CONTENT_OVERHEAD_BYTES + 2 + MAX_OFFSET;
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
    // Provider header + content frame + snapshot offset framing; AAD stays external.
    maxSealOverheadBytes: overhead,
    async seal(input) {
      const kind = context(input.context);
      const isSnapshot = kind === 'snapshot';
      const offset = isSnapshot ? encoder.encode(continuationOffset(input.context)) : null;
      invariant(offset === null || offset.byteLength <= MAX_OFFSET, 'invalid-snapshot-offset');
      if (isSnapshot) {
        invariant(mayWriteDocument?.(author) === true, 'unauthorized');
      } else if (mayWriteDocument) {
        // Honest clients refuse update seals without document-write rights.
        // Malicious clients can omit the check; open still trusts host admission.
        invariant(mayWriteDocument(author) === true, 'unauthorized');
      }
      const header = new Uint8Array([isSnapshot ? SNAPSHOT_HEADER : UPDATE_HEADER]);
      const binding = aad(input.additionalData(header));
      const offsetBytes = offset === null ? 0 : 2 + offset.byteLength;
      invariant(
        input.plaintext instanceof Uint8Array &&
          input.plaintext.byteLength <= MAX_CONTENT_BYTES - offsetBytes,
        'content-too-large'
      );
      const payload = new Uint8Array(offsetBytes + input.plaintext.byteLength);
      const view = new DataView(payload.buffer);
      let cursor = 0;
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
          additionalData: binding,
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
      const opened = await cipher.open(
        { genesis, resource, purpose: purposeFor(kind), epoch: metadata.epoch },
        key(metadata.epoch),
        frame,
        binding
      );
      try {
        const bytes = opened.plaintext;
        let cursor = 0;
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
