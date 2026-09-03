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
    expect(container.querySelector('[data-testid="loaded-route"]')).toBeNull();

    await act(async () => {
      resolveChunk();
      await chunk;
    });

    expect(container.querySelector('[data-testid="loaded-route"]')).not.toBeNull();
    expect(container.querySelector('[data-loading-placeholder-scope]')).toBeNull();
  });

  it('scopes a nested boundary to its pane rather than the viewport', () => {
    const LazyPane = lazy(() => new Promise<never>(() => {}));

    act(() => {
      root.render(
        <RouteSuspense scope="content">
          <LazyPane />
        </RouteSuspense>
      );
    });

    // Measured on the iPad shell's top safe-area inset: a viewport-height
    // placeholder overflows this pane by the inset and pushes the spinner
    // below its centre, where `overflow-hidden` clips it.
    expect(
      container
        .querySelector('[data-loading-placeholder-scope]')
        ?.getAttribute('data-loading-placeholder-scope')
    ).toBe('content');
  });
});
