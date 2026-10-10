import type {
  RepoTransportError,
  RepoDiagnosticEvent,
  RepoStreamsErrorContext,
  RepoTransportFailureKind,
} from 'loro-repo';

export type LoroSyncFailure = Pick<
  RepoTransportError,
  | 'code'
  | 'phase'
  | 'retryable'
  | 'transportId'
  | 'roomKind'
  | 'roomId'
  | 'failureKind'
  | 'streamsCode'
> & { streamsContext?: RepoStreamsErrorContext };

type RepoErrorRuntime = Pick<typeof import('loro-repo'), 'RepoTransportError' | 'RepoSyncError'>;

// The Repo transport has already validated this contract. Pick its documented
// scalar fields explicitly: never serialize an exception or its legacy payload.
const projectFailure = (error: RepoTransportError, transportId?: string): LoroSyncFailure => {
  const context = error.streamsContext;
  return {
    code: error.code,
    phase: error.phase,
    retryable: error.retryable,
    transportId: transportId ?? error.transportId,
    roomKind: error.roomKind,
    roomId: error.roomId,
    failureKind: error.failureKind,
    streamsCode: error.streamsCode,
    ...(context
      ? {
          streamsContext: {
            source: context.source,
            operation: context.operation,
            stage: context.stage,
            originalCode: context.originalCode,
            retryable: context.retryable,
            requestOperation: context.requestOperation,
            phase: context.phase,
            timeoutMs: context.timeoutMs,
            elapsedMs: context.elapsedMs,
            status: context.status,
            requestId: context.requestId,
            networkCode: context.networkCode,
          },
        }
      : {}),
  };
};

/** Safe fields from a single failure, a Repo report, or a caller's Error wrapper. */
const collectLoroSyncFailures = (error: unknown, runtime: RepoErrorRuntime): LoroSyncFailure[] => {
  const failures: LoroSyncFailure[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number, transportId?: string): void => {
    if (depth > 8 || failures.length >= 16) return;
    if (value instanceof runtime.RepoTransportError) {
      if (
        value.streamsCode !== undefined ||
        value.streamsContext !== undefined ||
        value.transportId === 'streams'
      ) {
        failures.push(projectFailure(value, transportId));
      }
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof runtime.RepoSyncError) {
      for (const transport of value.report.transports) {
        for (const failure of transport.failures)
          visit(failure.error, depth + 1, transport.transportId);
      }
    } else if (value instanceof Error) {
      if (value instanceof AggregateError) {
        for (const nested of value.errors) visit(nested, depth + 1, transportId);
      }
      visit(value.cause, depth + 1, transportId);
    }
  };
  visit(error, 0);
  return failures;
};

const failureDescriptions: Record<RepoTransportFailureKind, string> = {
  network: 'network request failed',
  timeout: 'request timed out',
  server: 'HTTP response error',
  'local-storage': 'local storage failed',
  'local-crdt': 'local CRDT operation failed',
  local: 'local operation failed',
  unknown: 'failure source unknown',
};

/** Technical error detail; the surrounding UI action label remains localized. */
const formatLoroSyncError = (error: unknown, runtime: RepoErrorRuntime): string | undefined => {
  const failures = collectLoroSyncFailures(error, runtime);
  if (failures.length === 0) return undefined;
  const formatted = failures
    .map((failure) => {
      const context = failure.streamsContext;
      const fields: Record<string, unknown> = {
        code: failure.streamsCode ?? failure.code,
        transport: failure.transportId,
        room: failure.roomKind,
        roomId: failure.roomId,
        source: context?.source,
        operation: context?.operation,
        stage: context?.stage,
        request: context?.requestOperation,
        timeoutPhase: context?.phase,
        timeoutMs: context?.timeoutMs,
        elapsedMs: context?.elapsedMs,
        status: context?.status,
        requestId: context?.requestId,
        networkCode: context?.networkCode,
        retryable: failure.retryable,
      };
      const detail = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      return `Streams ${failure.phase} failed: ${failureDescriptions[failure.failureKind ?? 'unknown']} (${detail})`;
    })
    .join('; ');
  return formatted;
};

/** Only failure diagnostics are logged; normal cursor/sync activity is silent. */
const getLoroSyncDiagnostic = (event: RepoDiagnosticEvent, runtime: RepoErrorRuntime) => {
  if (event.level !== 'warn' && event.level !== 'error') return undefined;
  return {
    level: event.level,
    event: event.event,
    transportId: event.transportId,
    roomKind: event.roomKind,
    roomId: event.roomId,
    phase: event.phase,
    durationMs: event.durationMs,
    attempt: event.attempt,
    failures: collectLoroSyncFailures(event.error, runtime),
  };
};

/** Bind to the caller's Repo instance: pnpm peers can produce distinct classes. */
export const createLoroSyncErrorTools = (runtime: RepoErrorRuntime) => ({
  collectLoroSyncFailures: (error: unknown) => collectLoroSyncFailures(error, runtime),
  formatLoroSyncError: (error: unknown) => formatLoroSyncError(error, runtime),
  getLoroSyncDiagnostic: (event: RepoDiagnosticEvent) => getLoroSyncDiagnostic(event, runtime),
});
