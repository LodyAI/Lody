import { describe, it, expect, vi } from 'vitest';
import { SessionTransientStore } from './session-transient-store';
import type { SessionId } from '@lody/shared';

const sid = (id: string) => id as SessionId;

describe('SessionTransientStore', () => {
  describe('turn lifecycle', () => {
    it('markPromptReturned is a no-op if turnId does not match', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, { turnId: 'turn-1' });
      store.markPromptReturned(id, 'stale-turn');
      // Should still be prompting
      expect(store.getActiveTurnId(id)).toBe('turn-1');
    });

    it('routes late ACP updates to the finalized turn until the next turn starts', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, {
        turnId: 'turn-1',
        assistantEntryId: 'assistant-user-1',
        userTurnId: 'user-1',
      });
      const target = store.getCurrentACPUpdateTarget(id);
      expect(target).toBeDefined();
      if (!target) throw new Error('expected active ACP update target');
      expect(target).toMatchObject({
        assistantEntryId: 'assistant-user-1',
        turnId: 'turn-1',
        userTurnId: 'user-1',
        turnEpoch: 1,
        source: 'active_turn',
      });
      store.rememberFinalizedTurnForLateACPUpdates(id, target);
      store.clearTurnState(id);

      expect(store.getTurnId(id)).toBeUndefined();
      expect(store.getLateACPUpdateTargetAssistantEntryId(id)).toBe('assistant-user-1');
      expect(store.getCurrentACPUpdateTarget(id)).toMatchObject({
        assistantEntryId: 'assistant-user-1',
        turnId: 'turn-1',
        userTurnId: 'user-1',
        turnEpoch: 1,
        source: 'finalized_turn',
      });

      store.beginTurn(id, { turnId: 'turn-2' });

      expect(store.getTurnId(id)).toBe('turn-2');
      expect(store.getCurrentACPUpdateTarget(id)).toMatchObject({
        assistantEntryId: 'turn-2',
        turnEpoch: 2,
        source: 'active_turn',
      });
      expect(store.getLateACPUpdateTargetAssistantEntryId(id)).toBeUndefined();
    });

    it('keeps finalized-turn ACP routing until a deferred turn activates its ACP target', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, { turnId: 'turn-1' });
      const finalizedTarget = store.getCurrentACPUpdateTarget(id);
      expect(finalizedTarget).toBeDefined();
      if (!finalizedTarget) throw new Error('expected active ACP update target');
      store.rememberFinalizedTurnForLateACPUpdates(id, finalizedTarget);
      store.clearTurnState(id);

      store.beginTurn(id, { turnId: 'turn-2', ownsACPUpdates: false });

      expect(store.getCurrentACPUpdateTarget(id)).toMatchObject({
        turnId: 'turn-1',
        source: 'finalized_turn',
      });

      store.activateTurnACPUpdateTarget(id, 'turn-2');
      expect(store.getCurrentACPUpdateTarget(id)).toMatchObject({
        turnId: 'turn-2',
        source: 'active_turn',
      });
    });

    it('never expires finalized-turn ACP update routing by wall-clock time', () => {
      // Sessions can stay alive and emit events long after a turn ends (cron jobs,
      // ScheduleWakeup, deferred background work). Late updates must keep routing to
      // the finalized turn regardless of how much time has passed — only beginTurn()
      // or replay suppression clears the target.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'));
        const store = new SessionTransientStore();
        const id = sid('s1');

        store.beginTurn(id, {
          turnId: 'turn-1',
          assistantEntryId: 'assistant-user-1',
          userTurnId: 'user-1',
        });
        const target = store.getCurrentACPUpdateTarget(id);
        expect(target).toBeDefined();
        if (!target) throw new Error('expected active ACP update target');
        store.rememberFinalizedTurnForLateACPUpdates(id, target);
        store.clearTurnState(id);

        // Far beyond the old 60s grace window.
        vi.advanceTimersByTime(60 * 60 * 1000);
        expect(store.getCurrentACPUpdateTarget(id)).toMatchObject({
          assistantEntryId: 'assistant-user-1',
          source: 'finalized_turn',
        });
        expect(store.getLateACPUpdateTargetAssistantEntryId(id)).toBe('assistant-user-1');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears late ACP update routing when ACP replay suppression begins', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, { turnId: 'turn-1' });
      const target = store.getCurrentACPUpdateTarget(id);
      expect(target).toBeDefined();
      if (!target) throw new Error('expected active ACP update target');
      store.rememberFinalizedTurnForLateACPUpdates(id, target);
      store.beginAcpReplaySuppression(id);

      expect(store.getLateACPUpdateTargetAssistantEntryId(id)).toBeUndefined();
      expect(store.recordSuppressedAcpReplay(id)).toBe(true);
    });
  });
});
