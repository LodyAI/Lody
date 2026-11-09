// Type guard: narrows an arbitrary value to a plain object whose keys
// are strings and values are unknown. The cheapest possible check that
// still excludes `null` (`typeof null === 'object'`) and arrays vs.
// objects are intentionally both treated as records here — JSON parsing
// boundaries usually need to inspect either shape.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
