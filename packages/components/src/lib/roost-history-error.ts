import i18next from 'i18next';
import type { SessionHistoryRpcFailure } from '@lody/loro-streams-rpc';

/** The owner sends a safe error reference; raw Worker causes stay in its local log. */
export class RoostHistoryError extends Error {
  readonly backend = 'roost';

  constructor(
    operation: 'read' | 'write',
    detail: string,
    readonly retryReason?: 'superseded'
  ) {
    super(
      i18next.t(
        operation === 'read' ? 'sessions.roostHistoryReadError' : 'sessions.roostHistoryWriteError',
        { detail }
      )
    );
    this.name = 'RoostHistoryError';
  }
}

/** A request failure is distinct from an owner-generated Roost storage diagnostic. */
export class SessionHistoryRequestError extends Error {
  readonly backend = 'roost';

  constructor(
    operation: 'read' | 'write',
    readonly failure: SessionHistoryRpcFailure,
    detail: string
  ) {
    const key =
      failure.source === 'transport'
        ? operation === 'read'
          ? 'sessions.historyRequestReadTransportError'
          : 'sessions.historyRequestWriteTransportError'
        : failure.code === 'session_metadata_pending'
          ? 'sessions.historyRequestMetadataPending'
          : failure.source === 'protocol'
            ? 'sessions.historyRequestProtocolError'
            : 'sessions.historyRequestOwnerError';
    super(
      i18next.t(key, {
        detail: `${detail} (request=${failure.requestId}; machine=${failure.machineId})`,
      })
    );
    this.name = 'SessionHistoryRequestError';
  }
}
