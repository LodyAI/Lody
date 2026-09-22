/** Deterministic identifiers; no cache, I/O or implicit cryptographic state. */
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));
export function keyId(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += HEX[byte];
  return hex;
}
export function joinKey(signingPublicKey: Uint8Array, requestId: Uint8Array): string {
  return `${keyId(signingPublicKey)}:${keyId(requestId)}`;
}
