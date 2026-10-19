import type { RepoTransportError, RepoDiagnosticEvent, RepoStreamsErrorContext } from 'loro-repo';
import type { SnapshotDiagnosticEvent } from '@loro-dev/streams-crdt';

type RepoErrorRuntime = Pick<typeof import('loro-repo'), 'RepoTransportError' | 'RepoSyncError'> & {
  /** A caller-bound native constructor boundary; never inspect arbitrary error payloads. */
  readonly nativeFailures?: (
    error: unknown,
    transportError: typeof import('loro-repo').RepoTransportError
  ) => readonly unknown[];
};

type LoroSyncFailure = {
  code: RepoTransportError['code'];
  phase: RepoTransportError['phase'];
  retryable: boolean;
  transportId: string | undefined;
  roomKind: RepoTransportError['roomKind'];
  roomId: string | undefined;
  failureKind: NonNullable<RepoTransportError['failureKind']>;
  streamsCode: string | undefined;
  // Public alias. Indexing RepoTransportError['streamsContext'] expands through
  // unexported TransportErrorContext and fails declaration emit with TS4023.
  streamsContext: RepoStreamsErrorContext | undefined;
};

// Select approved fields; never serialize an exception or its legacy payload.
const projectFailure = (error: RepoTransportError, transportId?: string): LoroSyncFailure => {
  const context = error.streamsContext;
  const streamsContext: RepoStreamsErrorContext | undefined = context && {
    source: context.source,
    operation: context.operation,
    stage: context.stage,
    originalCode: context.originalCode,
    retryable: context.retryable,
    requestOperation: context.requestOperation,
    phase: context.phase,
    abortKind: context.abortKind,
    timeoutKind: context.timeoutKind,
    uploadStage: context.uploadStage,
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

type SnapshotError = NonNullable<SnapshotDiagnosticEvent['error']>;
type SnapshotErrorDiagnostic = Pick<
  SnapshotError,
  | 'source'
  | 'operation'
  | 'originalCode'
  | 'retryable'
  | 'phase'
  | 'abortKind'
  | 'timeoutKind'
  | 'uploadStage'
  | 'timeoutMs'
  | 'elapsedMs'
  | 'status'
  | 'requestId'
  | 'networkCode'
> &
  Partial<Pick<RepoStreamsErrorContext, 'stage' | 'requestOperation'>>;

/** Only SDK diagnostic DTOs enter here. Never pass errors or request/response objects to logs. */
export const getLoroSnapshotDiagnostic = (
  event: SnapshotDiagnosticEvent
): Omit<SnapshotDiagnosticEvent, 'error'> & { readonly error?: SnapshotErrorDiagnostic } => {
  const error = event.error;
  return {
    snapshotId: event.snapshotId,
    stage: event.stage,
    outcome: event.outcome,
    elapsedMs: event.elapsedMs,
    snapshotElapsedMs: event.snapshotElapsedMs,
    snapshotOffset: event.snapshotOffset,
    snapshotByteLength: event.snapshotByteLength,
    requestId: event.requestId,
    requestOperation: event.requestOperation,
    timeoutMs: event.timeoutMs,
    uploadMode: event.uploadMode,
    uploadStage: event.uploadStage,
    transferredBytes: event.transferredBytes,
    idleTimeoutMs: event.idleTimeoutMs,
    status: event.status,
    error: error && {
      source: error.source,
      operation: error.operation,
      stage: 'stage' in error ? error.stage : undefined,
      originalCode: error.originalCode,
      retryable: error.retryable,
      requestOperation: 'requestOperation' in error ? error.requestOperation : undefined,
      phase: error.phase,
      abortKind: error.abortKind,
      timeoutKind: error.timeoutKind,
      uploadStage: error.uploadStage,
      timeoutMs: error.timeoutMs,
      elapsedMs: error.elapsedMs,
      status: error.status,
      requestId: error.requestId,
      networkCode: error.networkCode,
    },
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
      const native = runtime.nativeFailures?.(value, runtime.RepoTransportError) ?? [];
      if (native.length) {
        for (const nested of native) visit(nested, depth + 1, transportId);
        return;
      }
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
