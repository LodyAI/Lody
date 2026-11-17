import {
  ShortcutTokenAttemptError,
  ShortcutTokenAttempts,
  shortcutTokenDiagnostic,
} from '../src/lib/shortcut-token-attempt';
import { createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ErrorBoundary } from '../src/components/error-boundary';
import {
  deferredPostHog,
  scheduleDeferredPostHogInitialization,
} from '../src/lib/deferred-posthog';
import { createIrohDaily } from '../src/lib/iroh-daily';
import { POSTHOG_OPTIONS } from '../src/providers/posthog-options';
import { logTokenProviderEvent } from '../src/providers/loro-streams-token-diagnostics';
import {
  postHogPrivacy,
  installWorkspaceTelemetryScope,
  setTelemetryRouteTarget,
  suspendWorkspaceTelemetry,
} from '../src/lib/posthog-privacy';
Object.assign(window, {
  POSTHOG_OPTIONS,
  logTokenProviderEvent,
  ShortcutTokenAttempts,
  shortcutTokenDiagnostic,
  shortcutProbeError(mixed = false) {
    const error = new ShortcutTokenAttemptError({
      kind: 'retryable',
      code: 'exchange_unavailable',
      phase: 'exchange',
    });
    if (mixed) error.cause = new Error('BOUNDARY_SYNTHETIC_INDEPENDENT_CAUSE');
    return error;
  },
  captureShortcutProbe(error: unknown) {
    deferredPostHog.captureException(error, { source: 'errorBoundary' });
  },
  scheduleDeferredPostHogInitialization,
  mountBoundaryProbe(initialFailure: 'unknown' | 'shortcut' | 'mixed' = 'unknown') {
    let failure = initialFailure;
    let fail = true;
    const boundary = createRef<ErrorBoundary>();
    const root = createRoot(document.querySelector('main')!);
    function Content() {
      if (fail) {
        if (failure !== 'unknown') {
          const error = new ShortcutTokenAttemptError({
            kind: 'retryable',
            code: 'exchange_unavailable',
            phase: 'exchange',
          });
          if (failure === 'mixed') error.cause = new Error('BOUNDARY_SYNTHETIC_INDEPENDENT_CAUSE');
          throw error;
        }
        const error = new Error('BOUNDARY_SYNTHETIC_MESSAGE');
        error.name = 'BOUNDARY_SYNTHETIC_NAME';
        Object.assign(error, { code: 'BOUNDARY_SYNTHETIC_CODE' });
        throw error;
      }
      return createElement('span', null, 'boundary recovered');
    }
    const render = () =>
      flushSync(() =>
        root.render(
          createElement(ErrorBoundary, {
            ref: boundary,
            name: 'BOUNDARY_SYNTHETIC_NAME',
            fallbackRender: ({ error }) => createElement('pre', null, error.message),
            children: createElement(Content),
          })
        )
      );
    render();
    return {
      render,
      changeFailure(value: 'unknown' | 'shortcut' | 'mixed') {
        failure = value;
        fail = true;
        flushSync(() => boundary.current!.resetErrorBoundary());
        render();
      },
      retry() {
        flushSync(() => boundary.current!.resetErrorBoundary());
      },
      recover() {
        fail = false;
        flushSync(() => boundary.current!.resetErrorBoundary());
      },
      fail() {
        fail = true;
        render();
      },
      close() {
        flushSync(() => root.unmount());
      },
    };
  },
  createIrohDaily,
  postHogPrivacy,
  installWorkspaceTelemetryScope,
  setTelemetryRouteTarget,
  suspendWorkspaceTelemetry,
});
