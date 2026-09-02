import { describe, it, expect, vi } from 'vitest';
import { SessionTransientStore } from './session-transient-store';
import type { SessionId } from '@lody/shared';

const sid = (id: string) => id as SessionId;

describe('SessionTransientStore', () => {
  describe('get / has', () => {
    it('creates state lazily on first access', () => {
      const store = new SessionTransientStore();
      expect(store.has(sid('s1'))).toBe(false);
      const state = store.get(sid('s1'));
      expect(store.has(sid('s1'))).toBe(true);
      expect(state.turn).toEqual({ phase: 'idle' });
    });

    it('returns the same object on repeated access', () => {
      const store = new SessionTransientStore();
      const a = store.get(sid('s1'));
      const b = store.get(sid('s1'));
      expect(a).toBe(b);
    });
  });

  describe('turn lifecycle', () => {
    it('transitions idle → prompting → finalizing → idle', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      // idle
      expect(store.getTurnId(id)).toBeUndefined();
      expect(store.getActiveTurnId(id)).toBeUndefined();

      // begin turn → prompting
      store.beginTurn(id, { turnId: 'turn-1' });
      expect(store.getTurnId(id)).toBe('turn-1');
      expect(store.getActiveTurnId(id)).toBe('turn-1');
      expect(store.isPrompting(id, 'turn-1')).toBe(true);

      // prompt returned → finalizing
      store.markPromptReturned(id, 'turn-1');
      expect(store.getTurnId(id)).toBe('turn-1');
      expect(store.getActiveTurnId(id)).toBeUndefined(); // no longer cancellable
      expect(store.isPrompting(id, 'turn-1')).toBe(false);

      // clear turn state → idle
      store.clearTurnState(id);
      expect(store.getTurnId(id)).toBeUndefined();
      expect(store.getActiveTurnId(id)).toBeUndefined();
    });

    it('markPromptReturned is a no-op if turnId does not match', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, { turnId: 'turn-1' });
      store.markPromptReturned(id, 'stale-turn');
      // Should still be prompting
      expect(store.getActiveTurnId(id)).toBe('turn-1');
    });

    it('isPrompting returns false for unknown session', () => {
      const store = new SessionTransientStore();
      expect(store.isPrompting(sid('unknown'), 'turn-1')).toBe(false);
    });

    it('tracks and clears ACP replay suppression around a resumed turn', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginAcpReplaySuppression(id);
      expect(store.recordSuppressedAcpReplay(id)).toBe(true);
      expect(store.recordSuppressedAcpReplay(id)).toBe(true);

      store.beginTurn(id, { turnId: 'turn-1' });
      expect(store.getTurnId(id)).toBe('turn-1');
      expect(store.endAcpReplaySuppression(id)).toBe(2);
      expect(store.recordSuppressedAcpReplay(id)).toBe(false);
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

    it('keeps finalized-turn ACP routing until a deferred turn binds for its prompt', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, { turnId: 'turn-1' });
      const finalizedTarget = store.getCurrentACPUpdateTarget(id);
      expect(finalizedTarget).toBeDefined();
      if (!finalizedTarget) throw new Error('expected active ACP update target');
      store.rememberFinalizedTurnForLateACPUpdates(id, finalizedTarget);
      store.clearTurnState(id);

      const deferred = store.beginTurn(id, { turnId: 'turn-2', ownsACPUpdates: false });

      expect(store.getCurrentACPUpdateTarget(id)).toMatchObject({
        turnId: 'turn-1',
        source: 'finalized_turn',
      });

      expect(
        store.bindTurnForPrompt(id, {
          turnId: 'turn-2',
          turnEpoch: deferred,
          assistantEntryId: 'turn-2',
        })
      ).toBe('bound');
      expect(store.getCurrentACPUpdateTarget(id)).toMatchObject({
        turnId: 'turn-2',
        source: 'active_turn',
      });
    });

    it('bindTurnForPrompt refuses a session whose state is gone, without recreating it', () => {
      // Binding is an authoritative write, so it must not resurrect a deleted or
      // GC'd session: the prompt would run against a target nothing reads.
      const store = new SessionTransientStore();
      const id = sid('s1');

      const epoch = store.beginTurn(id, { turnId: 'turn-1' });
      const ref = { turnId: 'turn-1', turnEpoch: epoch, assistantEntryId: 'turn-1' };
      store.deleteSession(id);

      expect(store.bindTurnForPrompt(id, ref)).toBe('session_state_missing');
      expect(store.has(id)).toBe(false);
    });

    it('bindTurnForPrompt refuses when a different turn owns the session state', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      const epoch = store.beginTurn(id, { turnId: 'turn-1', ownsACPUpdates: false });
      const staleRef = { turnId: 'turn-1', turnEpoch: epoch, assistantEntryId: 'turn-1' };

      // Turn cleared, then a redispatch reuses the same turn id at a new epoch.
      store.clearTurnState(id);
      store.beginTurn(id, { turnId: 'turn-1', ownsACPUpdates: false });

      expect(store.bindTurnForPrompt(id, staleRef)).toBe('turn_superseded');

      // The live turn's routing was left untouched by the refusal.
      expect(store.getCurrentACPUpdateTarget(id)).toBeUndefined();
    });

    it('bindTurnForPrompt refuses a turn that was already cleared', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      const epoch = store.beginTurn(id, { turnId: 'turn-1' });
      const ref = { turnId: 'turn-1', turnEpoch: epoch, assistantEntryId: 'turn-1' };
      store.clearTurnState(id);

      expect(store.bindTurnForPrompt(id, ref)).toBe('turn_superseded');
      expect(store.has(id)).toBe(true);
    });

    it('bindTurnForPrompt drops a stale late target so replay cannot leak into the new turn', () => {
      // Binding is what hands routing to the new turn, and it must also drop the
      // previous turn's late-update target — otherwise output produced between
      // the two turns keeps landing on the old assistant entry.
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, { turnId: 'turn-1' });
      const previous = store.getCurrentACPUpdateTarget(id);
      if (!previous) throw new Error('expected active ACP update target');
      store.rememberFinalizedTurnForLateACPUpdates(id, previous);
      store.clearTurnState(id);

      const epoch = store.beginTurn(id, { turnId: 'turn-2', ownsACPUpdates: false });
      expect(store.getLateACPUpdateTargetAssistantEntryId(id)).toBe('turn-1');

      expect(
        store.bindTurnForPrompt(id, {
          turnId: 'turn-2',
          turnEpoch: epoch,
          assistantEntryId: 'turn-2',
        })
      ).toBe('bound');
      expect(store.getLateACPUpdateTargetAssistantEntryId(id)).toBeUndefined();
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

    it('finalizeIfCurrent reads the routing target at commit time, not from a caller snapshot', () => {
      // The turn starts deferred, so a target read before the finalizer's awaits
      // is `undefined`. Claiming routing mid-finalization must still produce a
      // late-update target — reading it up front and committing that stale value
      // is what dropped a whole turn of agent output.
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, {
        turnId: 'turn-1',
        assistantEntryId: 'assistant-user-1',
        userTurnId: 'user-1',
        ownsACPUpdates: false,
      });
      const ref = store.getTurnRef(id, 'turn-1');
      expect(ref).toEqual({
        turnId: 'turn-1',
        turnEpoch: 1,
        assistantEntryId: 'assistant-user-1',
      });
      if (!ref) throw new Error('expected a turn ref');
      expect(store.getCurrentACPUpdateTarget(id)).toBeUndefined();

      // ... the prompt starts while the finalizer is awaiting ...
      expect(store.bindTurnForPrompt(id, ref)).toBe('bound');

      expect(store.finalizeIfCurrent(id, ref)).toBe(true);
      expect(store.getTurnId(id)).toBeUndefined();
      expect(store.getCurrentACPUpdateTarget(id)).toMatchObject({
        assistantEntryId: 'assistant-user-1',
        turnId: 'turn-1',
        userTurnId: 'user-1',
        turnEpoch: 1,
        source: 'finalized_turn',
      });
    });

    it('getCurrentTurnRef lets a no-turnId finalize keep the late routing target', () => {
      // Teardown paths (archive, delete, child cleanup, shutdown drain) have no
      // turn id. Clearing blindly loses the routing target, so late updates that
      // arrive after the clear have nowhere to go. They must commit through the
      // same CAS. A store turn can exist with no execution runtime registered —
      // an auto-prompt turn runs inside the visible turn's runtime under its own
      // store turn id — so "no active turn runtime" cannot stand in for this.
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, {
        turnId: 'turn-1',
        assistantEntryId: 'assistant-user-1',
        userTurnId: 'user-1',
      });
      const ref = store.getCurrentTurnRef(id);
      expect(ref).toEqual({
        turnId: 'turn-1',
        turnEpoch: 1,
        assistantEntryId: 'assistant-user-1',
      });
      if (!ref) throw new Error('expected a current turn ref');

      expect(store.finalizeIfCurrent(id, ref)).toBe(true);
      expect(store.getTurnId(id)).toBeUndefined();
      expect(store.getCurrentACPUpdateTarget(id)).toMatchObject({
        assistantEntryId: 'assistant-user-1',
        turnId: 'turn-1',
        userTurnId: 'user-1',
        source: 'finalized_turn',
      });
    });

    it('finalizeIfCurrent matches on epoch, not just turn id', () => {
      // A redispatch reuses `assistant:<userTurnId>` as the turn id, so the id
      // alone cannot tell two runs of the same user turn apart.
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, { turnId: 'assistant:user-1', userTurnId: 'user-1' });
      const staleRef = store.getTurnRef(id, 'assistant:user-1');
      if (!staleRef) throw new Error('expected a turn ref');
      store.clearTurnState(id);
      store.beginTurn(id, { turnId: 'assistant:user-1', userTurnId: 'user-1' });

      expect(staleRef.turnEpoch).toBe(1);
      expect(store.getTurnRef(id, 'assistant:user-1')?.turnEpoch).toBe(2);
      expect(store.finalizeIfCurrent(id, staleRef)).toBe(false);
      expect(store.getTurnId(id)).toBe('assistant:user-1');
    });

    it('isAssistantEntryFinalizable rejects an entry a newer turn owns', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');

      store.beginTurn(id, { turnId: 'assistant:user-1', assistantEntryId: 'assistant:user-1' });
      const staleRef = store.getTurnRef(id, 'assistant:user-1');
      if (!staleRef) throw new Error('expected a turn ref');

      // Nobody owns it: the ordinary path where the turn already released.
      store.clearTurnState(id);
      expect(store.isAssistantEntryFinalizable(id, staleRef)).toBe(true);

      // A newer epoch re-adopted the same entry and is streaming into it.
      store.beginTurn(id, { turnId: 'assistant:user-1', assistantEntryId: 'assistant:user-1' });
      expect(store.isAssistantEntryFinalizable(id, staleRef)).toBe(false);

      // A different entry is unaffected.
      const otherRef = { ...staleRef, assistantEntryId: 'assistant:user-2' };
      expect(store.isAssistantEntryFinalizable(id, otherRef)).toBe(true);
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

  describe('hasPendingTurnWork', () => {
    it('returns false for unknown session', () => {
      const store = new SessionTransientStore();
      expect(store.hasPendingTurnWork(sid('unknown'))).toBe(false);
    });

    it('returns false for idle session with no pending state', () => {
      const store = new SessionTransientStore();
      store.get(sid('s1'));
      expect(store.hasPendingTurnWork(sid('s1'))).toBe(false);
    });

    it('returns true when turn is active', () => {
      const store = new SessionTransientStore();
      store.beginTurn(sid('s1'), { turnId: 'turn-1' });
      expect(store.hasPendingTurnWork(sid('s1'))).toBe(true);
    });

    it('returns true when acpUpdateBuffer has entries', () => {
      const store = new SessionTransientStore();
      const state = store.get(sid('s1'));
      state.acpUpdateBuffer.push({} as any);
      expect(store.hasPendingTurnWork(sid('s1'))).toBe(true);
    });

    it('returns true when pendingUnread is set', () => {
      const store = new SessionTransientStore();
      store.get(sid('s1')).pendingUnread = true;
      expect(store.hasPendingTurnWork(sid('s1'))).toBe(true);
    });
  });

  describe('clearTurnState', () => {
    it('clears turn-scoped state but preserves session-scoped state', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');
      const state = store.get(id);

      // Set up turn-scoped state
      store.beginTurn(id, { turnId: 'turn-1' });
      state.acpUpdateBuffer.push({} as any);
      state.permissionWaitMs = 42;
      state.pendingUnread = true;
      state.suppressAcpReplayUntilTurnStart = true;
      state.suppressedAcpReplayCount = 3;

      // Set up session-scoped state
      state.lastActivityMs = 12345;

      store.clearTurnState(id);

      // Turn state should be cleared
      expect(state.turn).toEqual({ phase: 'idle' });
      // The ACP update buffer is NOT turn-scoped: entries carry their
      // enqueue-time targets and must survive the turn clear so output
      // buffered during the finalization tail can still flush (previously
      // wiping it here silently dropped the last window of streamed output
      // at the Stop boundary).
      expect(state.acpUpdateBuffer).toHaveLength(1);
      expect(state.permissionWaitMs).toBe(0);
      expect(state.pendingUnread).toBe(false);
      expect(state.suppressAcpReplayUntilTurnStart).toBe(false);
      expect(state.suppressedAcpReplayCount).toBe(0);

      // Session state should be preserved
      expect(state.lastActivityMs).toBe(12345);
      expect(store.has(id)).toBe(true);
    });

    it('keeps the pending flush timer while buffered ACP updates remain', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');
      const state = store.get(id);

      state.acpUpdateBuffer.push({} as any);
      const timer = setTimeout(() => {}, 60_000);
      state.acpFlushTimer = timer;

      store.clearTurnState(id);

      // Buffered entries carry their own targets; the scheduled flush must
      // survive the turn clear so they still drain.
      expect(state.acpUpdateBuffer).toHaveLength(1);
      expect(state.acpFlushTimer).toBe(timer);

      // Once the buffer is empty there is nothing left to flush.
      state.acpUpdateBuffer = [];
      store.clearTurnState(id);
      expect(state.acpFlushTimer).toBeNull();

      clearTimeout(timer);
    });

    it('preserves in-flight flush and usage handler sets', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');
      const state = store.get(id);

      // Simulate in-flight work
      const flushPromise = Promise.resolve();
      state.acpFlushInFlight = flushPromise;
      const usagePromise = Promise.resolve();
      state.pendingUsageHandlers.add(usagePromise);
      const cwPromise = Promise.resolve();
      state.pendingContextWindowHandlers.add(cwPromise);

      store.clearTurnState(id);

      // These must survive so cleanup() / flushSessionUsage() can drain them
      expect(state.acpFlushInFlight).toBe(flushPromise);
      expect(state.pendingUsageHandlers.size).toBe(1);
      expect(state.pendingContextWindowHandlers.size).toBe(1);
    });

    it('cancels context window usage timer', () => {
      vi.useFakeTimers();
      try {
        const store = new SessionTransientStore();
        const id = sid('s1');
        const state = store.get(id);

        const callback = vi.fn();
        state.contextWindowUsageTimer = setTimeout(callback, 1000);

        store.clearTurnState(id);

        vi.advanceTimersByTime(2000);
        expect(callback).not.toHaveBeenCalled();
        expect(state.contextWindowUsageTimer).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('is a no-op for unknown session', () => {
      const store = new SessionTransientStore();
      // Should not throw
      store.clearTurnState(sid('unknown'));
    });
  });

  describe('deleteSession', () => {
    it('removes all state for a session', () => {
      const store = new SessionTransientStore();
      const id = sid('s1');
      store.get(id);
      expect(store.has(id)).toBe(true);

      store.deleteSession(id);
      expect(store.has(id)).toBe(false);
    });

    it('cancels context window usage timer on delete', () => {
      vi.useFakeTimers();
      try {
        const store = new SessionTransientStore();
        const id = sid('s1');
        const state = store.get(id);

        const callback = vi.fn();
        state.contextWindowUsageTimer = setTimeout(callback, 1000);

        store.deleteSession(id);
        vi.advanceTimersByTime(2000);
        expect(callback).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('sessionIds', () => {
    it('returns all tracked session IDs', () => {
      const store = new SessionTransientStore();
      store.get(sid('a'));
      store.get(sid('b'));
      store.get(sid('c'));
      store.deleteSession(sid('b'));

      const ids = store.sessionIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain('a');
      expect(ids).toContain('c');
    });
  });

  describe('multiple sessions are independent', () => {
    it('operations on one session do not affect another', () => {
      const store = new SessionTransientStore();

      store.beginTurn(sid('s1'), { turnId: 'turn-a' });
      store.beginTurn(sid('s2'), { turnId: 'turn-b' });

      store.clearTurnState(sid('s1'));

      // s1 should be idle
      expect(store.getTurnId(sid('s1'))).toBeUndefined();
      // s2 should still be prompting
      expect(store.getTurnId(sid('s2'))).toBe('turn-b');
      expect(store.getActiveTurnId(sid('s2'))).toBe('turn-b');
    });
  });
});
