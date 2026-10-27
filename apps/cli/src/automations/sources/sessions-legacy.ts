import { getSessionRoomId, isLoroRepoDocDeleted, type SessionMeta } from '@lody/shared';
import type { AutomationEvent, PendingWork } from '@lody/shared/automations';
import type { SessionAutomationObservation } from '@/session/automation-observations';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { createSessionBackend } from '@/session/session-backend';
import { AutomationLedger, automationIdentity } from '../storage/ledger';
import { observeCapacity } from './capacity';

/** Only completed tool receipts establish a boundary for automatic native continuation. */
export function hasUnresolvedToolEffects(items: readonly unknown[] | undefined): boolean {
  if (!items) return true;
  return items.some((item) => {
    if (!item || typeof item !== 'object') return true;
    const entry = item as { type?: unknown; status?: unknown };
    return (
      typeof entry.type !== 'string' || (entry.type === 'tool_call' && entry.status !== 'completed')
    );
  });
}

export async function observeSessionTurnLegacy(
  ledger: AutomationLedger,
  manager: LoroDocumentManager,
  fact: SessionAutomationObservation
): Promise<void> {
  const record = await manager.repo.getDocMeta(getSessionRoomId(fact.sessionId));
  if (!record || isLoroRepoDocDeleted(record)) return;
  const meta = record.meta as SessionMeta;
  if (meta.machineId !== ledger.machineId || meta.userId !== fact.userId) return;
  const scope = {
    workspaceId: ledger.workspaceId,
    sessionId: fact.sessionId,
    ...(meta.project?.kind === 'local' ? { projectId: meta.project.localProjectId } : {}),
  };
  const origin = fact.inputConfig._lodyAutomation;
  const currentInput = !meta.latestUserMsgId || meta.latestUserMsgId === fact.turnId;
  if (currentInput)
    ledger.supersedeWork(fact.sessionId, fact.turnId, origin?.invocationId, fact.observedAt);
  const resumed = origin?.workIntentId && ledger.work(origin.workIntentId);
  if (resumed && resumed.invocationId === origin.invocationId && resumed.state !== 'cancelled')
    ledger.putWork({
      ...resumed,
      state: fact.outcome === 'completed' ? 'settled' : fact.outcome,
      updatedAt: fact.observedAt,
    });
  const event: AutomationEvent = {
    id: automationIdentity(fact.sessionId, fact.turnId, fact.assistantTurnId, 'finalized'),
    source: `session/${fact.sessionId}`,
    type: 'session.turn.finalized',
    version: 1,
    subject: fact.turnId,
    observedAt: fact.observedAt,
    scope,
    data: {
      turnId: fact.turnId,
      assistantTurnId: fact.assistantTurnId,
      outcome: fact.outcome,
      released: fact.released,
      finalized: fact.finalized,
      ...(fact.context ? { context: fact.context } : {}),
    },
    provenance: 'callback',
    completeness: 'observed',
    ...(origin
      ? {
          causationId: origin.invocationId,
          correlationId: ledger.receipt(origin.invocationId)?.event.correlationId,
          depth: (ledger.receipt(origin.invocationId)?.event.depth ?? 0) + 1,
        }
      : { depth: 0 }),
  };
  if (fact.binding && fact.capacity)
    observeCapacity(ledger, fact.binding, fact.capacity, 'push', fact.observedAt);
  const capacity =
    fact.binding &&
    (ledger.capacity(fact.binding.bindingId, fact.modelId) ??
      ledger.capacity(fact.binding.bindingId));
  const exhausted =
    capacity?.fingerprint === fact.binding?.fingerprint &&
    capacity &&
    capacity.validUntil > fact.observedAt &&
    capacity.windows.some((window) => window.usedPercent >= 100);
  const quota =
    fact.capacityFailure === 'quota_exhausted' ||
    (fact.capacityFailure === 'rate_limited' && exhausted);
  if (quota && fact.binding && fact.nativeSessionId && fact.outcome === 'failed') {
    const doc = await manager.getOrCreateSessionDoc(fact.sessionId);
    const backend = await createSessionBackend(doc, meta);
    const read = await backend.readTurn(fact.assistantTurnId);
    const unresolvedEffects =
      !fact.finalized || read.state !== 'ready' || hasUnresolvedToolEffects(read.turn.items);
    const workId = automationIdentity(
      fact.sessionId,
      fact.turnId,
      fact.assistantTurnId,
      'pending-work'
    );
    const resets =
      capacity?.windows
        .filter((window) => window.usedPercent >= 100)
        .map((window) => window.resetsAt)
        .filter((time): time is number => time !== undefined && time > fact.observedAt) ?? [];
    const work: PendingWork = {
      id: workId,
      ownerUserId: fact.userId,
      updatedAt: fact.observedAt,
      sessionId: fact.sessionId,
      turnId: fact.turnId,
      nativeSessionId: fact.nativeSessionId,
      ...fact.binding,
      modelId: fact.modelId,
      inputRef: fact.turnId,
      confirmedBoundary: fact.assistantTurnId,
      unresolvedEffects,
      release: fact.released ? 'released' : 'unknown',
      state: currentInput ? 'blocked_on_capacity' : 'cancelled',
      notBefore: Math.max(
        fact.observedAt +
          Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(resumed ? resumed.attempts + 1 : 0, 9)),
        ...resets
      ),
      attempts: resumed ? resumed.attempts + 1 : 0,
      origin,
    };
    if (!ledger.work(work.id))
      ledger.recordWork(work, {
        ...event,
        id: workId,
        type: 'provider.quota.exhausted',
        subject: workId,
        data: {
          workId,
          bindingId: work.bindingId,
          ...(work.modelId ? { modelId: work.modelId } : {}),
          ...(work.notBefore ? { retryAt: work.notBefore } : {}),
          unresolvedEffects,
          release: work.release,
        },
      });
  }
  ledger.publish(event);
}

/** Reconcile only staged outcomes, never scan old conversations to invent unfinished work. */
export async function reconcileSessionTurnsLegacy(
  ledger: AutomationLedger,
  manager: LoroDocumentManager,
  release: (
    fact: SessionAutomationObservation
  ) => 'normal' | 'failed' | 'user_stop' | 'unreleased' | undefined,
  report: (cause: unknown) => void,
  cursor = ''
): Promise<string> {
  const staged = ledger.stagedTurns(cursor);
  for (const { id, fact } of staged) {
    try {
      const outcome = fact.released ? undefined : release(fact);
      if (!fact.released && (!outcome || outcome === 'unreleased')) continue;
      await observeSessionTurnLegacy(ledger, manager, {
        ...fact,
        released: true,
        outcome: outcome === 'user_stop' ? 'cancelled' : fact.outcome,
      });
      ledger.acknowledgeTurn(id);
    } catch (cause) {
      report(cause);
    }
  }
  return staged.at(-1)?.id ?? '';
}
