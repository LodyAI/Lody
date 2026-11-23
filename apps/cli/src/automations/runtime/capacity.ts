import type { CapacityObservation, ConditionObservation } from '@lody/shared/automations';

export function evaluateCapacity(
  observation: CapacityObservation | undefined,
  binding: { bindingId: string; fingerprint: string; modelId?: string },
  now: number
): ConditionObservation {
  if (
    !observation ||
    observation.bindingId !== binding.bindingId ||
    observation.fingerprint !== binding.fingerprint ||
    (observation.modelId !== undefined && observation.modelId !== binding.modelId)
  )
    return { value: 'unknown', reason: 'capacity_binding_unobserved' };
  if (observation.authentication === 'invalid' || observation.billing === 'invalid')
    return { value: 'no', reason: 'capacity_account_unavailable' };
  if (observation.observedAt > now || observation.validUntil <= now)
    return { value: 'unknown', reason: 'capacity_observation_stale' };
  if (
    observation.windows.some(
      (window) =>
        (window.observedAt ?? observation.observedAt) > now ||
        (window.validUntil ?? observation.validUntil) <= now
    )
  )
    return { value: 'unknown', reason: 'capacity_window_stale' };
  const exhausted = observation.windows.filter((window) => window.usedPercent >= 100);
  if (exhausted.length) {
    const deadlines = exhausted.map((window) => window.resetsAt);
    const future = deadlines.filter((value): value is number => value !== undefined && value > now);
    return {
      value: 'no',
      reason: 'capacity_exhausted',
      retryAt: future.length === exhausted.length ? Math.max(...future) : undefined,
    };
  }
  if (
    !observation.windows.length ||
    observation.source === 'exhaustion' ||
    observation.authentication !== 'valid' ||
    observation.billing !== 'valid' ||
    observation.windows.some(
      (window) => !Number.isFinite(window.usedPercent) || window.usedPercent < 0
    )
  )
    return { value: 'unknown', reason: 'capacity_evidence_incomplete' };
  return { value: 'yes', reason: 'capacity_available' };
}
