import { Effect, Result } from 'effect';
import { z } from 'zod';
import {
  Bytes,
  decodeCbor,
  encodeCbor,
  prepareLedgerCommand,
  signVerified,
  verifySignature,
  type CborValue,
  type DeviceSigner,
  type JoinRequest,
  type LedgerView,
} from '@lody/e2ee-core/protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import type { E2eeMemberOffer } from '@lody/cloud-api';
import { fromHex, toHex } from './bytes';
import type { PersonalPairingOffer } from './pairing';

/** Member invitations and their key packages, shared by the desktop host and the
 * portable runtime so both decode one public format with the same checks. */

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const bytes = z.string().regex(/^(?:[0-9a-f]{2})+$/);
const ok = Result.getOrThrow;
const fail = (code: string) => Object.assign(new Error(`e2ee_${code}`), { code });

export const MemberOfferSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    genesisHash: hash,
    genesisRecordHex: bytes.max(16384),
    endorser: hash,
    token: hash,
    mode: z.enum(['email', 'link']),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    signature: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict();

const offerDomain = new TextEncoder().encode('lody-e2ee/member-offer/v1\0');
/** Exact bytes the endorsing device signs for an invitation: every pin an approver relies
 * on (genesis, workspace, endorser, token, mode, expiry). The genesis record is checked
 * against its hash separately. */
export function memberOfferSigningBytes(offer: Omit<E2eeMemberOffer, 'signature'>) {
  const body = ok(
    encodeCbor([
      fromHex(offer.genesisHash),
      new TextEncoder().encode(offer.workspaceId),
      fromHex(offer.endorser),
      fromHex(offer.token),
      offer.mode === 'email' ? 1 : 2,
      offer.expiresAt,
    ] satisfies CborValue[])
  );
  const bytes = new Uint8Array(offerDomain.length + body.length);
  bytes.set(offerDomain);
  bytes.set(body, offerDomain.length);
  return bytes;
}

/** Endorse a new invitation with this device's own key; only the endorser itself signs. */
export const signMemberOffer = Effect.fnUntraced(function* (
  offer: Omit<E2eeMemberOffer, 'signature'>,
  signer: DeviceSigner
) {
  if (offer.endorser !== toHex(signer.publicKey.toBytes()))
    return yield* Effect.fail(fail('conflict'));
  const signature = yield* signVerified(signer, memberOfferSigningBytes(offer));
  return { ...offer, signature: toHex(signature.toBytes()) } satisfies E2eeMemberOffer;
});

/** Why an applicant cannot be admitted without an explicit approval. */
export type AutomaticAdmissionRefusal =
  | 'invalid-offer'
  | 'endorser-ineligible'
  | 'expired'
  | 'request-mismatch'
  | 'invitation-used';

/**
 * Whether an email applicant may be admitted unattended. Every fact comes from the
 * endorser's signature and the approver's verified ledger, never from relay labels:
 * the offer must be signed by a device that is, in the current verified state, a
 * personal device of an owner or admin; it must be an unexpired email invitation; and
 * the signed join request must carry the request id derived from that token, which the
 * ledger admits at most once. The relay can still substitute keys for a genuine
 * unexpired invitation that has not been used; that limit is documented, not solved here.
 */
export function verifyAutomaticMemberAdmission(input: {
  view: LedgerView;
  workspaceId: string;
  approver: Bytes.SigningPublicKey;
  offer: unknown;
  request: JoinRequest;
  now: number;
}): Result.Result<void, AutomaticAdmissionRefusal> {
  const parsed = MemberOfferSchema.safeParse(input.offer);
  if (!parsed.success) return Result.fail('invalid-offer');
  const offer = parsed.data;
  const state = input.view.inspectState();
  if (
    offer.workspaceId !== input.workspaceId ||
    offer.genesisHash !== toHex(state.genesis.toBytes()) ||
    offer.mode !== 'email' ||
    Result.isFailure(
      verifySignature(
        fromHex(offer.endorser),
        memberOfferSigningBytes(offer),
        fromHex(offer.signature)
      )
    )
  )
    return Result.fail('invalid-offer');
  const endorser = state.devices.get(offer.endorser);
  const role = endorser && state.members.get(toHex(endorser.membershipId.toBytes()))?.role;
  if (endorser?.kind !== 'personal' || (role !== 'owner' && role !== 'admin'))
    return Result.fail('endorser-ineligible');
  const requestId = toHex(input.request.requestId.toBytes());
  if (
    requestId !== emailMemberRequestId(offer.workspaceId, offer.token) ||
    input.request.expiresAt === null ||
    input.request.expiresAt > offer.expiresAt
  )
    return Result.fail('request-mismatch');
  // One token derives one membership id; the ledger never admits a membership id twice.
  if (state.members.has(requestId)) return Result.fail('invitation-used');
  if (offer.expiresAt <= input.now) return Result.fail('expired');
  const prepared = prepareLedgerCommand(input.view, input.approver, {
    _tag: 'AdmitMember',
    membershipId: ok(Bytes.membershipId(input.request.requestId.toBytes())),
    request: input.request,
  });
  if (Result.isFailure(prepared))
    return Result.fail(prepared.failure.code === 'replay' ? 'invitation-used' : 'request-mismatch');
  return Result.succeed(undefined);
}

