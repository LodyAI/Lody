// @vitest-environment jsdom

import { act, lazy, use } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteSuspense } from '../src/components/route-suspense';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A component that suspends until the test resolves it, standing in for the
 * `lazy(() => import('@/components/main-layout'))` chunk fetch. Resolution is
 * driven explicitly — no timers, no scheduler luck.
 */
function createSuspendingChild() {
  let resolveChunk: () => void = () => {};
  const chunk = new Promise<void>((resolve) => {
    resolveChunk = resolve;
  });

  function SuspendingChild() {
    use(chunk);
    return <div data-testid="loaded-route" />;
  }

  return { SuspendingChild, resolveChunk, chunk };
}

describe('RouteSuspense', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('paints the themed surface while a lazy route chunk loads', async () => {
    const { SuspendingChild, resolveChunk, chunk } = createSuspendingChild();

    await act(async () => {
      root.render(
        <RouteSuspense>
          <SuspendingChild />
        </RouteSuspense>
      );
    });

    // The whole point: something renders. A `null` fallback here is what left
    // the window on the bare `<body>` canvas for the length of the fetch.
    const placeholder = container.querySelector('[data-loading-placeholder-scope]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute('data-loading-placeholder-scope')).toBe('viewport');
    expect(placeholder?.className).toContain('bg-background');
    expect(container.querySelector('[data-testid="loaded-route"]')).toBeNull();

    await act(async () => {
      resolveChunk();
      await chunk;
    });

    expect(container.querySelector('[data-testid="loaded-route"]')).not.toBeNull();
    expect(container.querySelector('[data-loading-placeholder-scope]')).toBeNull();
  });

  it('holds the indicator back so a fast chunk never flashes a spinner', () => {
    const { SuspendingChild } = createSuspendingChild();

    act(() => {
      root.render(
        <RouteSuspense>
          <SuspendingChild />
        </RouteSuspense>
      );
    });

    const indicator = container.querySelector('[data-loading-placeholder-deferred]');
    expect(indicator).not.toBeNull();
    // The surface paints immediately; only the spinner and label are delayed,
    // and by CSS rather than by a timer this component would have to own.
    expect(indicator?.className).toContain('delay-300');
    expect(indicator?.className).toContain('fill-mode-both');
  });

  it('keeps a nested boundary inside its pane instead of covering the shell', () => {
    const LazyPane = lazy(() => new Promise<never>(() => {}));

    act(() => {
      root.render(
        <RouteSuspense scope="content">
          <LazyPane />
        </RouteSuspense>
      );
    });

    const placeholder = container.querySelector('[data-loading-placeholder-scope]');
    expect(placeholder?.getAttribute('data-loading-placeholder-scope')).toBe('content');
    // A viewport-height placeholder here would paint over the live sidebar.
    expect(placeholder?.className).not.toContain('min-h-[100dvh]');
  });
});
