import type { LabEvent } from './scheduler';

export interface PublicTrace {
  readonly events: readonly LabEvent[];
}

export function publicTrace(events: readonly LabEvent[]): PublicTrace {
  return { events };
}
