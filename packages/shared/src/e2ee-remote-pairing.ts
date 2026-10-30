import { z } from 'zod';
import { LocalE2eePrepareResponseSchema } from './e2ee-local-pairing';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const endpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  });
/** The command itself is the independent trust input. Never replace its pins from a relay reply. */
export const RemoteMachineOfferSchema = z
  .object({
    version: z.literal(1),
    accountId: id,
    workspaceId: id,
    genesisHash: hash,
    genesisRecordHex: z.string().regex(/^(?:[0-9a-f]{2}){1,8192}$/),
    membershipId: z.string().regex(/^[0-9a-f]{32}$/),
    frontendSigningPublicKey: hash,
    pairingSessionId: z.string().regex(/^[0-9a-f]{32}$/),
    deploymentUrl: endpoint,
    ingressUrl: endpoint,
    expiresAt: z.number().int().positive().safe(),
    token: hash,
    signature: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict();
export type RemoteMachineOffer = z.infer<typeof RemoteMachineOfferSchema>;
/** Fixed purpose and ordered fields; independent of JSON object insertion order. */
export function remoteMachineOfferBytes(offer: Omit<RemoteMachineOffer, 'signature'>) {
  return new TextEncoder().encode(
    JSON.stringify([
      'lody-e2ee-machine-offer-v1',
      offer.accountId,
      offer.workspaceId,
      offer.genesisHash,
      offer.genesisRecordHex,
      offer.membershipId,
      offer.frontendSigningPublicKey,
      offer.pairingSessionId,
      offer.deploymentUrl,
      offer.ingressUrl,
      offer.expiresAt,
      offer.token,
    ])
  );
}
export const RemoteMachineStatusSchema = z
  .object({
    pairingSessionId: z.string().regex(/^[0-9a-f]{32}$/),
    status: z.enum([
      'pending',
      'claimed',
      'admitting',
      'admitted',
      'conflict',
      'cancelled',
      'expired',
      'ready',
    ]),
    expiresAt: z.number().int().positive().safe(),
    material: LocalE2eePrepareResponseSchema.nullable(),
    noAdmissionReserved: z.boolean().optional(),
    location: z
      .object({ country: z.string().max(80).nullable(), city: z.string().max(80).nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type RemoteMachineStatus = z.infer<typeof RemoteMachineStatusSchema>;
/** Both screens hash all public material, including protection and immutable credential binding. */
export async function remoteMachineSummary(
  offer: RemoteMachineOffer,
  material: z.infer<typeof LocalE2eePrepareResponseSchema>
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      'lody-e2ee-machine-summary-v1',
      offer.accountId,
      offer.workspaceId,
      offer.genesisHash,
      offer.membershipId,
      offer.frontendSigningPublicKey,
      offer.pairingSessionId,
      material.machineId,
      material.signingPublicKey,
      material.encryptionPublicKey,
      material.possessionSignature,
      material.credentialHash,
      material.bindingSignature,
      material.protection,
    ])
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (x) => x.toString(16).padStart(2, '0'))
    .join('')
    .match(/.{8}/g)!
    .join(' ');
}
