import { useEffect, useRef } from 'react';
import type { MachineId, SessionId } from '@lody/shared';

import type { WorkspaceRuntime } from '@/atoms/runtime';
import {
  type ActiveSessionContextCompaction,
  getContextCompactionReconciliationAttemptKey,
  isDurableContextCompactionReconciliation,
} from '@/lib/session-context-compaction';

type ReconciliationRuntime = Pick<
  WorkspaceRuntime,
  'requestSessionContextCompactionReconciliation'
>;

export const useSessionContextCompactionReconciliation = ({
  activeCompaction,
  canReconcile,
  isConnectivityOnline,
  isSessionActive,
  machineId,
  ownerInstanceId,
  runtime,
  sessionId,
}: {
  activeCompaction: ActiveSessionContextCompaction | null;
  canReconcile: boolean;
  isConnectivityOnline: boolean;
  isSessionActive: boolean;
  machineId: MachineId;
  ownerInstanceId: string | null;
  runtime: ReconciliationRuntime | null;
  sessionId: SessionId;
}): void => {
  const attemptsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!runtime || !canReconcile || !activeCompaction?.turnFinished) {
      return;
    }
    const attemptKey = getContextCompactionReconciliationAttemptKey({
      sessionId,
      turnId: activeCompaction.turnId,
      toolCallId: activeCompaction.toolCallId,
      ownerInstanceId,
      isSessionActive,
      isConnectivityOnline,
    });
    if (attemptsRef.current.has(attemptKey)) return;
    attemptsRef.current.add(attemptKey);
    void runtime
      .requestSessionContextCompactionReconciliation(machineId, {
        sessionId,
        turnId: activeCompaction.turnId,
        toolCallId: activeCompaction.toolCallId,
      })
      .then((result) => {
        if (!isDurableContextCompactionReconciliation(result)) {
          attemptsRef.current.delete(attemptKey);
        }
      })
      .catch(() => {
        attemptsRef.current.delete(attemptKey);
      });
  }, [
    activeCompaction,
    canReconcile,
    isConnectivityOnline,
    isSessionActive,
    machineId,
    ownerInstanceId,
    runtime,
    sessionId,
  ]);
};
