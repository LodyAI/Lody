import {
  getTaskIndexFlockDocId,
  type MachineId,
  type TaskId,
  type TaskIndexRow,
  type WorkspaceId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { streamsRoomBinding } from '@/lib/loro/streams-room-binding';
import { listMergedAgentConfigs } from '@/lib/agent-config-machine-flock';
import {
  readTaskIndexRowsForWorkspace,
  TaskAutomationScheduler,
} from './task-automation-scheduler';

export type TaskAutomationWorkspaceHandle = {
  /** Re-evaluate the queue; safe to call on every task-index change. */
  evaluate: () => Promise<void>;
  dispose: () => Promise<void>;
};

export type TaskAutomationWorkspaceOptions = {
  documentManager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  userId: string;
  logger: Logger;
  /** Starts a task on this machine; supplied by the fleet so the command layer stays owner of dispatch. */
  startTask: (taskId: TaskId, agentConfigId: string) => Promise<void>;
};

/**
 * Per-workspace wiring for delegated automation: subscribes to the task index
 * and drives the scheduler.
 *
 * The index is the right thing to watch — it is the one document that already
 * carries "entrusted to an agent, ready, still in backlog" for every task, so a
 * pass never has to open task documents.
 */
export function createTaskAutomationWorkspace(
  options: TaskAutomationWorkspaceOptions
): TaskAutomationWorkspaceHandle {
  const { documentManager, workspaceId, machineId, userId, logger, startTask } = options;
  const flockDocId = getTaskIndexFlockDocId(workspaceId);

  const readTaskIndex = (): Promise<TaskIndexRow[]> =>
    readTaskIndexRowsForWorkspace(documentManager.repo, workspaceId);

  const scheduler = new TaskAutomationScheduler({
    workspaceId,
    machineId,
    operatorUserId: userId,
    logger,
    readTaskIndex,
    listOwnedAgentConfigs: () =>
      listMergedAgentConfigs(documentManager.repo, workspaceId, [machineId]).catch(() => []),
    // Being connected is what makes this machine able to run anything; an
    // offline pass must hold the queue rather than fail the starts.
    isMachineOnline: () => documentManager.isTransportConnected(),
    startTask,
    onQueued: (taskId, position) => {
      logger.debug(`[task-automation] queued taskId=${taskId} position=${position}`);
    },
  });

  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  let joined: { unsubscribe: () => void } | null = null;
  // An offline pass holds the queue instead of failing, so something has to
  // re-evaluate once this machine is back. The index subscription alone is not
  // enough: if nothing changed remotely while we were down, no row event arrives
  // and a queued task would wait for unrelated activity. Meta-room sync is the
  // existing "we are connected again" signal.
  // Parked-work release, so it rides the cheap unthrottled online edge rather
  // than the rate-limited index-rescan signal: a queued task must not wait out
  // the fan-out floor.
  const detachReconnect = documentManager.onStreamsOnline(() => {
    if (disposed) {
      return;
    }
    void scheduler.evaluate().catch(() => undefined);
  });

  void (async () => {
    try {
      const handle = await documentManager.repo.openFlockDoc(flockDocId);
      if (disposed) {
        return;
      }
      // Seed the baseline before joining the room so the first remote catch-up
      // is not mistaken for a burst of new assignments.
      await scheduler.evaluate();
      unsubscribe = handle.flock.subscribe(() => {
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
        await scheduler.evaluate();
      }
    } catch (error) {
      if (!disposed) {
        // Attach failure means delegated automation is dead for this workspace
        // until the next daemon start; a debug line hid exactly that for every
        // user, so this stays at warn.
        logger.warn(
          `[task-automation] failed to attach task index: ${
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
      detachReconnect();
      unsubscribe?.();
      joined?.unsubscribe();
    },
  };
}
