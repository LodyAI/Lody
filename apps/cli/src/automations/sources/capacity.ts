import type { RateLimitsSnapshot } from 'acp-extension-core';
import type { CapacityObservation } from '@lody/shared/automations';
import type { ProviderBinding } from '@/session/automation-observations';
import { AutomationLedger, automationIdentity } from '../storage/ledger';
import { evaluateCapacity } from '../runtime/capacity';

/** Full snapshots preserve all reported windows, including equal-duration named limits. */
export function capacityObservations(
  binding: ProviderBinding,
  snapshot: RateLimitsSnapshot,
  source: 'query' | 'push',
  now: number
): CapacityObservation[] {
  const observedAt = (snapshot.fetchedAtEpochSeconds ?? NaN) * 1000;
  if (!Number.isFinite(observedAt) || observedAt > now || observedAt + 5 * 60_000 <= now) return [];
  const models = new Set<string | undefined>([
    undefined,
    ...snapshot.rateLimits.map((limit) => limit.scope.modelId),
  ]);
  return [...models].map((modelId) => ({
    ...binding,
    modelId,
    observedAt,
    validUntil: observedAt + 5 * 60_000,
    source,
    authentication: 'valid',
    billing: 'valid',
    windows: snapshot.rateLimits
      .filter((limit) => !limit.scope.modelId || limit.scope.modelId === modelId)
      .flatMap((limit) => {
        const occurrences = new Map<string, number>();
        return limit.windows.map((window) => {
          const identity = JSON.stringify([
            limit.scope.providerId,
            limit.scope.accountId,
            limit.scope.modelId,
            limit.limitId,
            window.windowDurationSeconds,
            window.label,
          ]);
          const occurrence = occurrences.get(identity) ?? 0;
          occurrences.set(identity, occurrence + 1);
          return {
            id: `${identity}:${occurrence}`,
            usedPercent: window.usedPercent,
            observedAt,
            validUntil: observedAt + 5 * 60_000,
            ...(window.resetsAtEpochSeconds !== null
              ? { resetsAt: window.resetsAtEpochSeconds * 1000 }
              : {}),
          };
        });
      }),
  }));
}

export function observeCapacity(
  ledger: AutomationLedger,
  binding: ProviderBinding,
  snapshot: RateLimitsSnapshot,
  source: 'query' | 'push',
  now: number
): void {
  for (const observation of capacityObservations(binding, snapshot, source, now)) {
    const before = ledger.capacity(binding.bindingId, observation.modelId);
    if (before && before.observedAt > observation.observedAt) continue;
    if (before?.fingerprint === observation.fingerprint) {
      const windows = new Map(
        before.windows.map((window) => [
          window.id,
          {
            ...window,
            observedAt: window.observedAt ?? before.observedAt,
            validUntil: window.validUntil ?? before.validUntil,
          },
        ])
      );
      for (const window of observation.windows)
        windows.set(window.id, {
          ...window,
          observedAt: window.observedAt ?? observation.observedAt,
          validUntil: window.validUntil ?? observation.validUntil,
        });
      observation.windows = [...windows.values()];
    }
    const available =
      evaluateCapacity(observation, { ...binding, modelId: observation.modelId }, now).value ===
      'yes';
    const wasAvailable =
      evaluateCapacity(before, { ...binding, modelId: observation.modelId }, now).value === 'yes';
    ledger.recordCapacity(
      observation,
      available && !wasAvailable
        ? {
            id: automationIdentity(
              binding.bindingId,
              observation.modelId ?? '',
              observation.observedAt
            ),
            source: `provider/${binding.bindingId}`,
            type: 'provider.capacity.available',
            version: 1,
            subject: binding.bindingId,
            observedAt: now,
            occurredAt: observation.observedAt,
            scope: { workspaceId: ledger.workspaceId },
            data: {
              bindingId: binding.bindingId,
              ...(observation.modelId ? { modelId: observation.modelId } : {}),
            },
            provenance: source === 'query' ? 'poll' : 'callback',
            completeness: 'observed',
            depth: 0,
          }
        : undefined
    );
  }
}
