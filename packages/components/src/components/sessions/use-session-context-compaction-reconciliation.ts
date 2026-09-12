import { useEffect, useRef } from 'react';
import type { MachineId, SessionId } from '@lody/shared';

import type { WorkspaceRuntime } from '@/atoms/runtime';
import type { ActiveSessionContextCompaction } from '@/lib/session-context-compaction';

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
  const lastAttemptEvidenceRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      !runtime ||
      !canReconcile ||
      !isConnectivityOnline ||
      isSessionActive ||
      !activeCompaction?.turnFinished
    ) {
      lastAttemptEvidenceRef.current = null;
      return;
    }
    const evidence = JSON.stringify([
      sessionId,
      activeCompaction.turnId,
      activeCompaction.toolCallId,
      ownerInstanceId,
      isConnectivityOnline,
    ]);
    if (lastAttemptEvidenceRef.current === evidence) return;
    lastAttemptEvidenceRef.current = evidence;
    void runtime
      .requestSessionContextCompactionReconciliation(machineId, {
        sessionId,
        turnId: activeCompaction.turnId,
        toolCallId: activeCompaction.toolCallId,
      })
      .catch(() => undefined);
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
