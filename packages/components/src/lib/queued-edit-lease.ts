/**
 * How often an editor refreshes a queued row's `editingStartedAt`. The CLI
 * treats the flag as a five-minute lease (`EDITING_LEASE_MS`), so an editor
 * that stops renewing (hidden, closed, crashed) releases the row within that
 * window.
 */
export const QUEUED_EDIT_RENEW_INTERVAL_MS = 60_000;
