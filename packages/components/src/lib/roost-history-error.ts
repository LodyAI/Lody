import i18next from 'i18next';

/** The owner sends a safe error reference; raw Worker causes stay in its local log. */
export class RoostHistoryError extends Error {
  readonly backend = 'roost';

  constructor(operation: 'read' | 'write', detail: string) {
    super(
      i18next.t(
        operation === 'read' ? 'sessions.roostHistoryReadError' : 'sessions.roostHistoryWriteError',
        { detail }
      )
    );
    this.name = 'RoostHistoryError';
  }
}
