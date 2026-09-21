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
  const next = bytes[index + 2 + boundary.byteLength];
  return next === undefined || next === CR || next === LF || next === DASH;
}

/**
 * Replace `--<boundary>` only when it is a multipart delimiter (start of
 * body or immediately after a newline). Payload bytes that merely contain
 * the same ASCII token are left intact.
 */
export function normalizeMultipartBody(bytes: Uint8Array): Uint8Array {
  const boundary = parseOpeningBoundary(bytes);
  if (!boundary) return bytes;
  const out = new Uint8Array(bytes.byteLength + 16);
  let write = 0;
  let read = 0;
  let replaced = 0;
  while (read < bytes.byteLength) {
    if (isDelimiterAt(bytes, read, boundary)) {
      out[write++] = DASH;
      out[write++] = DASH;
      out.set(CANONICAL_BOUNDARY, write);
      write += CANONICAL_BOUNDARY.byteLength;
      read += 2 + boundary.byteLength;
      replaced += 1;
      continue;
    }
    out[write++] = bytes[read++]!;
  }
  if (replaced === 0) return bytes;
  return out.subarray(0, write);
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
