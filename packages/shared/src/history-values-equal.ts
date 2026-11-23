const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Ignore Mirror's transport identity, never the contents of a historical item. */
export function historyValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => historyValuesEqual(v, b[i]));
  if (!record(a) || !record(b)) return false;
  const ak = Object.keys(a).filter((k) => k !== '$cid' && a[k] !== undefined);
  const bk = Object.keys(b).filter((k) => k !== '$cid' && b[k] !== undefined);
  return (
    ak.length === bk.length &&
    ak.every((k) => Object.hasOwn(b, k) && historyValuesEqual(a[k], b[k]))
  );
}
