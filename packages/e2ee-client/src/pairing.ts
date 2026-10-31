import { Result } from 'effect';
import { z } from 'zod';
import {
  verifyWorkspaceInvitationSnapshot,
  type WorkspaceInvitation,
  type WorkspaceInvitationSnapshot,
} from '@lody/e2ee-core';
import {
  Bytes,
  hashRecordBytes,
  verifyLedger,
  possessionSigningBytes,
  verifySignature,
  verifyDeviceCredentialBinding,
} from '@lody/e2ee-core/protocol';
import { toHex, fromHex, base64, unbase64 } from './bytes';

const hex = toHex;
const raw = fromHex;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const session = z.string().regex(/^[0-9a-f]{32}$/);
const signature = z.string().regex(/^[0-9a-f]{128}$/);
const workspace = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const PersonalPairingOfferSchema = z
  .object({
    version: z.literal(1),
    workspaceId: workspace,
    genesisHash: hash,
    genesisRecordHex: z
      .string()
      .regex(/^(?:[0-9a-f]{2})+$/)
      .max(16384),
    endorser: hash,
    membershipId: session,
    pairingSessionId: session,
  })
  .strict();
/** Independently transferred by the approving desktop; mailbox data never chooses these pins. */
export type PersonalPairingOffer = z.infer<typeof PersonalPairingOfferSchema>;
const requestSchema = PersonalPairingOfferSchema.extend({
  signingPublicKey: hash,
  encryptionPublicKey: hash,
  credentialHash: hash,
  possessionSignature: signature,
  bindingSignature: signature,
  protection: z.enum(['os-keystore', 'web-crypto']),
}).strict();
export type PersonalPairingRequest = z.infer<typeof requestSchema>;
const fail = (code: string): Error & { code: string } =>
  Object.assign(new Error(`e2ee_${code}`), { code });
export function decodePersonalRequest(value: string): PersonalPairingRequest {
  if (typeof value !== 'string' || value.length > 16384 || !/^(?:[0-9a-f]{2})+$/.test(value))
    throw fail('invalid-input');
  const parsed = requestSchema.safeParse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw(value)))
  );
  if (!parsed.success) throw fail('invalid-input');
  return parsed.data;
}
/** Versioned public transport bundle; signatures cover the original core bytes. */
export function encodePersonalInvitation(
  receipt: Parameters<typeof verifyWorkspaceInvitationSnapshot>[1]
): string {
  return hex(
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        workspaceId: receipt.workspaceId,
        snapshot: base64(receipt.snapshot),
        head: hex(receipt.head.toBytes()),
        length: receipt.length,
        headSignature: hex(receipt.headSignature.toBytes()),
        offset: receipt.offset,
      })
    )
  );
}
const invitationSchema = z
  .object({
    version: z.literal(1),
    workspaceId: workspace,
    snapshot: z
      .string()
      .min(4)
      .max(2796204)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    head: hash,
    length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    headSignature: signature,
    offset: z.string().min(1).max(1024),
  })
  .strict();
export function decodePersonalInvitation(value: string): WorkspaceInvitationSnapshot {
  if (
    typeof value !== 'string' ||
    value.length > 6 * 1024 * 1024 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(value)
  )
    throw fail('invalid-input');
  const parsed = invitationSchema.safeParse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw(value)))
  );
  if (!parsed.success) throw fail('invalid-input');
  const data = parsed.data,
    snapshot = unbase64(data.snapshot);
  if (snapshot.length > 2 * 1024 * 1024 || base64(snapshot) !== data.snapshot)
    throw fail('invalid-input');
  return {
    workspaceId: data.workspaceId,
    snapshot: new Uint8Array(snapshot),
    head: Result.getOrThrow(Bytes.recordHash(raw(data.head))),
    length: data.length,
    headSignature: Result.getOrThrow(Bytes.signature(raw(data.headSignature))),
    offset: data.offset,
  };
}
export function personalInvitationPin(pin: PersonalPairingOffer): WorkspaceInvitation {
  return {
    workspaceId: pin.workspaceId,
    genesis: Result.getOrThrow(Bytes.genesisHash(raw(pin.genesisHash))),
    endorser: Result.getOrThrow(Bytes.signingPublicKey(raw(pin.endorser))),
  };
}

/** Authenticate the independently transferred genesis bytes before preparing any client identity. */
export function verifyPersonalOffer(source: PersonalPairingOffer) {
  return Result.try({
    try: () => {
      const offer = PersonalPairingOfferSchema.parse(source);
      const genesis = Result.getOrThrow(Bytes.genesisHash(raw(offer.genesisHash)));
      const record = raw(offer.genesisRecordHex);
      if (hex(hashRecordBytes(record).toBytes()) !== offer.genesisHash)
        throw fail('invalid-ledger');
      return Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records: [record],
          checkpoint: { head: hashRecordBytes(record), length: 1 },
        })
      );
    },
    catch: () => fail('invalid-ledger'),
  });
}
/** Verify exact offer, possession and credential binding. This proves key ownership, not desktop consent or current ledger permission. */
export function verifyPersonalRequest(offer: PersonalPairingOffer, original: string) {
  return Result.gen(function* () {
    yield* verifyPersonalOffer(offer);
    const request = yield* Result.try({
      try: () => decodePersonalRequest(original),
      catch: () => fail('invalid-input'),
    });
    if (
      Object.keys(offer).some(
        (key) =>
          offer[key as keyof PersonalPairingOffer] !== request[key as keyof PersonalPairingOffer]
      )
    )
      return yield* Result.fail(fail('conflict'));
    const genesis = yield* Bytes.genesisHash(raw(offer.genesisHash));
    const signingPublicKey = yield* Bytes.signingPublicKey(raw(request.signingPublicKey));
    const encryptionPublicKey = yield* Bytes.encryptionPublicKey(raw(request.encryptionPublicKey));
    const message = yield* possessionSigningBytes({
      genesis,
      targetMembershipId: yield* Bytes.membershipId(raw(offer.membershipId)),
      signingPublicKey,
      encryptionPublicKey,
      kind: 'personal',
    });
    yield* verifySignature(signingPublicKey.toBytes(), message, raw(request.possessionSignature));
    yield* verifyDeviceCredentialBinding(
      {
        genesis,
        pairingSessionId: raw(offer.pairingSessionId),
        signingPublicKey,
        credentialHash: raw(request.credentialHash),
      },
      raw(request.bindingSignature)
    );
    return request;
  });
}
/** Qualify the independently pinned endorser's snapshot. The host still checks its own exact device, membership and current admission before key reception. */
export function verifyPersonalApproval(
  offer: PersonalPairingOffer,
  receipt: WorkspaceInvitationSnapshot
) {
  return Result.gen(function* () {
    yield* verifyPersonalOffer(offer);
    return yield* verifyWorkspaceInvitationSnapshot(personalInvitationPin(offer), receipt);
  });
}
