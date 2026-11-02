import { v5 as uuidv5, validate as validUuid } from 'uuid';
import { quotaReservationIdentity } from '@lody/shared';
import type { ScheduleRun } from './schedule-store';

/** Older shortcut identities lack the failed Turn, including after pause or resume. */
export function isUnassociatedQuotaReservation(run: ScheduleRun): boolean {
  const definition = run.definition;
  if (
    !run.message ||
    definition.destination.kind !== 'existing_session' ||
    definition.trigger.kind !== 'once' ||
    run.message.inputBlocks.length !== 1
  )
    return false;
  const block = run.message.inputBlocks[0];
  if (block?.type !== 'text' || block.text !== 'continue') return false;
  const resetAt = Date.parse(definition.trigger.at) - 1000;
  if (!Number.isFinite(resetAt)) return false;
  const sessionId = definition.destination.sessionId;
  const id = definition.scheduleId;
  const isOriginal = ['claude-quota-continue', 'claude-quota-continue-v2'].some(
    (version) =>
      uuidv5(JSON.stringify([version, run.workspaceId, sessionId, resetAt]), uuidv5.URL) === id
  );
  return isOriginal;
}

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
