import type { RepoTransportError, RepoDiagnosticEvent } from 'loro-repo';

type RepoErrorRuntime = Pick<typeof import('loro-repo'), 'RepoTransportError' | 'RepoSyncError'>;

// Select approved fields; never serialize an exception or its legacy payload.
const projectFailure = (error: RepoTransportError, transportId?: string) => {
  const context = error.streamsContext;
  const streamsContext: RepoTransportError['streamsContext'] = context && {
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
  };
  return {
    code: error.code,
    phase: error.phase,
    retryable: error.retryable,
    transportId: transportId ?? error.transportId,
    roomKind: error.roomKind,
    roomId: error.roomId,
    failureKind: error.failureKind ?? 'unknown',
    streamsCode: error.streamsCode,
    streamsContext,
  };
};

/** Bind to the caller's Repo instance: pnpm peers can produce distinct classes. */
export const createLoroSyncErrorTools = (runtime: RepoErrorRuntime) => {
  const collectFailures = (error: unknown) => {
    const failures: ReturnType<typeof projectFailure>[] = [];
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

  return {
    formatLoroSyncError(error: unknown): string | undefined {
      const failures = collectFailures(error);
      return failures.length
        ? failures
            .map(
              (failure) =>
                `Streams ${failure.phase} failed: ${failure.streamsCode ?? failure.code} (${JSON.stringify(failure)})`
            )
            .join('; ')
        : undefined;
    },
    getLoroSyncDiagnostic(event: RepoDiagnosticEvent) {
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
        failures: collectFailures(event.error),
      };
    },
  };
};
