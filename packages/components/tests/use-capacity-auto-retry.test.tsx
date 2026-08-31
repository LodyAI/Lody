/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findLatestCapacityFailureNoticeId,
  type CapacityRetryControl,
  useCapacityAutoRetry,
} from '../src/components/sessions/use-capacity-auto-retry';

const capacityFailure = (id: string) => ({
  id,
  role: 'system',
  items: [
    {
      type: 'system_notice',
      name: 'chat_failed',
      meta: { reason: 'acp_provider_overloaded' },
    },
  ],
});

const ordinaryFailure = (id: string) => ({
  id,
  role: 'system',
  items: [
    {
      type: 'system_notice',
      name: 'chat_failed',
      meta: { reason: 'acp_internal_error' },
    },
  ],
});

describe('capacity auto retry', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('only selects a capacity failure when no newer user turn supersedes it', () => {
    expect(findLatestCapacityFailureNoticeId([capacityFailure('capacity-1')])).toBe('capacity-1');
    expect(
      findLatestCapacityFailureNoticeId([
        capacityFailure('capacity-1'),
        { id: 'user-2', role: 'user', items: [] },
      ])
    ).toBeNull();
    expect(
      findLatestCapacityFailureNoticeId([
        capacityFailure('capacity-1'),
        ordinaryFailure('failure-2'),
      ])
    ).toBeNull();
  });

  it('requires one click, then retries a later capacity failure after the countdown', async () => {
    const onRetry = vi.fn().mockResolvedValue(true);
    let history = [capacityFailure('capacity-1')];
    let control: CapacityRetryControl | null = null;

    function Consumer() {
      control = useCapacityAutoRetry({
        sessionId: 'session-1',
        history,
        canRetry: true,
        onRetry,
      });
      return null;
    }

    await act(async () => root.render(<Consumer />));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(onRetry).not.toHaveBeenCalled();

    await act(async () => control?.retry());
    expect(onRetry).toHaveBeenCalledTimes(1);

    history = [
      capacityFailure('capacity-1'),
      { id: 'continuation-1', role: 'user', items: [] },
      capacityFailure('capacity-2'),
    ];
    await act(async () => root.render(<Consumer />));
    expect(control?.retryInSeconds).toBe(5);
    expect(control?.retryRemainingRatio).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(control?.retryRemainingRatio).toBeCloseTo(0.8, 1);
    await act(async () => vi.advanceTimersByTimeAsync(3_999));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not keep auto-retrying when dispatch rejects the continuation', async () => {
    const onRetry = vi.fn().mockResolvedValue(false);
    let control: CapacityRetryControl | null = null;

    function Consumer() {
      control = useCapacityAutoRetry({
        sessionId: 'session-1',
        history: [capacityFailure('capacity-1')],
        canRetry: true,
        onRetry,
      });
      return null;
    }

    await act(async () => root.render(<Consumer />));
    await act(async () => control?.retry());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(control?.autoRetryEnabled).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
