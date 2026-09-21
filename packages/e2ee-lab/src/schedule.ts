import type { LabEvent } from './scheduler';

/** Stable identity for a scheduler choice. Event ids are diagnostic only. */
export interface EventIdentity {
  readonly actor: string;
  readonly operation: string;
  readonly phase: string;
  readonly parent?: string;
}

export type ScheduleKind = 'permit' | 'start' | 'attack' | 'persist' | 'crash';

export interface ScheduleChoice {
  readonly kind: ScheduleKind;
  readonly identity: EventIdentity;
  readonly occurrence: number;
  readonly eventId?: string;
}

export function eventIdentity(
  event: Pick<LabEvent, 'actor' | 'operation' | 'phase' | 'parent'>,
  events: readonly LabEvent[] = []
): EventIdentity {
  let parent: string | undefined;
  if (event.parent) {
    const row = events.find((item) => item.eventId === event.parent);
    parent = row ? `${row.actor}|${row.operation}|${row.phase}` : event.parent;
  }
  return {
    actor: event.actor,
    operation: event.operation,
    phase: event.phase,
    parent,
  };
}

export function identityKey(identity: EventIdentity): string {
  return `${identity.actor}|${identity.operation}|${identity.phase}|${identity.parent ?? ''}`;
}

export function identitiesEqual(left: EventIdentity, right: EventIdentity): boolean {
  return identityKey(left) === identityKey(right);
}

export function choiceKey(choice: ScheduleChoice): string {
  return `${choice.kind}:${identityKey(choice.identity)}#${choice.occurrence}`;
}
