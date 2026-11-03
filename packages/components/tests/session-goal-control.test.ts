import { describe, expect, it } from 'vitest';
import {
  getSessionGoalCommands,
  isSessionPromptBusy,
} from '../src/components/sessions/session-goal-control';

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
