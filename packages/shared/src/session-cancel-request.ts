// Cancel-request marker helpers for the session control document.
//
// Kept separate from `session-control-plane.ts`, which builds a loro-mirror
// `Mirror`/`schema` and therefore retains `loro-crdt` (WASM) in any chunk that
// value-imports it. The renderer boot path needs these markers but not the
// Mirror, so the pure helpers live in this loro-free module reachable through
// the `@lody/shared` barrel.

const CANCEL_REQUEST_PREFIX = 'cancel-request:';

/** Distinguishes control-document requests from legacy metadata turn IDs. */
export function getSessionCancelRequestMarker(requestId: string): string {
  return `${CANCEL_REQUEST_PREFIX}${requestId}`;
}

export function isSessionCancelRequestMarker(marker: string): boolean {
  return marker.startsWith(CANCEL_REQUEST_PREFIX);
}
