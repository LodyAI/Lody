import { concat } from './wire-crypto';

/** Provider binding revision: old 1/2 headers embedded AAD in plaintext. */
export const STREAMS_UPDATE_HEADER = 3;
export const STREAMS_SNAPSHOT_HEADER = 4;
const SDK_AAD_DOMAIN = new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0');

/** Reconstruct SDK v2 AAD from its exact authenticated LSCE prefix + provider header.
 * Callers must structurally validate the envelope first. No CRDT bytes are included. */
export function streamsContentAdditionalData(
  authenticatedHeader: Uint8Array
): Uint8Array<ArrayBuffer> {
  return concat([SDK_AAD_DOMAIN, authenticatedHeader]);
}
