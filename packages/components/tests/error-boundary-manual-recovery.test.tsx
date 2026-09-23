/** @vitest-environment jsdom */

import { act, createRef } from 'react';
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

function Subject({ crash, label }: { crash: boolean; label: string }) {
  renderAttempts += 1;
  if (crash) throw new Error('render exploded');
  return <div>{label}</div>;
}

function renderBoundary({ crash, resetKey, label = 'healthy' }: {
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

function renderInlineBoundary({ crash, resetKey, label = 'healthy' }: {
  crash: boolean;
  resetKey: string;
  label?: string;
}) {
  act(() => {
    root.render(
      <ErrorBoundary
        name="InlineTest"
        variant="inline"
        resetKeys={[resetKey]}
        fallbackRender={({ resetErrorBoundary }) => (
          <button type="button" onClick={resetErrorBoundary}>
            Retry selector
          </button>
        )}
      >
        <Subject crash={crash} label={label} />
      </ErrorBoundary>
    );
  });
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

describe('ErrorBoundary manual recovery', () => {
  it('keeps a captured error visible when reset keys change', () => {
    renderBoundary({ crash: true, resetKey: '/broken' });
    const attemptsAfterCrash = renderAttempts;

    // Navigation may make the child healthy, but it must not erase the error
    // before the user has time to copy it or the exception client can flush.
    renderBoundary({ crash: false, resetKey: '/other', label: 'other route' });

    expect(renderAttempts).toBe(attemptsAfterCrash);
    expect(container.textContent).toContain('render exploded');
    expect(container.textContent).not.toContain('other route');
  });

  it('retries only after the user explicitly asks', () => {
    renderBoundary({ crash: true, resetKey: '/broken' });
    renderBoundary({ crash: false, resetKey: '/other', label: 'other route' });
    const attemptsBeforeRetry = renderAttempts;

    clickTryAgain();

    expect(renderAttempts).toBeGreaterThan(attemptsBeforeRetry);
    expect(container.textContent).toContain('other route');
  });

  it('gives inline fallbacks a user-driven recovery action', () => {
    renderInlineBoundary({ crash: true, resetKey: 'workspace-a' });
    renderInlineBoundary({ crash: false, resetKey: 'workspace-b', label: 'target selector' });

    expect(container.textContent).toContain('Retry selector');
    expect(container.textContent).not.toContain('target selector');

    const retry = Array.from(container.querySelectorAll('button')).find((element) =>
      element.textContent?.includes('Retry selector')
    );
    if (!retry) throw new Error('No inline recovery action');
    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('target selector');
  });

  it('lets an owning action recover a buttonless fallback', () => {
    const boundaryRef = createRef<ErrorBoundary>();
    act(() => {
      root.render(
        <ErrorBoundary
          ref={boundaryRef}
          name="ButtonlessTest"
          variant="inline"
          fallbackRender={() => null}
          resetKeys={['slug-a']}
        >
          <Subject crash label="unavailable slug" />
        </ErrorBoundary>
      );
    });
    act(() => {
      root.render(
        <ErrorBoundary
          ref={boundaryRef}
          name="ButtonlessTest"
          variant="inline"
          fallbackRender={() => null}
          resetKeys={['slug-b']}
        >
          <Subject crash={false} label="available slug" />
        </ErrorBoundary>
      );
    });

    expect(container.textContent).not.toContain('available slug');
    act(() => boundaryRef.current?.resetErrorBoundary());

    expect(container.textContent).toContain('available slug');
  });
});
