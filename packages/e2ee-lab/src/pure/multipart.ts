/**
 * Normalize only Riverrun multipart delimiter tokens. Protected part bodies
 * stay byte-for-byte. A body that is not a well-formed multipart message is
 * returned unchanged so illegal traffic cannot become legal through rewrite.
 */

const DASH = 0x2d;
const LF = 0x0a;
const CR = 0x0d;

const CANONICAL_BOUNDARY = new TextEncoder().encode('rr-bootstrap-*');

function isBoundaryByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x27 ||
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x2b ||
    byte === 0x5f ||
    byte === 0x2c ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x2f ||
    byte === 0x3a ||
    byte === 0x3d ||
    byte === 0x3f
  );
}

function firstLineEnd(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === LF) return i;
  }
  return -1;
}

function lineContent(bytes: Uint8Array, end: number): Uint8Array {
  if (end > 0 && bytes[end - 1] === CR) return bytes.subarray(0, end - 1);
  return bytes.subarray(0, end);
}

function parseOpeningBoundary(bytes: Uint8Array): Uint8Array | null {
  const end = firstLineEnd(bytes);
  if (end < 3) return null;
  const line = lineContent(bytes, end);
  if (line.byteLength < 3 || line[0] !== DASH || line[1] !== DASH) return null;
  let stop = line.byteLength;
  if (stop >= 4 && line[stop - 1] === DASH && line[stop - 2] === DASH) stop -= 2;
  const boundary = line.subarray(2, stop);
  if (boundary.byteLength < 1 || boundary.byteLength > 70) return null;
  for (let i = 0; i < boundary.byteLength; i++) {
    if (!isBoundaryByte(boundary[i]!)) return null;
  }
  return boundary;
}

function isDelimiterAt(bytes: Uint8Array, index: number, boundary: Uint8Array): boolean {
  if (index !== 0 && bytes[index - 1] !== LF) return false;
  if (index + 2 + boundary.byteLength > bytes.byteLength) return false;
  if (bytes[index] !== DASH || bytes[index + 1] !== DASH) return false;
  for (let i = 0; i < boundary.byteLength; i++) {
    if (bytes[index + 2 + i] !== boundary[i]) return false;
  }
  let end = index + 2 + boundary.byteLength;
  if (bytes[end] === DASH && bytes[end + 1] === DASH) end += 2;
  if (bytes[end] === CR) end += 1;
  return end === bytes.byteLength || bytes[end] === LF;
}

/** Complete conservative multipart framing only. This is a replay comparison,
 * never a payload decoder or an authorization/validity transformation. */
export function normalizeMultipartBody(bytes: Uint8Array): Uint8Array {
  const boundary = parseOpeningBoundary(bytes);
  if (!boundary) return bytes;
  const delimiters: { start: number; end: number; closing: boolean }[] = [];
  for (let index = 0; index < bytes.length; index++) {
    if (!isDelimiterAt(bytes, index, boundary)) continue;
    let end = index + 2 + boundary.length;
    const closing = bytes[end] === DASH && bytes[end + 1] === DASH;
    if (closing) end += 2;
    if (bytes[end] === CR) end++;
    if (bytes[end] === LF) end++;
    delimiters.push({ start: index, end, closing });
    index = end - 1;
  }
  if (delimiters.length < 2 || delimiters[0]!.start !== 0 || delimiters[0]!.closing) return bytes;
  const last = delimiters[delimiters.length - 1]!;
  if (!last.closing || last.end !== bytes.length) return bytes;
  for (let i = 0; i < delimiters.length - 1; i++) {
    const line = delimiters[i]!,
      next = delimiters[i + 1]!;
    if (line.closing) return bytes;
    // Each part must have a terminated header block; binary payload is untouched.
    let cursor = line.end,
      ended = false;
    while (cursor < next.start) {
      let end = cursor;
      while (end < next.start && bytes[end] !== LF) end++;
      if (end === next.start) return bytes;
      const stop = end > cursor && bytes[end - 1] === CR ? end - 1 : end;
      if (stop === cursor) {
        ended = true;
        break;
      }
      let colon = false;
      for (let j = cursor; j < stop; j++) if (bytes[j] === 0x3a) colon = true;
      if (!colon) return bytes;
      cursor = end + 1;
    }
    if (!ended) return bytes;
  }
  const size = bytes.length + delimiters.length * (CANONICAL_BOUNDARY.length - boundary.length);
  const out = new Uint8Array(size);
  let read = 0,
    write = 0;
  for (const delimiter of delimiters) {
    out.set(bytes.subarray(read, delimiter.start + 2), write);
    write += delimiter.start + 2 - read;
    out.set(CANONICAL_BOUNDARY, write);
    write += CANONICAL_BOUNDARY.length;
    read = delimiter.start + 2 + boundary.length;
  }
  out.set(bytes.subarray(read), write);
  return out;
}

export function normalizeFrameHex(hex: string): string {
  if (!hex) return hex;
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.byteLength; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const normalized = normalizeMultipartBody(bytes);
  let out = '';
  for (let i = 0; i < normalized.byteLength; i++) {
    out += normalized[i]!.toString(16).padStart(2, '0');
  }
  return out;
}
