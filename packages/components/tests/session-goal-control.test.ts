import { describe, expect, it } from 'vitest';
import {
  canPauseGoalThroughPromptBridge,
  getPromptBridgeGoalCommands,
  isSessionPromptBusy,
} from '../src/components/sessions/session-goal-control';

describe('session goal prompt bridge', () => {
  it('keeps provider-neutral Claude goals read-only', () => {
    expect(getPromptBridgeGoalCommands('claude')).toEqual([]);
    expect(canPauseGoalThroughPromptBridge('claude')).toBe(false);
  });

  it('keeps the existing Codex pause, resume, and clear controls', () => {
    expect(getPromptBridgeGoalCommands('codex')).toEqual(['pause', 'resume', 'clear']);
    expect(canPauseGoalThroughPromptBridge('codex')).toBe(true);
  });

  it('defaults unknown ACP providers to read-only goals', () => {
    expect(getPromptBridgeGoalCommands('custom-agent')).toEqual([]);
    expect(canPauseGoalThroughPromptBridge(undefined)).toBe(false);
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

  it('reports only dispatch and live turn activity as prompt-busy', () => {
    expect(
      isSessionPromptBusy({
        isDispatching: true,
        isSessionWorking: false,
        isGoalActive: false,
      })
    ).toBe(true);
    expect(
      isSessionPromptBusy({
        isDispatching: false,
        isSessionWorking: true,
        isGoalActive: false,
      })
    ).toBe(true);
  });
});
