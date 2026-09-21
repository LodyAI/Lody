import { describe, expect, it } from 'vitest';
import { shouldRequestNativeQueueSteer } from '../src/components/sessions/message-queue/queued-message-steer';
import { resolveSessionMessageSubmitRoute } from '../src/components/sessions/session-message-submit-route';

const resolve = (overrides: Partial<Parameters<typeof resolveSessionMessageSubmitRoute>[0]> = {}) =>
  resolveSessionMessageSubmitRoute({
    forceDirect: false,
    forceQueue: false,
    invertBehavior: false,
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

  it('inverts a queue default into a steer for one busy submission', () => {
    expect(
      resolve({
        invertBehavior: true,
        isPromptBusy: true,
        hasUnfinishedAssistantTurn: true,
      })
    ).toEqual({ type: 'guide' });
  });

  it('inverts a guide default into a queued busy submission', () => {
    expect(
      resolve({
        invertBehavior: true,
        isPromptBusy: true,
        hasUnfinishedAssistantTurn: true,
        queuedMessageBehavior: 'guide',
      })
    ).toEqual({ type: 'queue', reason: 'prompt_busy' });
  });

  it('never steers an inverted submission without positive live activity', () => {
    expect(resolve({ invertBehavior: true, hasUnfinishedAssistantTurn: true })).toEqual({
      type: 'queue',
      reason: 'unfinished_assistant_turn',
    });
    expect(resolve({ invertBehavior: true })).toEqual({ type: 'direct_dispatch' });
    expect(resolve({ invertBehavior: true, isPromptBusy: true })).toEqual({
      type: 'queue',
      reason: 'prompt_busy',
    });
  });

  it('keeps forceQueue ahead of an inverted steer', () => {
    expect(
      resolve({
        invertBehavior: true,
        forceQueue: true,
        isPromptBusy: true,
        hasUnfinishedAssistantTurn: true,
      })
    ).toEqual({ type: 'queue', reason: 'forced' });
  });

  describe.each([
    ['configured guide', 'guide', false],
    ['inverted queue', 'queue', true],
  ] as const)('%s', (_label, queuedMessageBehavior, invertBehavior) => {
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
          invertBehavior,
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
