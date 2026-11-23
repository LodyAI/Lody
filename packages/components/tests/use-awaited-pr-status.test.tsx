// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrStatus } from '@lody/shared';
import {
  AWAITED_PR_STATUS_TIMEOUT_MS,
  useAwaitedPrStatus,
  type AwaitedPrStatus,
} from '../src/hooks/use-awaited-pr-status';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const first = 'https://github.com/example/repo/pull/1';
const second = 'https://github.com/example/repo/pull/2';

describe('useAwaitedPrStatus', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: AwaitedPrStatus;

  function Probe({ url, status }: { url: string | null; status: PrStatus | null }) {
    const result = useAwaitedPrStatus(url, status);
    useEffect(() => {
      current = result;
    });
    return null;
  }

  const render = async (url: string | null, status: PrStatus | null) => {
    await act(async () => root.render(createElement(Probe, { url, status })));
  };

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

  it('awaits until the shared status reaches a target', async () => {
    await render(first, 'open');
    await act(async () => current.awaitStatus(['merged']));
    expect(current.awaiting).toEqual(['merged']);

    await render(first, 'open');
    expect(current.awaiting).toEqual(['merged']);

    await render(first, 'merged');
    expect(current.awaiting).toBeNull();
    await render(first, 'open');
    expect(current.awaiting).toBeNull();
  });

  it('stops awaiting after the timeout when the shared status never changes', async () => {
    await render(first, 'draft');
    await act(async () => current.awaitStatus(['open']));
    await act(async () => vi.advanceTimersByTime(AWAITED_PR_STATUS_TIMEOUT_MS - 1));
    expect(current.awaiting).toEqual(['open']);
    await act(async () => vi.advanceTimersByTime(1));
    expect(current.awaiting).toBeNull();
  });

  it('does not carry an await over to another PR', async () => {
    await render(first, 'open');
    await act(async () => current.awaitStatus(['merged']));
    await render(second, 'open');
    expect(current.awaiting).toBeNull();
    await render(first, 'open');
    expect(current.awaiting).toBeNull();
  });
});
