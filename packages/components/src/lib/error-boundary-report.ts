/**
 * Pure builders for the crash-screen report.
 *
 * The crash screen exists so a wedged user can hand us something actionable, so
 * the copyable payload has to carry the whole picture: the error, the React
 * component stack (which boundary, which subtree), and the build/runtime context
 * we would otherwise have to ask for over chat. Kept pure and environment-
 * injectable so it can be asserted verbatim in tests.
 */

import { isConvexError } from '@lody/shared';
import { isNativeAppShell } from './native-platform';
import { collectClientBuildInfo, type ClientBuildInfo } from './client-build-info';

export type ErrorBoundaryReportEnvironment = ClientBuildInfo & {
  url?: string;
  userAgent?: string;
  online?: boolean | null;
  /** ISO timestamp; injected so report snapshots stay deterministic in tests. */
  timestamp?: string;
  runtime?: string;
  os?: string;
  language?: string;
};

export type ErrorBoundaryReportInput = {
  error: unknown;
  boundaryName?: string | undefined;
  componentStack?: string | null | undefined;
  environment?: ErrorBoundaryReportEnvironment;
  /**
   * Session render trace tail (`lib/session-render-trace.ts`): what the
   * session surfaces rendered/mounted/navigated right before the crash. This
   * is what turns a nested-update-limit report (React #185) from "where the
   * limit tripped" into "what oscillated".
   */
  renderTrace?: string | undefined;
};

export type ErrorBoundaryReport = {
  /** One-line `Name: message`, shown verbatim at the top of the crash screen. */
  summary: string;
  /** Context + stacks, shown in the collapsed "Technical details" block. */
  details: string;
  /** Summary + details: what the Copy button puts on the clipboard. */
  text: string;
};

/**
 * Whether the throw carries a raw Convex server payload (`[CONVEX Q(...)] Server
 * Error / Called by client …`).
 *
 * Those messages quote backend internals, so the crash screen does not print
 * them next to the title. They still belong in the copyable report and in the
 * details the user can expand deliberately — otherwise a backend failure is
 * undebuggable from a user's report.
 */
export function isRawConvexServerError(error: unknown): boolean {
  if (isConvexError(error)) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.trimStart().startsWith('[CONVEX ');
}

/** `TypeError: x is not a function` for Errors, best-effort text for anything else. */
export function describeErrorForReport(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim() ?? '';
    if (!error.name) return message || 'Error';
    return message ? `${error.name}: ${message}` : error.name;
  }
  if (typeof error === 'string') return error;
  if (error == null) return 'Unknown error';
  if (typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function resolveRuntime(): string {
  if (typeof window === 'undefined') return 'ssr';
  if (window.__LODY_ELECTRON__ === true) return 'electron';
  if (isNativeAppShell()) return 'native';
  return 'web';
}

/** Snapshot the ambient context a crash report should carry. Never throws. */
export function collectErrorBoundaryEnvironment(): ErrorBoundaryReportEnvironment {
  const environment: ErrorBoundaryReportEnvironment = {
    ...collectClientBuildInfo(),
    runtime: resolveRuntime(),
    timestamp: new Date().toISOString(),
  };

  if (typeof window !== 'undefined') {
    try {
      environment.url = window.location.href;
    } catch {
      // Some embedded shells restrict location access.
    }
    const os = window.__LODY_PLATFORM__?.os;
    if (typeof os === 'string' && os.length > 0) {
      environment.os = os;
    }
  }

  if (typeof navigator !== 'undefined') {
    environment.userAgent = navigator.userAgent;
    environment.online = navigator.onLine;
    if (typeof navigator.language === 'string' && navigator.language.length > 0) {
      environment.language = navigator.language;
    }
  }

  return environment;
}

function formatOnline(online: boolean | null | undefined): string | undefined {
  if (online === true) return 'yes';
  if (online === false) return 'no';
  return undefined;
}

export function buildErrorBoundaryReport(input: ErrorBoundaryReportInput): ErrorBoundaryReport {
  const environment = input.environment ?? {};
  const summary = describeErrorForReport(input.error);

  const fields: Array<[string, string | undefined]> = [
    ['Boundary', input.boundaryName?.trim() || undefined],
    ['URL', environment.url],
    ['Runtime', environment.runtime],
    ['OS', environment.os],
    ['App version', environment.appVersion],
    ['Release channel', environment.releaseChannel],
    ['Build', environment.build],
    ['Open-source commit', environment.ossCommit],
    ['Build date', environment.buildDate],
    ['Language', environment.language],
    ['User agent', environment.userAgent],
    ['Online', formatOnline(environment.online)],
    ['Time', environment.timestamp],
  ];

  const sections: string[] = [];
  const header = fields
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
  if (header) sections.push(header);

  const stack = input.error instanceof Error ? input.error.stack?.trim() : undefined;
  if (stack) sections.push(`Stack:\n${stack}`);

  const componentStack = input.componentStack?.trim();
  if (componentStack) sections.push(`Component stack:\n${componentStack}`);

  const renderTrace = input.renderTrace?.trim();
  if (renderTrace) sections.push(`Session render trace:\n${renderTrace}`);

  const details = sections.join('\n\n');
  return {
    summary,
    details,
    text: details ? `${summary}\n\n${details}` : summary,
  };
}
