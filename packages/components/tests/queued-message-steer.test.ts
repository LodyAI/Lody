import { describe, expect, it } from 'vitest';
import {
  resolveFallbackQueueSteerPreparation,
  shouldRequestNativeQueueSteer,
  steerQueuedMessageWithFallback,
} from '../src/components/sessions/message-queue/queued-message-steer';

describe('shouldRequestNativeQueueSteer', () => {
  it.each([
    ['authoritative', { acknowledgedSteer: true }, true],
    ['authoritative', { acknowledgedSteer: false }, false],
    ['authoritative', undefined, false],
    ['provisional', { acknowledgedSteer: true }, false],
    ['unavailable', { acknowledgedSteer: true }, false],
  ] as const)('routes %s capability %o to native steer: %s', (authority, capability, expected) => {
    expect(shouldRequestNativeQueueSteer(authority, capability)).toBe(expected);
  });
});

describe('resolveFallbackQueueSteerPreparation', () => {
  it('moves a selected later item to the queue head before interrupting', () => {
    expect(resolveFallbackQueueSteerPreparation(['first', 'second', 'third'], 'third')).toEqual({
      type: 'reorder',
      activeCid: 'third',
      overCid: 'first',
    });
  });

  it('leaves the queue head in place and rejects stale selections', () => {
    expect(resolveFallbackQueueSteerPreparation(['first', 'second'], 'first')).toEqual({
      type: 'ready',
    });
    expect(resolveFallbackQueueSteerPreparation(['first', 'second'], 'missing')).toEqual({
      type: 'missing',
    });
  });
});

describe('steerQueuedMessageWithFallback', () => {
  it('reorders a later selection before interrupting', async () => {
    const events: string[] = [];
    const result = await steerQueuedMessageWithFallback({
      queueItemCids: ['first', 'second'],
      selectedCid: 'second',
      reorder: async (activeCid, overCid) => {
        events.push(`reorder:${activeCid}:${overCid}`);
      },
      interrupt: async () => {
        events.push('interrupt');
      },
    });

    expect(result).toBe('steered');
    expect(events).toEqual(['reorder:second:first', 'interrupt']);
  });

  it('does not interrupt when reordering fails', async () => {
    const events: string[] = [];
    const result = await steerQueuedMessageWithFallback({
      queueItemCids: ['first', 'second'],
      selectedCid: 'second',
      reorder: async () => {
        events.push('reorder');
        throw new Error('reorder failed');
      },
      interrupt: async () => {
        events.push('interrupt');
      },
    });

    expect(result).toBe('reorder_failed');
    expect(events).toEqual(['reorder']);
  });
});
