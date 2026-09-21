import { canSendEpoch, type OrgState } from '@lody/e2ee-core/ledger';
import { deviceMayWriteDocument } from '@lody/e2ee-core/streams-content';
import { fromHex } from './bytes';
import { CONTROL_STREAM, FLOCK_STREAM, KEYS_STREAM, LORO_STREAM } from './protocol';

export type KnownStream =
  | typeof CONTROL_STREAM
  | typeof KEYS_STREAM
  | typeof LORO_STREAM
  | typeof FLOCK_STREAM;

export type GatewayAction = 'read' | 'control-cas' | 'keys-cas' | 'content-cas' | 'snapshot-put';

export type GatewayDecision =
  | { readonly ok: true; readonly action: GatewayAction }
  | {
      readonly ok: false;
      readonly status: 403 | 404;
      readonly error: 'unauthorized' | 'unknown-stream' | 'method-not-allowed';
    };

export function isKnownStream(stream: string): stream is KnownStream {
  return (
    stream === CONTROL_STREAM ||
    stream === KEYS_STREAM ||
    stream === LORO_STREAM ||
    stream === FLOCK_STREAM
  );
}

/** Bound tokens are org-scoped. Unbound tokens still need current ledger membership. */
export function authorizeBoundCredential(
  credentialGenesisHex: string | null,
  requestGenesisHex: string
): boolean {
  return credentialGenesisHex === null || credentialGenesisHex === requestGenesisHex;
}

export function authorizeMembership(state: OrgState, deviceHex: string): boolean {
  return state.devices.has(deviceHex);
}

export function authorizeCurrentMember(input: {
  readonly state: OrgState;
  readonly deviceHex: string;
  readonly credentialGenesisHex: string | null;
  readonly requestGenesisHex: string;
}): boolean {
  return (
    authorizeBoundCredential(input.credentialGenesisHex, input.requestGenesisHex) &&
    authorizeMembership(input.state, input.deviceHex)
  );
}

export function authorizeJoinSigner(
  credentialDeviceHex: string,
  joinSigningPublicKey: string
): boolean {
  return credentialDeviceHex === joinSigningPublicKey;
}

function deny(
  status: 403 | 404,
  error: 'unauthorized' | 'unknown-stream' | 'method-not-allowed'
): GatewayDecision {
  return { ok: false, status, error };
}

/**
 * Honest-host stream ACL from a verified ledger. Riverrun is storage only;
 * callers must not consult sqlite Riverrun for roles.
 */
export function authorizeStreamRequest(input: {
  readonly state: OrgState;
  readonly deviceHex: string;
  readonly credentialGenesisHex: string | null;
  readonly requestGenesisHex: string;
  readonly stream: string;
  readonly method: string;
  readonly sub: string | undefined;
}): GatewayDecision {
  if (!isKnownStream(input.stream)) return deny(404, 'unknown-stream');
  if (!authorizeCurrentMember(input)) return deny(403, 'unauthorized');

  const { method, sub, stream, state, deviceHex } = input;
  const isRead = method === 'GET' || method === 'HEAD';
  if (isRead && (sub === undefined || sub === 'snapshot' || sub === 'bootstrap')) {
    return { ok: true, action: 'read' };
  }

  if (method === 'POST' && sub === 'append-cas' && stream === CONTROL_STREAM) {
    return { ok: true, action: 'control-cas' };
  }

  if (method === 'POST' && sub === 'append-cas' && stream === KEYS_STREAM) {
    if (!canSendEpoch(state, fromHex(deviceHex))) return deny(403, 'unauthorized');
    return { ok: true, action: 'keys-cas' };
  }

  const content = stream === LORO_STREAM || stream === FLOCK_STREAM;
  if (method === 'PUT' && sub === 'snapshot' && content) {
    if (!deviceMayWriteDocument(state, deviceHex)) return deny(403, 'unauthorized');
    return { ok: true, action: 'snapshot-put' };
  }

  if (method === 'POST' && (sub === undefined || sub === 'append-cas') && content) {
    if (!deviceMayWriteDocument(state, deviceHex)) return deny(403, 'unauthorized');
    return { ok: true, action: 'content-cas' };
  }

  return deny(403, 'method-not-allowed');
}
