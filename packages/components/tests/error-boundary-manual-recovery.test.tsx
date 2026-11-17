/** @vitest-environment jsdom */
import { ShortcutTokenAttemptError } from '../src/lib/shortcut-token-attempt';
import { act, createRef, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '../src/components/error-boundary';
import { initI18n } from '../src/i18n';
import { deferredPostHog } from '../src/lib/deferred-posthog';
import { buildErrorBoundaryReport } from '../src/lib/error-boundary-report';

vi.mock('../src/lib/deferred-posthog', () => ({
  deferredPostHog: { captureException: vi.fn() },
}));

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

function renderInlineBoundary({
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
  vi.clearAllMocks();
});

describe('ErrorBoundary manual recovery', () => {
  it('reports once through failed retries, then reports an independent post-recovery fault', () => {
    const boundary = createRef<ErrorBoundary>();
    let fail = true;
    let attempts = 0;
    function CrashingContent() {
      attempts++;
      if (fail) {
        const error = new Error('SYNTHETIC_BUSINESS_MESSAGE');
        error.name = 'SYNTHETIC_PROVIDER_NAME';
        Object.assign(error, { code: 'SYNTHETIC_TOKEN_CODE' });
        throw error;
      }
      return <div>recovered content</div>;
    }
    const render = () =>
      act(() =>
        root.render(
          <StrictMode>
            <ErrorBoundary
              ref={boundary}
              name="SYNTHETIC_BOUNDARY"
              fallbackRender={({ error, resetErrorBoundary }) => (
                <button onClick={resetErrorBoundary}>
                  {buildErrorBoundaryReport({ error }).text}
                </button>
              )}
            >
              <CrashingContent />
            </ErrorBoundary>
          </StrictMode>
        )
      );
    render();
    const firstAttempts = attempts;
    render();
    expect(attempts).toBe(firstAttempts);
    for (let i = 0; i < 20; i++) act(() => boundary.current!.resetErrorBoundary());
    expect(attempts).toBeGreaterThan(firstAttempts);
    const reports = vi.mocked(deferredPostHog.captureException).mock.calls;
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toContain('SYNTHETIC_');
    expect(reports[0][0]).toMatchObject({
      name: 'unknown',
      message: 'redacted_exception',
      stack: undefined,
    });
    expect(reports[0][1]).toMatchObject({ source: 'errorBoundary', error_type: 'unknown' });
    expect(container.textContent).toContain('SYNTHETIC_BUSINESS_MESSAGE');
    expect(container.textContent).toContain('SYNTHETIC_PROVIDER_NAME');

    fail = false;
    act(() => boundary.current!.resetErrorBoundary());
    expect(container.textContent).toBe('recovered content');
    fail = true;
    render();
    expect(reports).toHaveLength(2);
  });

  it('owned Shortcut failures do not consume the boundary episode but an independent cause remains reportable', () => {
    const boundary = createRef<ErrorBoundary>();
    const handled = new ShortcutTokenAttemptError({
      kind: 'retryable',
      code: 'exchange_unavailable',
      phase: 'exchange',
    });
    let error: Error = handled;
    function Content(): never {
      throw error;
    }
    act(() =>
      root.render(
        <ErrorBoundary ref={boundary} fallbackRender={({ error }) => <span>{error.message}</span>}>
          <Content />
        </ErrorBoundary>
      )
    );
    for (let i = 0; i < 20; i++) act(() => boundary.current!.resetErrorBoundary());
    expect(deferredPostHog.captureException).not.toHaveBeenCalled();
    expect(container.textContent).toContain('exchange_unavailable');
    const mixed = new ShortcutTokenAttemptError({
      kind: 'retryable',
      code: 'exchange_unavailable',
      phase: 'exchange',
    });
    mixed.cause = new Error('SYNTHETIC_INDEPENDENT_CAUSE');
    error = mixed;
    act(() => boundary.current!.resetErrorBoundary());
    const reports = vi.mocked(deferredPostHog.captureException).mock.calls;
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toContain('SYNTHETIC_');
    expect(reports[0][1]).toMatchObject({ source: 'errorBoundary' });
    error = new Error('another independent crash during same boundary episode');
    act(() => boundary.current!.resetErrorBoundary());
    expect(reports).toHaveLength(1);
  });

  it('keeps separate mounted owners visible even when their error objects match', () => {
    const error = new TypeError('SYNTHETIC_SHARED_MESSAGE');
    function CrashingContent(): never {
      throw error;
    }
    act(() =>
      root.render(
        <>
          <ErrorBoundary fallback={<span>first failed</span>}>
            <CrashingContent />
          </ErrorBoundary>
          <ErrorBoundary fallback={<span>second failed</span>}>
            <CrashingContent />
          </ErrorBoundary>
        </>
      )
    );
    const reports = vi.mocked(deferredPostHog.captureException).mock.calls;
    expect(reports).toHaveLength(2);
    expect(reports.map((report) => report[1]?.error_type)).toEqual(['TypeError', 'TypeError']);
    expect(JSON.stringify(reports)).not.toContain('SYNTHETIC_');
    expect(container.textContent).toBe('first failedsecond failed');
  });

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
});
