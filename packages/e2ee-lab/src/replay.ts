import type { LabEvent } from './scheduler';

export interface Divergence {
  readonly index: number;
  readonly expected: LabEvent | undefined;
  readonly actual: LabEvent | undefined;
}

export function firstDivergence(
  expected: readonly LabEvent[],
  actual: readonly LabEvent[]
): Divergence | null {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    const left = expected[index];
    const right = actual[index];
    if (
      !left ||
      !right ||
      left.actor !== right.actor ||
      left.operation !== right.operation ||
      left.phase !== right.phase ||
      left.status !== right.status
    ) {
      return { index, expected: left, actual: right };
    }
  }
  return null;
}

export function eventSignature(events: readonly LabEvent[]): string {
  return events
    .map((event) => `${event.actor}:${event.operation}:${event.phase}:${event.status}`)
    .join('|');
}
