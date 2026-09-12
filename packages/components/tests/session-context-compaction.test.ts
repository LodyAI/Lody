// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  MachineId,
  SessionContextCompactionReconcileResponse,
  SessionHistory,
  SessionId,
} from '@lody/shared';

import {
  canStopAgentEnabled,
  findActiveSessionContextCompaction,
  isSessionContextCompacting,
} from '../src/lib/session-context-compaction';
import { useSessionContextCompactionReconciliation } from '../src/components/sessions/use-session-context-compaction-reconciliation';

const historyWithStatus = (
  status: 'pending' | 'in_progress' | 'completed' | 'failed',
  finished = false
) =>
  [
    {
      id: 'assistant:turn-1',
      role: 'assistant' as const,
      finished,
      items: [
        {
          type: 'tool_call',
          toolCallId: 'context-compaction-1',
          title: 'Context compacting',
          status,
          activityKind: 'context_compaction',
        },
      ],
    },
  ] as Pick<SessionHistory, 'id' | 'role' | 'finished' | 'items'>[];

describe('isSessionContextCompacting', () => {
  it('tracks pending and in-progress compaction tool calls', () => {
    expect(isSessionContextCompacting(historyWithStatus('pending'))).toBe(true);
    expect(isSessionContextCompacting(historyWithStatus('in_progress'))).toBe(true);
  });

  it('returns the exact active activity owner for reconciliation', () => {
    expect(findActiveSessionContextCompaction(historyWithStatus('in_progress'))).toEqual({
      turnId: 'assistant:turn-1',
      toolCallId: 'context-compaction-1',
      turnFinished: false,
    });
  });

  it('stops loading after compaction completes or fails', () => {
    expect(isSessionContextCompacting(historyWithStatus('completed'))).toBe(false);
    expect(isSessionContextCompacting(historyWithStatus('failed'))).toBe(false);
  });

  it('does not treat host turn finalization as provider termination', () => {
    expect(isSessionContextCompacting(historyWithStatus('pending', true))).toBe(true);
    expect(isSessionContextCompacting(historyWithStatus('in_progress', true))).toBe(true);
  });
});

