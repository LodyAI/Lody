import { Decompress } from 'fzstd';
import { SHARE_LIMITS, type ShareObject } from './session-share-package';

/** Accept one bounded, dictionary-free frame before the decoder allocates memory. */
function checkFrame(bytes: Uint8Array, expected: number) {
  const invalid = () => {
    throw new Error('Invalid compressed share history');
  };
  let offset = 0;
  const read = (length: number) => {
    if (offset + length > bytes.length) return invalid();
    let value = 0;
    for (let i = 0; i < length; i++) value += bytes[offset++]! * 2 ** (8 * i);
    return value;
  };
  if (read(4) !== 0xfd2fb528) invalid();
  const flags = read(1);
  if (flags & 0x1b) invalid();
  const single = !!(flags & 32);
  const windowByte = single ? 0 : read(1);
  const sizeFlag = flags >>> 6;
  const sizeLength = sizeFlag ? 2 ** sizeFlag : single ? 1 : 0;
  // Our encoder includes size; unknown-size/concatenated frames are not this format.
  if (!sizeLength) invalid();
  const size = read(sizeLength) + (sizeFlag === 1 ? 256 : 0);
  const windowBase = 2 ** (10 + (windowByte >>> 3));
  const window = single ? size : windowBase + (windowBase / 8) * (windowByte & 7);
  if (size !== expected || window > SHARE_LIMITS.historyBytes) invalid();
  let last = false;
  while (!last) {
    const block = read(3);
    last = !!(block & 1);
    const type = (block >>> 1) & 3;
    const length = block >>> 3;
    if (type === 3 || length > 131072) invalid();
    offset += type === 1 ? 1 : length;
    if (offset > bytes.length) invalid();
  }
  if (flags & 4) offset += 4;
  if (offset !== bytes.length) invalid();
}

/** Caller verifies SHA/encoded length first. Encoding is explicit, never automatic HTTP decoding. */
export function decodeShareHistoryBytes(bytes: Uint8Array, descriptor: ShareObject): Uint8Array {
  if (!descriptor.contentEncoding) {
    if (bytes.length > SHARE_LIMITS.historyBytes)
      throw new Error('Share history exceeds size limit');
    return bytes;
  }
  const size = descriptor.decodedSizeBytes;
  if (
    size === undefined ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > SHARE_LIMITS.historyBytes
  )
    throw new Error('Share history exceeds size limit');
  checkFrame(bytes, size);
  const result = new Uint8Array(size);
  let offset = 0;
  const decoder = new Decompress((chunk) => {
    if (offset + chunk.length > size) throw new Error('Share history exceeds size limit');
    result.set(chunk, offset);
    offset += chunk.length;
  });
  decoder.push(bytes, true);
  if (offset !== size) throw new Error('Invalid compressed share history');
  return result;
}
