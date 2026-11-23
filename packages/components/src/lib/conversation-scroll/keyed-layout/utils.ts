/** @internal */
export const NULL = null;

/**
 * @internal
 */
export const EMPTY: readonly never[] = [];

/** @internal */
export const { min, max, abs, floor } = Math;

/**
 * @internal
 */
export const clamp = (value: number, minValue: number, maxValue: number): number =>
  min(maxValue, max(minValue, value));

/**
 * @internal
 */
export const sort = <T extends number>(arr: T[]): T[] => {
  return arr.sort((a, b) => a - b);
};
