/** Owned portable byte conversions; untrusted boundaries bound lengths before calling these helpers. */
export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (value: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error('e2ee_invalid_hex');
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i++) result[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
};
export const base64 = (value: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < value.length; i += 4096)
    binary += String.fromCharCode(...value.subarray(i, i + 4096));
  return btoa(binary);
};
export const unbase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (x) => x.charCodeAt(0));
