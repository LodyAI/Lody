import { z } from 'zod';
import type { E2eeMachineSharingReplies, E2eeMachineSharingRequests } from '@lody/platform';
export const generation = z.string().regex(/^[0-9a-f]{64}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const requestId = z.string().regex(/^[0-9a-f]{32}$/);
export const id = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => new TextEncoder().encode(v).length <= 256);
export const sharingChangeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('session'),
      sessionId: id,
      audience: z.union([z.literal('team'), z.object({ userId: id }).strict()]).optional(),
      level: z.literal('read').nullable(),
    })
    .strict(),
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
      scopeSchema.extend({
        ...headSchema.shape,
        status: z.literal('active'),
        version: versionSchema.optional(),
      }),
      removedSchema,
    ])
    .nullable(),
  readVersion: z.union([versionSchema, removedSchema]).nullable(),
  readRequest: z.union([versionSchema, removedSchema]).nullable(),
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
/** Convex refuses an unknown argument with `ArgumentValidationError`, naming the field. */
const rejectsIncludeVersion = (error: unknown) => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /ArgumentValidationError/.test(message) && /includeVersion/.test(message);
};
/**
 * A `readHead` call that asks the backend to inline the active original, saving the
 * `readVersion` round trip. A backend that predates the optional field rejects it; the
 * call is then repeated once without it, and this instance stops asking. Keep one per
 * transport/client instance so the fallback costs at most one extra request.
 */
export function makeInlineVersionReadHead() {
  let supported = true;
  return async <A>(
    input: E2eeMachineSharingRequests['readHead'],
    call: (input: E2eeMachineSharingRequests['readHead']) => Promise<A>
  ): Promise<A> => {
    const { includeVersion: _, ...plain } = input;
    if (!supported) return call(plain);
    try {
      return await call({ ...plain, includeVersion: true });
    } catch (error) {
      if (!rejectsIncludeVersion(error)) throw error;
      supported = false;
      return call(plain);
    }
  };
}
