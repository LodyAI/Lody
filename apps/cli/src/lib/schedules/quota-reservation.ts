import { validate as validUuid } from 'uuid';
import { quotaReservationIdentity } from '@lody/shared';
import type { ScheduleRun } from './schedule-store';

export function isQuotaReservationCandidate(run: ScheduleRun): boolean {
  const definition = run.definition;
  if (
    !run.message ||
    definition.destination.kind !== 'existing_session' ||
    definition.trigger.kind !== 'once' ||
    !definition.scheduleId.startsWith('qc3_')
  )
    return false;
  const id = definition.scheduleId.slice(4);
  const block = run.message.inputBlocks[0];
  return (
    validUuid(id) &&
    run.message.inputBlocks.length === 1 &&
    block?.type === 'text' &&
    block.text === 'continue'
  );
}

export function matchesQuotaReservation(run: ScheduleRun, turnId: string): boolean {
  if (!isQuotaReservationCandidate(run)) return false;
  const definition = run.definition;
  if (definition.destination.kind !== 'existing_session' || definition.trigger.kind !== 'once')
    return false;
  const resetAt = Date.parse(definition.trigger.at) - 1000;
  if (!Number.isFinite(resetAt)) return false;
  return (
    definition.scheduleId ===
    quotaReservationIdentity(run.workspaceId, definition.destination.sessionId, resetAt, turnId)
      .scheduleId
  );
}
