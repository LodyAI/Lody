import { isHandledShortcutTokenError } from '@/lib/shortcut-token-attempt';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isConvexUnauthenticatedError } from '@lody/shared';
import { redactedTelemetryException } from '@lody/platform/telemetry';
import { deferredPostHog } from '@/lib/deferred-posthog';
import { recordClientError } from '@/lib/client-log';
import { ErrorBoundaryFallback } from '@/components/error-boundary-fallback';

export type ErrorBoundaryFallbackProps = {
  error: Error;
  resetErrorBoundary: () => void;
  componentStack?: string | null;
};

type ErrorBoundaryVariant = 'page' | 'section' | 'inline';

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

  // The mounted boundary owns the outage. Failed user retries keep this report;
  // only a committed healthy subtree starts another episode.
  private hasReportedError = false;

  override componentDidUpdate() {
    if (this.state.error === null) this.hasReportedError = false;
  }

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
    // Kept on the device so the next bug report carries the crash, even after
    // the user reloads or the app is restarted.
    recordClientError('react.error_boundary', error, {
      boundary: boundaryName,
      variant: this.props.variant ?? 'section',
      componentStack: info.componentStack ?? null,
    });
    // The Shortcut operation already owns this handled failure. Do not consume
    // the boundary episode: a subsequent independent crash must remain visible.
    if (isHandledShortcutTokenError(error)) return;
    if (this.hasReportedError) return;
    this.hasReportedError = true;

    // One automatic diagnostic per outage, in every workspace mode. Detailed
    // errors stay in the local support report, never in analytics or its hashes.
    try {
      const properties = redactedTelemetryException({ source: 'errorBoundary' }, error);
      const diagnostic = new Error(properties.error_code);
      diagnostic.name = properties.error_type;
      diagnostic.stack = undefined;
      deferredPostHog.captureException(diagnostic, properties);
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
