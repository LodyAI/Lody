import { createSessionPreparationLease } from '@/lib/session-preparation-lease';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { buildSessionPreparationRequestKey } from '@lody/shared';
import type {
  AgentConfigCliType,
  AgentConfigId,
  MachineId,
  ProjectRef,
  SessionId,
  SessionPreparationRunConfig,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

const PREPARE_DEBOUNCE_MS = 650;
const PREPARE_IDLE_TIMEOUT_MS = 30_000;

type ActivePreparation = {
  preparationId: string;
  sessionId: SessionId;
  machineId: MachineId;
  requestedByUserId: string;
  runtime: WorkspaceRuntime;
  lease: ReturnType<typeof createSessionPreparationLease>;
};

type PreparationInput = {
  runtime: WorkspaceRuntime | null;
  machineId: MachineId | null;
  requestedByUserId: string | null;
  agentConfigId: AgentConfigId | null;
  cliType: AgentConfigCliType | null;
  agentType: string | null;
  project?: ProjectRef;
  runConfig?: SessionPreparationRunConfig;
  sessionId: SessionId | null;
  ensureSessionId: () => SessionId;
  enabled: boolean;
  /** Local-only monotonic signal. Its value is never sent to the machine. */
  activityRevision: string | number;
};

export type SessionPreparationController = {
  cancel: () => void;
  /** Transfers an active draft lease to the durable session without cancelling it. */
  handoffToSession: (sessionId: SessionId) => boolean;
};

function createPreparationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useSessionPreparation(input: PreparationInput): SessionPreparationController {
  const latestRef = useRef(input);
  latestRef.current = input;
  const activeRef = useRef<ActivePreparation | null>(null);
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestKey = useMemo(
    () =>
      input.requestedByUserId && input.agentConfigId && input.cliType && input.agentType
        ? JSON.stringify([
            input.machineId,
            buildSessionPreparationRequestKey({
              requestedByUserId: input.requestedByUserId,
              agentConfigId: input.agentConfigId,
              cliType: input.cliType,
              agentType: input.agentType,
              project: input.project,
              runConfig: input.runConfig,
            }),
          ])
        : null,
    [
      input.agentConfigId,
      input.agentType,
      input.cliType,
      input.machineId,
      input.project,
      input.requestedByUserId,
      input.runConfig,
    ]
  );

  const clearStartTimer = useCallback(() => {
    if (startTimerRef.current) {
      clearTimeout(startTimerRef.current);
      startTimerRef.current = null;
    }
  }, []);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const cancelActive = useCallback(() => {
    const active = activeRef.current;
    activeRef.current = null;
    if (!active) return;
    active.lease.cancel();
  }, []);

  const handoffToSession = useCallback(
    (sessionId: SessionId): boolean => {
      clearStartTimer();
      clearIdleTimer();
      const active = activeRef.current;
      if (!active || active.sessionId !== sessionId) return false;
      activeRef.current = null;
      return active.lease.handoff();
    },
    [clearIdleTimer, clearStartTimer]
  );

  const scheduleStart = useCallback((delayMs: number) => {
    if (startTimerRef.current || activeRef.current) return;
    startTimerRef.current = setTimeout(() => {
      startTimerRef.current = null;
      const current = latestRef.current;
      if (
        !current.enabled ||
        !current.runtime ||
        !current.machineId ||
        !current.requestedByUserId ||
        !current.agentConfigId ||
        !current.cliType ||
        !current.agentType
      ) {
        return;
      }
      const sessionId = current.sessionId ?? current.ensureSessionId();
      const preparationId = createPreparationId();
      const lease = createSessionPreparationLease(current.runtime, current.machineId, {
        preparationId,
        sessionId,
        requestedByUserId: current.requestedByUserId,
        agentConfigId: current.agentConfigId,
        cliType: current.cliType,
        agentType: current.agentType,
        project: current.project,
        runConfig: current.runConfig,
      });
      const active: ActivePreparation = {
        preparationId,
        sessionId,
        machineId: current.machineId,
        requestedByUserId: current.requestedByUserId,
        runtime: current.runtime,
        lease,
      };
      activeRef.current = active;
      void lease.ready.then(
        (response) => {
          if (activeRef.current !== active || response?.accepted) return;
          activeRef.current = null;
          active.lease.cancel();
        },
        () => {
          if (activeRef.current !== active) return;
          activeRef.current = null;
          active.lease.cancel();
        }
      );
    }, delayMs);
  }, []);

  useEffect(() => {
    clearStartTimer();
    cancelActive();
    if (input.enabled) {
      scheduleStart(PREPARE_DEBOUNCE_MS);
    }
    return () => {
      clearStartTimer();
      cancelActive();
    };
  }, [cancelActive, clearStartTimer, input.enabled, input.runtime, requestKey, scheduleStart]);

  useEffect(() => {
    clearIdleTimer();
    if (!input.enabled) return undefined;
    // scheduleStart no-ops when a timer or active preparation already exists.
    scheduleStart(PREPARE_DEBOUNCE_MS);
    idleTimerRef.current = setTimeout(() => {
      clearStartTimer();
      cancelActive();
    }, PREPARE_IDLE_TIMEOUT_MS);
    return () => {
      clearIdleTimer();
    };
  }, [
    cancelActive,
    clearIdleTimer,
    clearStartTimer,
    input.activityRevision,
    input.enabled,
    scheduleStart,
  ]);

  return useMemo(
    () => ({
      handoffToSession,
      cancel: () => {
        clearStartTimer();
        clearIdleTimer();
        cancelActive();
      },
    }),
    [handoffToSession, clearStartTimer, clearIdleTimer, cancelActive]
  );
}