/** The single request id an email invitation can admit: derived from the token alone, so a
 * second account presenting the same token collides with the first admission. */
export function emailMemberRequestId(workspaceId: string, token: string) {
  return toHex(
    sha256(
      new TextEncoder().encode(`lody-e2ee/member-join-request/email/v1\0${workspaceId}\0${token}`)
    )
  ).slice(0, 32);
}

const packageSchema = z
  .object({
    version: z.literal(1),
    requestHex: bytes.max(1024),
    credentialHash: hash,
    bindingSignature: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict();

/** Decode public proof only. Genuine ledger admission verifies the consent signature. */
export function decodeMemberKeyPackage(source: string) {
  if (!bytes.max(8192).safeParse(source).success) throw fail('invalid-input');
  const value = packageSchema.parse(JSON.parse(new TextDecoder().decode(fromHex(source))));
  const fields = ok(decodeCbor(fromHex(value.requestHex)));
  if (!Array.isArray(fields) || fields.length !== 6) throw fail('invalid-input');
  const request: JoinRequest = {
    requestId: ok(Bytes.requestId(fields[0])),
    userId: ok(Bytes.userId(fields[1])),
    signingPublicKey: ok(Bytes.signingPublicKey(fields[2])),
    encryptionPublicKey: ok(Bytes.encryptionPublicKey(fields[3])),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(fields[4]),
    signature: ok(Bytes.signature(fields[5])),
  };
  // Canonical bytes only: a re-encoded request must match what was signed and listed.
  if (toHex(ok(encodeCbor(fields))) !== value.requestHex) throw fail('invalid-input');
  return { ...value, request };
}

/** The public key package a joining device submits; the inverse of decodeMemberKeyPackage. */
export function encodeMemberKeyPackage(input: {
  request: JoinRequest;
  credentialHash: string;
  bindingSignature: Uint8Array;
}): string {
  const { request } = input;
  return toHex(
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        requestHex: toHex(
          ok(
            encodeCbor([
              request.requestId.toBytes(),
              request.userId.toBytes(),
              request.signingPublicKey.toBytes(),
              request.encryptionPublicKey.toBytes(),
              request.expiresAt,
              request.signature.toBytes(),
            ])
          )
        ),
        credentialHash: input.credentialHash,
        bindingSignature: toHex(input.bindingSignature),
      })
    )
  );
}

/** The joining device's identity offer for a member invitation on the portable host.
 * The request id is derived from the workspace and invitation token (email invitations,
 * single-use) or additionally the account (link invitations), so a reopen finds the same
 * identity and its retained request. Core admits the member under
 * `membershipId = requestId`, and the device-credential binding is signed for that id,
 * so both the membership and the pairing session are the request id. The inviter's
 * endorsement key comes from the independently transferred offer, never the relay. */
export function memberPairingOffer(
  accountId: string,
  offer: E2eeMemberOffer
): PersonalPairingOffer {
  const parsed = MemberOfferSchema.parse(offer);
  const requestId =
    parsed.mode === 'email'
      ? emailMemberRequestId(parsed.workspaceId, parsed.token)
      : toHex(
          sha256(
            new TextEncoder().encode(
              `lody-e2ee/member-join-request/v1\0${accountId}\0${parsed.workspaceId}\0${parsed.token}`
            )
          )
        ).slice(0, 32);
  return {
    version: 1,
    workspaceId: parsed.workspaceId,
    genesisHash: parsed.genesisHash,
    genesisRecordHex: parsed.genesisRecordHex,
    endorser: parsed.endorser,
    membershipId: requestId,
    pairingSessionId: requestId,
  };
}
