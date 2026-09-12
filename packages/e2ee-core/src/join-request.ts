import type { SignatureProof } from './chain';
import { decodeTeamAction, encodeTeamAction, type TeamMemberInput } from './team-codec';
import { checkHex, invariant, toHex, WebCryptoControl } from './wire';

const DOMAIN = 'lody-join-request/v1';
const MAX_REQUEST_BYTES = 4096;
const encoder = new TextEncoder();

/** Consent to join as Member. This is not membership, an invitation secret, or an account assertion. */
export interface JoinRequest {
  readonly genesis: string;
  readonly requestId: string;
  readonly approver: { readonly userId: string; readonly instance: string };
  /** Explicit application choice. No implicit duration or expiry default. */
  readonly expiresAt: number | null;
  readonly member: TeamMemberInput;
}

function id(value: unknown): string {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'invalid-join-id');
  return value;
}

function deadline(value: number | null): string {
  if (value === null) return 'none';
  invariant(Number.isSafeInteger(value) && value >= 0, 'invalid-join-expiry');
  return String(value);
}

function stringField(value: unknown): string {
  invariant(typeof value === 'string', 'invalid-join-request');
  return value;
}

function encodeBody(request: JoinRequest): string {
  checkHex(request.genesis, 32);
  checkHex(request.requestId, 16);
  invariant(request.member.device.kind === 'personal', 'initial-device-must-be-personal');
  // Reuse the exact v3 public identity/device encoding, without its mutable chain-head wrapper.
  const { payload } = encodeTeamAction({
    type: 'member.add',
    configVersion: 0,
    member: request.member,
  });
  const body = JSON.stringify([
    DOMAIN,
    request.genesis,
    request.requestId,
    id(request.approver.userId),
    id(request.approver.instance),
    deadline(request.expiresAt),
    payload,
  ]);
  invariant(body.length <= MAX_REQUEST_BYTES, 'join-request-too-large');
  return body;
}

function decodeBody(body: string): JoinRequest {
  const fields: unknown = JSON.parse(body);
  invariant(
    Array.isArray(fields) && fields.length === 7 && fields.every((x) => typeof x === 'string'),
    'invalid-join-request'
  );
  invariant(fields[0] === DOMAIN, 'unsupported-join-version');
  const expiry = stringField(fields[5]);
  invariant(expiry === 'none' || /^(0|[1-9][0-9]*)$/.test(expiry), 'invalid-join-expiry');
  const action = decodeTeamAction({ kind: 'team-member-add', payload: stringField(fields[6]) });
  invariant(action.type === 'member.add' && action.configVersion === 0, 'invalid-join-member');
  const request: JoinRequest = {
    genesis: stringField(fields[1]),
    requestId: stringField(fields[2]),
    approver: { userId: stringField(fields[3]), instance: stringField(fields[4]) },
    expiresAt: expiry === 'none' ? null : Number(expiry),
    member: action.member,
  };
  invariant(encodeBody(request) === body, 'noncanonical-join-request');
  return request;
}

/** Internal parsing only. The chain verifier must check ALL returned proofs before accepting state. */
export function inspectJoinRequest(wire: string): {
  request: JoinRequest;
  proofs: readonly SignatureProof[];
} {
  invariant(typeof wire === 'string' && wire.length <= MAX_REQUEST_BYTES, 'join-request-too-large');
  const tuple: unknown = JSON.parse(wire);
  invariant(
    Array.isArray(tuple) && tuple.length === 3 && tuple.every((x) => typeof x === 'string'),
    'invalid-join-request'
  );
  const body = stringField(tuple[0]);
  const identitySignature = stringField(tuple[1]);
  const deviceSignature = stringField(tuple[2]);
  checkHex(identitySignature, 64);
  checkHex(deviceSignature, 64);
  invariant(JSON.stringify(tuple) === wire, 'noncanonical-join-request');
  const request = decodeBody(body);
  const message = encoder.encode(body);
  return {
    request,
    proofs: [
      { publicKey: request.member.recoverySigningKey, message, signature: identitySignature },
      { publicKey: request.member.device.signingKey, message, signature: deviceSignature },
    ],
  };
}

/** Verify signature/consent only. The approver must independently confirm the claimed account/keys. */
export async function verifyJoinRequest(
  wire: string,
  expectedGenesis: string
): Promise<JoinRequest> {
  checkHex(expectedGenesis, 32);
  const { request, proofs } = inspectJoinRequest(wire);
  invariant(request.genesis === expectedGenesis, 'wrong-join-org');
  const crypto = new WebCryptoControl();
  for (const proof of proofs)
    invariant(
      await crypto.verify(proof.publicKey, proof.message, proof.signature),
      'bad-consent-signature'
    );
  return request;
}

/** Local preflight AND trusted-backend admission check, not historical replay using today's time.
 * The production backend must repeat it at the atomic admission boundary; client clocks are not authority. */
export function assertJoinRequestFresh(request: JoinRequest, now: number): void {
  invariant(Number.isSafeInteger(now) && now >= 0, 'invalid-admission-time');
  deadline(request.expiresAt);
  invariant(request.expiresAt === null || now < request.expiresAt, 'join-request-expired');
}

/** Caller persists the returned exact bytes for delivery/retry. No network or private-key export. */
export async function signJoinRequest(
  request: JoinRequest,
  keys: { readonly identity: CryptoKey; readonly device: CryptoKey },
  subtle: SubtleCrypto = globalThis.crypto.subtle
): Promise<string> {
  const body = encodeBody(request);
  const { identity, device } = keys;
  const message = encoder.encode(body);
  const identitySignature = toHex(new Uint8Array(await subtle.sign('Ed25519', identity, message)));
  const deviceSignature = toHex(new Uint8Array(await subtle.sign('Ed25519', device, message)));
  const wire = JSON.stringify([body, identitySignature, deviceSignature]);
  // Also catches swapped/wrong private-key handles without releasing an unusable request.
  await verifyJoinRequest(wire, decodeBody(body).genesis);
  return wire;
}

/** Namespaced by the signing identity, so another applicant cannot reserve/cancel a guessed ID. */
export function joinRequestKey(request: JoinRequest): string {
  return `${request.member.recoverySigningKey}:${request.requestId}`;
}
