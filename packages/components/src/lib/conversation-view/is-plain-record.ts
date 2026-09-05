/**
 * A JSON object: not an array, not null. `@lody/shared`'s `isRecord` admits
 * arrays deliberately, which is the wrong answer everywhere in this module.
 * The materializer keeps its own stricter variant, because it has to match
 * loro-mirror's `isPlainObjectValue` (which also rejects Date/RegExp/function).
 */
export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
