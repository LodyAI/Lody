/** Fixed portable JSON/byte operations shared by the existing encrypted RPC paths. */
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
export function unhex(value: string, frameLimit?: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    !/^(?:[0-9a-f]{2})+$/.test(value) ||
    (frameLimit !== undefined && (value.length < 286 || value.length > 2 * frameLimit))
  )
    throw new Error('e2ee_rpc_frame');
  return Uint8Array.from(value.match(/../g)!, (byte) => parseInt(byte, 16));
}
/** Inputs are already normalized JSON wire DTOs: order-insensitive object keys and ordered arrays. */
export function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        equalJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    )
  );
}
