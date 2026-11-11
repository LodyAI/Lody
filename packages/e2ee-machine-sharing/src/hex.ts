/** Lowercase hex, as Node's `Buffer#toString('hex')` writes it, without Node. */
export const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Decodes like Node's `Buffer.from(value, 'hex')`: byte pairs until the first pair
 * that is not two hex digits; a trailing odd digit is ignored. */
export const unhex = (value: string) => {
  const bytes: number[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    const pair = value.slice(i, i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) break;
    bytes.push(parseInt(pair, 16));
  }
  return Uint8Array.from(bytes);
};
