import type { E2eeRpcResponseBody } from './e2ee-wire';

export const E2EE_FEATURE_CHUNK_BYTES = 256 * 1024;
export const E2EE_FEATURE_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const E2EE_FEATURE_MAX_RESULT_BYTES = 16 * 1024 * 1024;

/** One signed response payload: big-endian page count + total JSON bytes + chunk.
 * The enclosing response binds sequence, kind, request digest, signer and epoch. */
export function encodeFeatureResponsePage(bytes: Uint8Array, sequence: number): Uint8Array {
  const count = Math.ceil(bytes.length / E2EE_FEATURE_CHUNK_BYTES);
  if (
    bytes.length < 1 ||
    bytes.length > E2EE_FEATURE_MAX_RESULT_BYTES ||
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    sequence >= count
  )
    throw new Error('e2ee_feature_result_size');
  const chunk = bytes.subarray(
    sequence * E2EE_FEATURE_CHUNK_BYTES,
    (sequence + 1) * E2EE_FEATURE_CHUNK_BYTES
  );
  const page = new Uint8Array(8 + chunk.length);
  const header = new DataView(page.buffer);
  header.setUint32(0, count);
  header.setUint32(4, bytes.length);
  page.set(chunk, 8);
  return page;
}

export function decodeFeatureResponsePage(
  body: Pick<E2eeRpcResponseBody, 'sequence' | 'kind' | 'payload'>
) {
  if (body.payload.length < 9 || body.payload.length > E2EE_FEATURE_CHUNK_BYTES + 8)
    throw new Error('e2ee_feature_page');
  const header = new DataView(
    body.payload.buffer,
    body.payload.byteOffset,
    body.payload.byteLength
  );
  const totalPages = header.getUint32(0),
    totalBytes = header.getUint32(4);
  if (
    totalBytes < 1 ||
    totalBytes > E2EE_FEATURE_MAX_RESULT_BYTES ||
    totalPages !== Math.ceil(totalBytes / E2EE_FEATURE_CHUNK_BYTES) ||
    !Number.isInteger(body.sequence) ||
    body.sequence < 0 ||
    body.sequence >= totalPages ||
    (body.kind !== 'progress' && body.kind !== 'success') ||
    (body.kind === 'success') !== (body.sequence === totalPages - 1) ||
    body.payload.length - 8 !==
      Math.min(E2EE_FEATURE_CHUNK_BYTES, totalBytes - body.sequence * E2EE_FEATURE_CHUNK_BYTES)
  )
    throw new Error('e2ee_feature_page');
  return { totalPages, totalBytes, bytes: Uint8Array.from(body.payload.subarray(8)) };
}
