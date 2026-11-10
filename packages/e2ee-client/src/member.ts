import { Result } from 'effect';
import { z } from 'zod';
import { Bytes, decodeCbor, encodeCbor, type JoinRequest } from '@lody/e2ee-core/protocol';
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
  })
  .strict();

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
 * The request id is derived from the account, workspace and invitation token, so a
 * reopen finds the same identity and its retained request. Core admits the member under
 * `membershipId = requestId`, and the device-credential binding is signed for that id,
 * so both the membership and the pairing session are the request id. The inviter's
 * endorsement key comes from the independently transferred offer, never the relay. */
export function memberPairingOffer(
  accountId: string,
  offer: E2eeMemberOffer
): PersonalPairingOffer {
  const parsed = MemberOfferSchema.parse(offer);
  const requestId = toHex(
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
