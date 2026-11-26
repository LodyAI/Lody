import { syncSdkUsageSharing, usageSharingAllowed } from '@/lib/usage-sharing';
import { isHandledShortcutTokenEvent } from '@/lib/shortcut-token-attempt';
import type posthog from 'posthog-js';
import { isConvexAuthErrorData } from '@lody/shared';
import { POSTHOG_INIT_PROPERTY_DENYLIST } from '@/lib/posthog-analytics';
import { isResizeObserverLoopError } from '@/lib/resize-observer';
import { postHogPrivacy } from '@/lib/posthog-privacy';

type PostHogOptions = NonNullable<Parameters<typeof posthog.init>[1]>;

export const POSTHOG_HOST = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;
function isUnauthenticatedExceptionMessage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // PostHog serializes errors before before_send, losing ConvexError.data and
  // its identifying symbol. Match the namespaced JSON contract, including the
  // nested ConvexError prefix produced by action -> query failures.
  const payload = value.match(/\bConvexError:\s*(\{[^{}\r\n]*\})/)?.[1] ?? value;
  try {
    return isConvexAuthErrorData(JSON.parse(payload));
  } catch {
    return false;
  }
}

function isUnauthenticatedPostHogEvent(event: {
  event: string;
  properties?: Record<string, unknown>;
}): boolean {
  if (event.event !== '$exception') return false;
  const properties = event.properties;
  if (!properties) return false;
  const exceptions = properties.$exception_list;
  if (Array.isArray(exceptions) && exceptions.length > 0) {
    // Preserve mixed exception chains: an auth failure must not hide another bug.
    return exceptions.every((item) => {
      if (!item || typeof item !== 'object') return false;
      const exception = item as Record<string, unknown>;
      return isUnauthenticatedExceptionMessage(exception.value ?? exception.message);
    });
  }
  return isUnauthenticatedExceptionMessage(
    properties.$exception_message ?? properties.$exception_description
  );
}

function isResizeObserverLoopPostHogEvent(event: {
  properties?: Record<string, unknown>;
}): boolean {
  const properties = event.properties;
  if (!properties) return false;

  const candidates = [
    properties.$exception_message,
    properties.$exception_type,
    properties.$exception_description,
  ];
  if (candidates.some((candidate) => isResizeObserverLoopError(candidate))) {
    return true;
  }

  const exceptionList = properties.$exception_list;
  if (!Array.isArray(exceptionList)) return false;

  return exceptionList.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const exception = item as Record<string, unknown>;
    return (
      isResizeObserverLoopError(exception.value) ||
      isResizeObserverLoopError(exception.type) ||
      isResizeObserverLoopError(exception.message)
    );
  });
}

export const POSTHOG_OPTIONS: PostHogOptions = {
  ...(POSTHOG_HOST ? { api_host: POSTHOG_HOST } : {}),
  defaults: '2026-01-30',
  // Avoid setting analytics cookies on the domain; keep identity scoped to localStorage.
  persistence: 'localStorage',
  loaded: (client) => {
    syncSdkUsageSharing(client, usageSharingAllowed());
  },
  // OAuth and installation retry fragments carry capabilities, including in replay URL metadata.
  disable_capture_url_hashes: true,
  autocapture: false,
  save_referrer: false,
  save_campaign_params: false,
  // The deferred controller records pageviews and pageleave itself so routes
  // visited before `posthog.init` retain their original timestamps, and a short
  // visit can flush the current pagehide through sendBeacon.
  capture_pageview: false,
  capture_pageleave: false,
  // Error tracking: auto-capture unhandled errors + promise rejections
  // (replaces Sentry's globalHandlers/browserApiErrors). React render errors
  // are reported explicitly from ErrorBoundary via posthog.captureException.
  capture_exceptions: true,
  capture_performance: false,
  property_denylist: POSTHOG_INIT_PROPERTY_DENYLIST,
  debug: false,
  disable_session_recording: true,
  disable_external_dependency_loading: true,
  advanced_disable_flags: true,
  disable_surveys: true,
  disable_web_experiments: true,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  rageclick: false,
  enable_recording_console_log: false,
  before_send: (event) => {
    if (!event) {
      return event;
    }
    if (
      isHandledShortcutTokenEvent(event) ||
      isUnauthenticatedPostHogEvent(event) ||
      isResizeObserverLoopPostHogEvent(event)
    ) {
      return null;
    }
    return postHogPrivacy.beforeSend(event) as typeof event;
  },
};
