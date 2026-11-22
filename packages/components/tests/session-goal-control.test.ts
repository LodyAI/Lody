import { describe, expect, it } from 'vitest';
import {
  getSessionGoalCommands,
  isSessionPromptBusy,
} from '../src/components/sessions/session-goal-control';
import {
  describeSessionContinuation,
  type SessionContinuationView,
} from '../src/components/sessions/session-continuation';
import type { SessionHistory, SessionId } from '@lody/shared';
import {
  canStopAgentEnabled,
  isSessionContextCompacting,
} from '../src/lib/session-context-compaction';
import { getSessionDetailInitialTabState } from '../src/lib/session-detail-initial-state';
import type { PersistedLastActiveTabState } from '../src/lib/session-draft-tabs';

describe('session-goal-control', () => {
  describe('session goal control availability', () => {
    it('keeps goals read-only for a runtime that advertises no goal actions', () => {
      expect(getSessionGoalCommands(undefined)).toEqual([]);
      expect(getSessionGoalCommands({ goalActions: [] })).toEqual([]);
    });

    it('offers only the subset a partial runtime advertised', () => {
      // `set` has no button of its own, and an unadvertised action must never get
      // one: pressing it would fail at the agent.
      expect(getSessionGoalCommands({ goalActions: ['set', 'clear'] })).toEqual(['clear']);
    });

    it('keeps a quiescent session direct-dispatchable while its goal remains active', () => {
      expect(
        isSessionPromptBusy({
          isDispatching: false,
          isSessionWorking: false,
          isGoalActive: true,
        })
      ).toBe(false);
    });
  });
});

describe('session-continuation', () => {
  const NOW = 1_700_000_000_000;

  function view(patch: Partial<SessionContinuationView> = {}): SessionContinuationView {
    return {
      id: 'wait-1',
      reason: '等 CI 通过后继续',
      phase: 'waiting',
      ...patch,
    };
  }

  describe('describeSessionContinuation', () => {
    it('does not offer resume when a permission stands in the way', () => {
      const described = describeSessionContinuation(
        view({ phase: 'matched', continuation: 'blocked', block: 'permission' }),
        NOW
      );

      expect(described).toMatchObject({
        visible: true,
        tone: 'attention',
        detail: 'blockedPermission',
        actions: { cancel: true, resume: false, askAgent: false },
      });
    });
  });
});

describe('session-context-compaction', () => {
  const historyWithStatus = (
    status: 'pending' | 'in_progress' | 'completed' | 'failed',
    finished = false
  ) =>
    [
      {
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
    ] as Pick<SessionHistory, 'finished' | 'items'>[];

  describe('isSessionContextCompacting', () => {
    it('does not treat host turn finalization as provider termination', () => {
      expect(isSessionContextCompacting(historyWithStatus('pending', true))).toBe(true);
      expect(isSessionContextCompacting(historyWithStatus('in_progress', true))).toBe(true);
    });
  });

  describe('canStopAgentEnabled', () => {
    const base = {
      activeAssistantTurnId: null,
      isGoalActive: false,
      canPauseGoal: false,
    };

    it('exposes Stop exactly while an assistant turn is unfinished', () => {
      // No live-activity input exists: a turn whose agent died is still
      // unfinished and must stay stoppable.
      expect(canStopAgentEnabled({ ...base, activeAssistantTurnId: 'turn-1' })).toBe(true);
      expect(canStopAgentEnabled(base)).toBe(false);
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
});

describe('session-detail-initial-state', () => {
  const parentSessionId = 'parent-session' as SessionId;

  const persistedProviderFileState: PersistedLastActiveTabState = {
    sessionTabId: 'child-session',
    viewerTab: {
      id: 'file:file-1',
      type: 'file',
      filePath: 'src/renamed.ts',
      fileId: 'file-1',
      label: 'renamed.ts',
      startLine: 4,
      endLine: 8,
      focusRequestSeq: 2,
    },
    sidePanel: {
      open: true,
      tab: 'browser',
      tabs: ['files', 'browser'],
      sideSessionId: 'side-session-1',
      split: null,
    },
  };

  describe('getSessionDetailInitialTabState', () => {
    it('keeps the restored viewer idle for an explicit conversation deep link on one-active-surface hosts', () => {
      // Mobile shows one surface at a time: an opened-by or shared link naming
      // `session:<child>` must land on that conversation, not under the
      // restored full-screen viewer. The viewer stays as an open tab.
      expect(
        getSessionDetailInitialTabState(parentSessionId, 'session:url-child', {
          oneActiveSurface: true,
          readPersistedState: () => persistedProviderFileState,
        })
      ).toEqual({
        viewerTabs: [persistedProviderFileState.viewerTab],
        activeViewerTabId: null,
        sidePanel: persistedProviderFileState.sidePanel,
      });
      expect(
        getSessionDetailInitialTabState(parentSessionId, 'draft:draft-uuid', {
          oneActiveSurface: true,
          readPersistedState: () => persistedProviderFileState,
        }).activeViewerTabId
      ).toBeNull();
      // No explicit conversation target (entry restoration will fill the tab):
      // the viewer stays active exactly as the user left it.
      expect(
        getSessionDetailInitialTabState(parentSessionId, undefined, {
          oneActiveSurface: true,
          readPersistedState: () => persistedProviderFileState,
        }).activeViewerTabId
      ).toBe('file:file-1');
    });

    it('keeps the viewer active for explicit deep links on desktop (side panel is a second surface)', () => {
      expect(
        getSessionDetailInitialTabState(parentSessionId, 'session:url-child', {
          readPersistedState: () => persistedProviderFileState,
        }).activeViewerTabId
      ).toBe('file:file-1');
    });
  });
});
