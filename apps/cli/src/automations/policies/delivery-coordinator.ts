import { Clock, Effect, Semaphore } from 'effect';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionAutoDelivery,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { autoDeliverOptionsSchema, type AutomationSettings } from '@lody/shared/automations';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import type { AutomationLedger } from '../storage/ledger';
import { configureSessionPolicies, sessionPolicySettings } from './session';
import {
  advanceDelivery,
  DELIVERY_EVENT_SOURCE,
  readDeliveryProgress,
  startDeliveryEpoch,
} from './delivery';

export type DeliveryCoordinatorDeps = {
  ledger: AutomationLedger;
  manager: LoroDocumentManager;
  machineId: string;
  logger: Logger;
};

const CANCELLABLE_STATES = new Set([
  'accepted',
  'waiting',
  'resolved',
  'blocked',
  'submitting',
  'queued',
]);

export const deliveryStatusKey = (
  status: Omit<SessionAutoDelivery, 'updatedAt'> | null | undefined
): string =>
  status
    ? JSON.stringify([
        status.state,
        status.attempt,
        status.reason,
        status.blockReason,
        status.prUrl,
        status.prIndex,
        status.prTotal,
      ])
    : '';

/**
 * Owns Auto delivery advancement, `SessionMeta.autoDelivery` status publication,
 * PR poller demand reporting, and disable-time withdrawal. Shares one Effect
 * `Semaphore` separate from the engine gate so turning delivery off never waits
 * behind condition checks and a running pass cannot republish cleared status.
 */
export class DeliveryCoordinator {
  private readonly statusLock = Semaphore.makeUnsafe(1);

  constructor(private readonly deps: DeliveryCoordinatorDeps) {}

  private withStatusLock<A>(body: (now: number) => Promise<A>): Effect.Effect<A, unknown> {
    return this.statusLock.withPermit(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Effect.tryPromise({ try: () => body(now), catch: (cause) => cause })
        ),
        Effect.uninterruptible
      )
    );
  }

  /** Advance all enabled Auto delivery rules on this machine and sync status transitions. */
  advanceAll(): Effect.Effect<void, unknown> {
    return this.withStatusLock(async (now) => {
      const { ledger, manager, machineId, logger } = this.deps;
      for (const rule of ledger.rules()) {
        const sessionId = rule.scope.sessionId;
        if (
          !rule.enabled ||
          !sessionId ||
          rule.handler.kind !== 'policy' ||
          rule.handler.policy !== 'auto-deliver' ||
          rule.ownerMachineId !== machineId
        )
          continue;
        try {
          const options = autoDeliverOptionsSchema.parse(rule.handler.options);
          const roomId = getSessionRoomId(sessionId as SessionId);
          const record = await manager.repo.getDocMeta(roomId);
          const meta = record?.meta as SessionMeta | undefined;
          if (!record || !meta || isLoroRepoDocDeleted(record) || meta.isArchived) continue;
          const decision = advanceDelivery({ ledger, meta, options, now });
          if (decision.finished) {
            configureSessionPolicies(
              ledger,
              sessionId,
              rule.ownerUserId,
              { autoDeliver: false },
              now
            );
          }
          if (deliveryStatusKey(meta.autoDelivery) !== deliveryStatusKey(decision.status)) {
            const pr = decision.observed;
            logger.debug(`Auto delivery ${sessionId}: ${deliveryStatusKey(decision.status)}`, {
              step: decision.step?.step,
              ...(pr
                ? {
                    provider: pr.provider,
                    head: pr.headSha,
                    status: pr.status,
                    checks: pr.checks,
                    mergeability: pr.mergeability,
                    observedAt: pr.observedAt,
                  }
                : {}),
              workspaceDirty: meta.workspaceDirty,
              workspaceUnpushed: meta.workspaceUnpushed,
            });
            await manager.repo.upsertDocMeta(roomId, {
              autoDelivery: { ...decision.status, updatedAt: now },
            });
          }
        } catch (cause) {
          // One Session's failure leaves the others' delivery running.
          logger.warn(`Auto delivery pass failed for ${sessionId}`, cause);
        }
      }
    });
  }

  /** Sessions with active Auto delivery demand for PR poller high-lane scheduling. */
  observationOwners(): Set<SessionId> {
    const owners = new Set<SessionId>();
    for (const rule of this.deps.ledger.rules()) {
      if (
        rule.enabled &&
        rule.scope.sessionId &&
        rule.handler.kind === 'policy' &&
        rule.handler.policy === 'auto-deliver' &&
        rule.ownerMachineId === this.deps.machineId
      ) {
        owners.add(rule.scope.sessionId as SessionId);
      }
    }
    return owners;
  }

  /**
   * Apply Session policy settings atomically under the delivery status semaphore,
   * starting a fresh delivery epoch on enable and clearing status + withdrawing
   * any unsent/queued delivery receipt on disable.
   */
  configureSession(input: {
    sessionId: string;
    principal: string;
    settings: AutomationSettings;
    currentTurn?: string;
    runEffect: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
    cancelReceipt: (receiptId: string) => Promise<void>;
  }): Promise<void> {
    const { ledger, manager } = this.deps;
    const { sessionId, principal, settings, currentTurn, runEffect, cancelReceipt } = input;
    return runEffect(
      this.withStatusLock(async (now) => {
        const previous = sessionPolicySettings(ledger, sessionId);
        const wasRecoveryEnabled = previous.recoverCapacity === true;
        const enablesDelivery =
          typeof settings.autoDeliver === 'object' && typeof previous.autoDeliver !== 'object';
        ledger.configureSession(
          () => {
            if (enablesDelivery) startDeliveryEpoch(ledger, sessionId, now);
            configureSessionPolicies(ledger, sessionId, principal, settings, now);
          },
          sessionId,
          !wasRecoveryEnabled ? currentTurn : undefined,
          now
        );
        if (settings.autoDeliver === false) {
          await manager.repo.upsertDocMeta(getSessionRoomId(sessionId as SessionId), {
            autoDelivery: null,
          });
        }
      })
    ).then(async () => {
      if (settings.autoDeliver !== false) return;
      const lastStep = readDeliveryProgress(ledger, sessionId)?.lastStep;
      if (!lastStep) return;
      for (const receipt of ledger.eventReceipts(DELIVERY_EVENT_SOURCE, lastStep.eventId)) {
        if (CANCELLABLE_STATES.has(receipt.state)) {
          await cancelReceipt(receipt.id);
        }
      }
    });
  }
}
