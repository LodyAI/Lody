import { z } from 'zod';
import type { E2eeMachineSharingReplies } from '@lody/platform';
export const generation = z.string().regex(/^[0-9a-f]{64}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const requestId = z.string().regex(/^[0-9a-f]{32}$/);
export const id = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => new TextEncoder().encode(v).length <= 256);
export const sharingChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('machine'), sharedWithTeam: z.boolean() }).strict(),
  z
    .object({ kind: z.literal('project'), localProjectId: id, sharedWithTeam: z.boolean() })
    .strict(),
]);
const scopeSchema = z.object({
  workspaceId: id,
  genesisHash: hash,
  machineId: id,
  ownerMembershipId: requestId,
  generation,
});
const headSchema = z.object({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  digest: hash,
});
const removedSchema = z.union([
  scopeSchema.extend({ status: z.literal('removed'), ...headSchema.shape }),
  scopeSchema.extend({ status: z.literal('removed'), revision: z.literal(0), digest: z.null() }),
]);
const versionSchema = scopeSchema.extend({
  ...headSchema.shape,
  previousDigest: hash.nullable(),
  requestId,
  frameHex: z
    .string()
    .min(286)
    .max(524574)
    .regex(/^(?:[0-9a-f]{2})+$/),
});
export const sharingReplySchemas: {
  [K in keyof E2eeMachineSharingReplies]: z.ZodType<E2eeMachineSharingReplies[K]>;
} = {
  readHead: z
    .union([
      scopeSchema.extend({ ...headSchema.shape, status: z.literal('active') }),
      removedSchema,
    ])
    .nullable(),
  readVersion: z.union([versionSchema, removedSchema]).nullable(),
  readRequest: z.union([versionSchema, removedSchema]).nullable(),
  latestForMember: z
    .union([versionSchema.extend({ status: z.literal('active') }), removedSchema])
    .nullable(),
  commit: z.union([
    z.object({ status: z.literal('committed'), version: versionSchema }),
    z.object({
      status: z.literal('conflict'),
      head: z
        .union([
          scopeSchema.extend({ ...headSchema.shape, status: z.literal('active') }),
          removedSchema,
        ])
        .nullable(),
    }),
    z.object({ status: z.literal('removed'), head: removedSchema }),
  ]),
};
