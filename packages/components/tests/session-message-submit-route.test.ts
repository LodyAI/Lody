import { describe, expect, it } from 'vitest';
import { shouldRequestNativeQueueSteer } from '../src/components/sessions/message-queue/queued-message-steer';
import { resolveSessionMessageSubmitRoute } from '../src/components/sessions/session-message-submit-route';

const resolve = (overrides: Partial<Parameters<typeof resolveSessionMessageSubmitRoute>[0]> = {}) =>
  resolveSessionMessageSubmitRoute({
    forceDirect: false,
    forceQueue: false,
    behaviorOverride: null,
    nativeSteerAvailable: true,
    isPromptBusy: false,
    hasUnfinishedAssistantTurn: false,
    queuedMessageBehavior: 'queue',
    ...overrides,
  });

describe('resolveSessionMessageSubmitRoute', () => {
  it('direct-dispatches only when both live and transcript activity are idle', () => {
    expect(resolve()).toEqual({ type: 'direct_dispatch' });
  });

  it('queues across the history-before-presence ordering window', () => {
    expect(resolve({ hasUnfinishedAssistantTurn: true })).toEqual({
      type: 'queue',
      reason: 'unfinished_assistant_turn',
    });
  });

  it('does not steer without positive live prompt activity', () => {
    expect(
      resolve({
        hasUnfinishedAssistantTurn: true,
        queuedMessageBehavior: 'guide',
      })
    ).toEqual({ type: 'queue', reason: 'unfinished_assistant_turn' });
  });

  it('steers only a live prompt with a known unfinished assistant turn', () => {
    expect(
      resolve({
        isPromptBusy: true,
        hasUnfinishedAssistantTurn: true,
        queuedMessageBehavior: 'guide',
      })
    ).toEqual({ type: 'guide' });
  });

  it('honors explicit route overrides with forceDirect taking precedence', () => {
    expect(resolve({ forceQueue: true })).toEqual({ type: 'queue', reason: 'forced' });
    expect(
      resolve({
        forceDirect: true,
        forceQueue: true,
        isPromptBusy: true,
        hasUnfinishedAssistantTurn: true,
      })
    ).toEqual({ type: 'direct_dispatch' });
  });

  it('steers a guide override whatever the configured behavior', () => {
    for (const queuedMessageBehavior of ['queue', 'guide'] as const) {
      expect(
        resolve({
          behaviorOverride: 'guide',
          isPromptBusy: true,
          hasUnfinishedAssistantTurn: true,
          queuedMessageBehavior,
        })
      ).toEqual({ type: 'guide' });
    }
  });

  it('queues a queue override over a guide default', () => {
    expect(
      resolve({
        behaviorOverride: 'queue',
        isPromptBusy: true,
        hasUnfinishedAssistantTurn: true,
        queuedMessageBehavior: 'guide',
      })
    ).toEqual({ type: 'queue', reason: 'prompt_busy' });
  });

  it('keeps every steering guard for a guide override', () => {
    expect(resolve({ behaviorOverride: 'guide' })).toEqual({ type: 'direct_dispatch' });
    expect(resolve({ behaviorOverride: 'guide', hasUnfinishedAssistantTurn: true })).toEqual({
      type: 'queue',
      reason: 'unfinished_assistant_turn',
    });
    expect(resolve({ behaviorOverride: 'guide', isPromptBusy: true })).toEqual({
      type: 'queue',
      reason: 'prompt_busy',
    });
    expect(
      resolve({
        behaviorOverride: 'guide',
        nativeSteerAvailable: false,
        isPromptBusy: true,
        hasUnfinishedAssistantTurn: true,
      })
    ).toEqual({ type: 'queue', reason: 'prompt_busy' });
  });

  it('keeps forceQueue ahead of a guide override', () => {
    expect(
      resolve({
        behaviorOverride: 'guide',
        forceQueue: true,
        isPromptBusy: true,
        hasUnfinishedAssistantTurn: true,
      })
    ).toEqual({ type: 'queue', reason: 'forced' });
  });

  describe.each([
    ['configured guide', 'guide', null],
    ['guide override', 'queue', 'guide'],
  ] as const)('%s', (_label, queuedMessageBehavior, behaviorOverride) => {
    it.each([
      ['authoritative', { acknowledgedSteer: true }, 'guide'],
      ['authoritative', { acknowledgedSteer: false }, 'queue'],
      ['authoritative', undefined, 'queue'],
      ['provisional', { acknowledgedSteer: true }, 'queue'],
      ['unavailable', { acknowledgedSteer: true }, 'queue'],
    ] as const)('routes %s capability %o to %s', (authority, capability, type) => {
      expect(
        resolve({
          isPromptBusy: true,
          hasUnfinishedAssistantTurn: true,
          queuedMessageBehavior,
          behaviorOverride,
          nativeSteerAvailable: shouldRequestNativeQueueSteer(authority, capability),
        })
      ).toEqual(type === 'guide' ? { type } : { type, reason: 'prompt_busy' });
    });
  });

  it('keeps idle dispatch and explicit overrides available without native steering', () => {
    expect(resolve({ nativeSteerAvailable: false, queuedMessageBehavior: 'guide' })).toEqual({
      type: 'direct_dispatch',
    });
    expect(resolve({ nativeSteerAvailable: false, forceQueue: true })).toEqual({
      type: 'queue',
      reason: 'forced',
    });
    expect(
      resolve({
        nativeSteerAvailable: false,
        forceDirect: true,
        isPromptBusy: true,
        hasUnfinishedAssistantTurn: true,
        queuedMessageBehavior: 'guide',
      })
    ).toEqual({ type: 'direct_dispatch' });
  });
});
