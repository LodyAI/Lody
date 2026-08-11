/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '../src/components/error-boundary';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let renderAttempts: number;

/**
 * Stands in for a route subtree. `crash` decides whether the current render
 * throws, so a test can reproduce "the error comes back every time" (a crash
 * loop) as well as "navigating away fixes it".
 */
function Subject({ crash, label }: { crash: boolean; label: string }) {
  renderAttempts += 1;
  if (crash) {
    throw new Error('render exploded');
  }
  return <div>{label}</div>;
}

function renderBoundary({
  crash,
  resetKey,
  label = 'healthy',
}: {
  crash: boolean;
  resetKey: string;
  label?: string;
}) {
  act(() => {
    root.render(
      <ErrorBoundary name="Test" variant="section" resetKeys={[resetKey]}>
        <Subject crash={crash} label={label} />
      </ErrorBoundary>
    );
  });
}

function crashScreenVisible(): boolean {
  return container.textContent?.includes('render exploded') ?? false;
}

function clickTryAgain() {
  const target = Array.from(container.querySelectorAll('button')).find((element) =>
    element.textContent?.includes('Try again')
  );
  if (!target) throw new Error('No "Try again" button on the crash screen');
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(async () => {
  await initI18n('en');
  renderAttempts = 0;
  // React logs caught render errors; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ErrorBoundary automatic reset', () => {
  it('recovers automatically when the reset key changes and the subtree is healthy again', () => {
    renderBoundary({ crash: true, resetKey: '/broken' });
    expect(crashScreenVisible()).toBe(true);

    renderBoundary({ crash: false, resetKey: '/other', label: 'other route' });

    expect(crashScreenVisible()).toBe(false);
    expect(container.textContent).toContain('other route');
  });

  it('stops retrying by itself once the same error keeps coming back', () => {
    renderBoundary({ crash: true, resetKey: '/a' });
    const attemptsAfterFirstCrash = renderAttempts;

    // Each key change is one automatic recovery attempt that immediately
    // re-crashes: the shape of a crash loop.
    renderBoundary({ crash: true, resetKey: '/b' });
    renderBoundary({ crash: true, resetKey: '/c' });
    const attemptsAfterBudget = renderAttempts;
    expect(attemptsAfterBudget).toBeGreaterThan(attemptsAfterFirstCrash);

    // Budget spent: further key changes must not silently re-render the
    // crashed subtree, so the user can read and copy the error.
    renderBoundary({ crash: true, resetKey: '/d' });
    renderBoundary({ crash: true, resetKey: '/e' });

    expect(renderAttempts).toBe(attemptsAfterBudget);
    expect(crashScreenVisible()).toBe(true);
  });

  it('keeps the explicit retry working after automatic resets are exhausted', () => {
    renderBoundary({ crash: true, resetKey: '/a' });
    renderBoundary({ crash: true, resetKey: '/b' });
    renderBoundary({ crash: true, resetKey: '/c' });
    renderBoundary({ crash: true, resetKey: '/d' });
    expect(crashScreenVisible()).toBe(true);

    // The user presses "Try again": the boundary must attempt the render even
    // though its automatic budget is gone.
    const attemptsBeforeRetry = renderAttempts;
    clickTryAgain();
    expect(renderAttempts).toBeGreaterThan(attemptsBeforeRetry);
  });

  it('tells the user it stopped retrying, and one explicit retry gets them out', () => {
    renderBoundary({ crash: true, resetKey: '/a' });
    renderBoundary({ crash: true, resetKey: '/b' });
    renderBoundary({ crash: true, resetKey: '/c' });
    expect(container.textContent).toContain('stopped retrying on its own');

    // The screen now stays put even where the subtree would render fine — that
    // is the point — but the visible retry recovers immediately.
    renderBoundary({ crash: false, resetKey: '/d', label: 'other route' });
    expect(crashScreenVisible()).toBe(true);

    clickTryAgain();
    expect(container.textContent).toContain('other route');
  });

  it('restores the automatic budget once the subtree renders cleanly again', () => {
    renderBoundary({ crash: true, resetKey: '/a' });
    // One automatic recovery, inside the budget, back to a healthy subtree.
    renderBoundary({ crash: false, resetKey: '/b' });
    expect(crashScreenVisible()).toBe(false);

    // A later, unrelated crash gets its own full budget rather than inheriting
    // the earlier attempt's.
    renderBoundary({ crash: true, resetKey: '/c' });
    expect(crashScreenVisible()).toBe(true);
    expect(container.textContent).not.toContain('stopped retrying on its own');

    renderBoundary({ crash: false, resetKey: '/d', label: 'recovered' });
    expect(container.textContent).toContain('recovered');
  });
});
