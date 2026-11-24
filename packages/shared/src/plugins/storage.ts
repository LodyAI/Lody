import { z } from 'zod';
export const pluginStorageKey = z.string().min(1).max(256);
export function storedJson(input: unknown): string {
  const value = z.json().parse(input);
  const encode = (x: typeof value): string =>
    Array.isArray(x)
      ? `[${x.map(encode).join(',')}]`
      : typeof x === 'object' && x !== null
        ? `{${Object.entries(x)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${JSON.stringify(k)}:${encode(v)}`)
            .join(',')}}`
        : JSON.stringify(x);
  const text = encode(value);
  if (new TextEncoder().encode(text).length > 262144)
    throw Error('Plugin storage value exceeds 256 KiB');
  return text;
}
