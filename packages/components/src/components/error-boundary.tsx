import { Component, type ErrorInfo, type ReactNode } from 'react';
import { hashAnalyticsId, isConvexUnauthenticatedError } from '@lody/shared';
import { deferredPostHog } from '@/lib/deferred-posthog';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { jotaiStore } from '@/lib/utils';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { ErrorBoundaryFallback } from '@/components/error-boundary-fallback';

export type ErrorBoundaryFallbackProps = {
  error: Error;
  resetErrorBoundary: () => void;
  componentStack?: string | null;
};

type ErrorBoundaryVariant = 'page' | 'section' | 'inline';

// Stable, low-cardinality reason code for a caught render error. Keep it derived
// from error shape (name/code) only — never from the message, which carries
// user data and would explode cardinality (spec §2.3/§2.4).
function classifyBoundaryReason(error: Error): string {
  const name = error.name || 'Error';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) {
    return code.toLowerCase();
  }
  const message = error.message?.toLowerCase() ?? '';
  if (message.includes('chunk') || message.includes('dynamically imported module')) {
    return 'chunk_load';
  }
  if (name === 'TypeError') return 'type_error';
  if (name === 'RangeError') return 'range_error';
  if (name === 'ReferenceError') return 'reference_error';
  if (name === 'SyntaxError') return 'syntax_error';
  if (name && name !== 'Error') return name.toLowerCase();
  return 'unknown';
}

// Non-PII dedupe key for "same error" grouping on the churn-attribution event.
// Hashes the error shape (name + normalized message head + boundary), NOT the
// raw stack, so it is safe to send and stable across users (spec §7.5:
// error_fingerprint dedupes the product-level signal without re-sending the
// stack, which now lives on the PostHog $exception captured alongside it).
/**
 * Strip URLs, hex/uuid-ish tokens and digit runs so transient ids do not fork
 * what is conceptually one error. A failed Convex query embeds a per-request
 * id in its message, so without this every occurrence reads as a brand new
 * error — which silently defeats the fingerprint grouping below.
 */
function normalizeErrorMessage(message: string | undefined): string {
  return (message ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[0-9a-f]{8,}/gi, '')
    .replace(/\d+/g, '')
    .trim();
}

function computeErrorFingerprint(error: Error, boundaryName: string): string {
  const head = normalizeErrorMessage(error.message).slice(0, 120);
  return hashAnalyticsId(`${boundaryName}|${error.name}|${head}`);
}

function readWorkspaceId(): string {
  try {
    return jotaiStore.get(currentWorkspaceIdAtom) ?? '';
  } catch {
    return '';
  }
}

export type ErrorBoundaryProps = {
  children: ReactNode;
  name?: string;
  variant?: ErrorBoundaryVariant;
  /**
   * Retained for source compatibility. A captured error must stay visible when
   * these values change; only a user-initiated retry may clear it.
   */
  resetKeys?: ReadonlyArray<unknown>;
  onReset?: () => void;
  onError?: (error: Error, info: ErrorInfo) => void;
  fallback?: ReactNode;
  fallbackRender?: (props: ErrorBoundaryFallbackProps) => ReactNode;
  /**
   * Show the error text and technical details in the default fallback.
   * Defaults to `true` on every build: a crash the user cannot read or copy is a
   * crash we never hear about.
   */
  showErrorDetails?: boolean;
  propagateAuthErrors?: boolean;
};

type ErrorBoundaryState = {
  error: Error | null;
  componentStack: string | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    error: null,
    componentStack: null,
  };

  static getDerivedStateFromError(
    error: Error
  ): Pick<ErrorBoundaryState, 'error' | 'componentStack'> {
    return { error, componentStack: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    if (this.props.propagateAuthErrors !== false && isConvexUnauthenticatedError(error)) {
      return;
    }

    this.setState({ componentStack: info.componentStack ?? null });
    this.props.onError?.(error, info);

    const boundaryName = this.props.name ?? 'unknown';
    // Authoritative crash report: send the full exception (stack + component
    // stack) to PostHog error tracking. posthog-js groups by the exception
    // itself; the boundary name and React component stack ride along as
    // properties for triage.
    try {
      deferredPostHog.captureException(error, {
        errorBoundary: boundaryName,
        componentStack: info.componentStack,
      });
    } catch {
      // ignore reporting failures
    }

    // Separate product-level signal: forward only the low-cardinality churn
    // attribution fields (boundary, reason_code, fingerprint) — never the stack
    // — so churn dashboards can attribute crashes without re-sending the raw
    // exception. Tier A (full): error_boundary_triggered is a churn event.
    try {
      capturePostHogEvent(deferredPostHog, 'app/error_boundary_triggered', {
        boundary_name: boundaryName,
        variant: this.props.variant ?? 'section',
        error_type: error.name || 'Error',
        reason_code: classifyBoundaryReason(error),
        error_fingerprint: computeErrorFingerprint(error, boundaryName),
        source: 'error_boundary',
        workspace_id: readWorkspaceId(),
      });
    } catch {
      // Analytics is side-effect-only: must never throw into product code.
    }
  }

  /** A crash screen changes only when the user explicitly asks it to. */
  resetErrorBoundary = () => {
    this.props.onReset?.();
    this.setState({
      error: null,
      componentStack: null,
    });
  };

  override render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    if (this.props.propagateAuthErrors !== false && isConvexUnauthenticatedError(error)) {
      throw error;
    }

    const fallbackProps: ErrorBoundaryFallbackProps = {
      error,
      resetErrorBoundary: this.resetErrorBoundary,
      componentStack: this.state.componentStack,
    };

    if (this.props.fallbackRender) {
      return this.props.fallbackRender(fallbackProps);
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <ErrorBoundaryFallback
        {...fallbackProps}
        variant={this.props.variant ?? 'section'}
        componentStack={this.state.componentStack}
        boundaryName={this.props.name}
        // Details are shown in production too: without them a wedged user has
        // nothing to report and we have nothing to debug.
        showErrorDetails={this.props.showErrorDetails ?? true}
      />
    );
  }
}