describe('context compaction reconciliation retry transitions', () => {
  it('retries after the same daemon releases active Session presence', async () => {
    const sessionId = 'session-1' as SessionId;
    const machineId = 'machine-1' as MachineId;
    const activeCompaction = findActiveSessionContextCompaction(
      historyWithStatus('in_progress', true)
    );
    const request = vi.fn().mockResolvedValue({
      type: 'session/reconcile-context-compaction_response',
      sessionId,
      turnId: 'assistant:turn-1',
      toolCallId: 'context-compaction-1',
      outcome: 'retry',
    } satisfies SessionContextCompactionReconcileResponse);
    const runtime = { requestSessionContextCompactionReconciliation: request };

    const Probe = ({ isSessionActive }: { isSessionActive: boolean }) => {
      useSessionContextCompactionReconciliation({
        activeCompaction,
        canReconcile: true,
        isConnectivityOnline: true,
        isSessionRoomSynced: true,
        isSessionActive,
        machineId,
        ownerInstanceId: 'daemon-1',
        runtime,
        sessionId,
      });
      return null;
    };

    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(createElement(Probe, { isSessionActive: true })));
      expect(request).not.toHaveBeenCalled();

      await act(async () => root.render(createElement(Probe, { isSessionActive: false })));
      expect(request).toHaveBeenCalledTimes(1);

      await act(async () => root.render(createElement(Probe, { isSessionActive: false })));
      expect(request).toHaveBeenCalledTimes(1);

      await act(async () => root.render(createElement(Probe, { isSessionActive: true })));
      await act(async () => root.render(createElement(Probe, { isSessionActive: false })));
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('retries after browser connectivity returns while the local machine stays online', async () => {
    const sessionId = 'session-1' as SessionId;
    const machineId = 'machine-1' as MachineId;
    const activeCompaction = findActiveSessionContextCompaction(
      historyWithStatus('in_progress', true)
    );
    const request = vi.fn().mockResolvedValue({
      type: 'session/reconcile-context-compaction_response',
      sessionId,
      turnId: 'assistant:turn-1',
      toolCallId: 'context-compaction-1',
      outcome: 'retry',
    } satisfies SessionContextCompactionReconcileResponse);
    const runtime = { requestSessionContextCompactionReconciliation: request };

    const Probe = ({ isConnectivityOnline }: { isConnectivityOnline: boolean }) => {
      useSessionContextCompactionReconciliation({
        activeCompaction,
        canReconcile: true,
        isConnectivityOnline,
        isSessionRoomSynced: true,
        isSessionActive: false,
        machineId,
        ownerInstanceId: 'daemon-1',
        runtime,
        sessionId,
      });
      return null;
    };

    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(createElement(Probe, { isConnectivityOnline: false })));
      expect(request).not.toHaveBeenCalled();

      await act(async () => root.render(createElement(Probe, { isConnectivityOnline: false })));
      expect(request).not.toHaveBeenCalled();

      await act(async () => root.render(createElement(Probe, { isConnectivityOnline: true })));
      expect(request).toHaveBeenCalledTimes(1);

      await act(async () => root.render(createElement(Probe, { isConnectivityOnline: true })));
      expect(request).toHaveBeenCalledTimes(1);

      await act(async () => root.render(createElement(Probe, { isConnectivityOnline: false })));
      await act(async () => root.render(createElement(Probe, { isConnectivityOnline: true })));
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('retries after the Session room reconnects while browser connectivity stays online', async () => {
    const sessionId = 'session-1' as SessionId;
    const machineId = 'machine-1' as MachineId;
    const activeCompaction = findActiveSessionContextCompaction(
      historyWithStatus('in_progress', true)
    );
    const request = vi.fn().mockResolvedValue({
      type: 'session/reconcile-context-compaction_response',
      sessionId,
      turnId: 'assistant:turn-1',
      toolCallId: 'context-compaction-1',
      outcome: 'retry',
    } satisfies SessionContextCompactionReconcileResponse);
    const runtime = { requestSessionContextCompactionReconciliation: request };

    const Probe = ({ syncState }: { syncState: 'synced' | 'reconnecting' }) => {
      useSessionContextCompactionReconciliation({
        activeCompaction,
        canReconcile: true,
        isConnectivityOnline: true,
        isSessionRoomSynced: syncState === 'synced',
        isSessionActive: false,
        machineId,
        ownerInstanceId: 'daemon-1',
        runtime,
        sessionId,
      });
      return null;
    };

    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(createElement(Probe, { syncState: 'synced' })));
      expect(request).toHaveBeenCalledTimes(1);

      await act(async () => root.render(createElement(Probe, { syncState: 'reconnecting' })));
      expect(request).toHaveBeenCalledTimes(1);

      await act(async () => root.render(createElement(Probe, { syncState: 'synced' })));
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});

describe('canStopAgentEnabled', () => {
  const base = {
    isContextCompacting: false,
    isSessionActive: false,
    activeAssistantTurnId: null,
    isGoalActive: false,
    canPauseGoal: false,
  };

  it('does not expose Stop during compaction without a cancellable turn', () => {
    // A pending/in-progress compaction marker remains in history but its
    // assistant entry is already finished (restart, interrupted notification
    // stream). Stop must NOT be shown — clicking it would be rejected as
    // missing_active_turn, leaving a permanently nonfunctional button.
    expect(
      canStopAgentEnabled({ ...base, isContextCompacting: true, activeAssistantTurnId: null })
    ).toBe(false);
  });

  it('exposes Stop during compaction when a cancellable turn exists', () => {
    expect(
      canStopAgentEnabled({
        ...base,
        isContextCompacting: true,
        activeAssistantTurnId: 'turn-1',
      })
    ).toBe(true);
  });

  it('exposes Stop for an active assistant turn regardless of compaction', () => {
    expect(
      canStopAgentEnabled({
        ...base,
        isSessionActive: true,
        activeAssistantTurnId: 'turn-2',
      })
    ).toBe(true);
  });

  it('does not expose Stop for an active session without a turn', () => {
    expect(
      canStopAgentEnabled({
        ...base,
        isSessionActive: true,
        activeAssistantTurnId: null,
      })
    ).toBe(false);
  });

  it('exposes Stop for a pausable goal', () => {
    expect(
      canStopAgentEnabled({
        ...base,
        isGoalActive: true,
        canPauseGoal: true,
      })
    ).toBe(true);
  });

  it('does not expose Stop for an unpausable goal', () => {
    expect(
      canStopAgentEnabled({
        ...base,
        isGoalActive: true,
        canPauseGoal: false,
      })
    ).toBe(false);
  });
});
