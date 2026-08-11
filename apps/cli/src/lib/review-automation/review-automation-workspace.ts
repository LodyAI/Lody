import { getReviewPolicyFlockDocId, type MachineId, type WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { streamsRoomBinding } from '@/lib/loro/streams-room-binding';
import { ReviewAutomationScheduler } from './review-automation-scheduler';
import type { ReviewAutomationEngine } from './review-automation-engine';

export type ReviewAutomationWorkspaceHandle = {
  evaluate: () => Promise<void>;
  dispose: () => Promise<void>;
};

export type ReviewAutomationWorkspaceOptions = {
  documentManager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  logger: Logger;
  engine: ReviewAutomationEngine;
};

/**
 * Per-workspace wiring: watches the review Flock document and the session
 * metadata that the run reacts to, and drives the scheduler.
 *
 * Three signals matter and they are genuinely different. The review document
 * changes when a reviewer submits or a state advances. Session metadata changes
 * when a turn ends, a PR appears, or the PR reconciler writes new CI state —
 * that last one is how "CI went green" reaches this loop at all. And meta-room
 * sync is the "we are connected again" edge, without which a run held while
 * offline would wait for unrelated activity to wake it.
 */
export function createReviewAutomationWorkspace(
  options: ReviewAutomationWorkspaceOptions
): ReviewAutomationWorkspaceHandle {
  const { documentManager, workspaceId, machineId, logger, engine } = options;

  const scheduler = new ReviewAutomationScheduler({
    repo: documentManager.repo,
    workspaceId,
    machineId,
    logger,
    ownsSession: async (sessionId) => {
      try {
        const doc = await documentManager.getOrCreateSessionDoc(sessionId);
        const meta = await doc.getMetaState();
        return meta?.machineId === machineId;
      } catch {
        return false;
      }
    },
    step: (sessionId) => engine.step(sessionId),
    recordFailure: (sessionId, message) => engine.recordFailure(sessionId, message),
    isMachineOnline: () => documentManager.isTransportConnected(),
  });

  let disposed = false;
  let unsubscribeFlock: (() => void) | null = null;
  let joined: { unsubscribe: () => void } | null = null;

  // Session metadata is how CI state reaches this loop: the PR reconciler writes
  // `pullRequestState` there, so "CI went green" is a metadata event, not a poll.
  const metaWatch = documentManager.repo.watch(
    () => {
      if (disposed) {
        return;
      }
      void scheduler.evaluate().catch(() => undefined);
    },
    { kinds: ['doc-metadata'] }
  );

  // Parked-work release: same reasoning as task automation, so it uses the
  // cheap unthrottled online edge.
  const detachReconnect = documentManager.onStreamsOnline(() => {
    if (disposed) {
      return;
    }
    void scheduler.evaluate().catch(() => undefined);
  });

  void (async () => {
    try {
      const handle = await documentManager.repo.openFlockDoc(
        getReviewPolicyFlockDocId(workspaceId)
      );
      if (disposed) {
        return;
      }
      unsubscribeFlock = handle.flock.subscribe(() => {
        if (disposed) {
          return;
        }
        void scheduler.evaluate().catch(() => undefined);
      });
      const subscription = await handle.joinRoom();
      if (disposed) {
        subscription.unsubscribe();
        return;
      }
      joined = subscription;
      // Binding, not classic: while no transport is attached this stays
      // pending (settling after a later attach) instead of throwing.
      await streamsRoomBinding(subscription).firstSyncedWithRemote;
      if (!disposed) {
        // Resume whatever was in flight before this daemon started.
        await scheduler.evaluate();
      }
    } catch (error) {
      if (!disposed) {
        // Attach failure means auto review is dead for this workspace until the
        // next daemon start, and the user was told it is watching their branch.
        logger.warn(
          `[review-automation] failed to attach review document: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  })();

  return {
    evaluate: () => scheduler.evaluate(),
    dispose: async () => {
      disposed = true;
      scheduler.stop();
      metaWatch.unsubscribe();
      detachReconnect();
      unsubscribeFlock?.();
      joined?.unsubscribe();
    },
  };
}
