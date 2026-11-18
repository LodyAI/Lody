import { z } from 'zod';
/** Private authenticated local socket only; never a machine/cloud RPC command. */
export const LOCAL_SESSION_BODY_FREEZE_PATH = '/session-body-freeze';
const id = z.string().min(1).max(1024);
export const nativeSessionBodyFreezeRequestSchema = z
  .object({
    accountId: id,
    workspaceId: id.regex(/^[A-Za-z0-9_-]+$/),
    sessionId: id,
    nonce: z.string().uuid(),
    phase: z.enum(['prepare', 'freeze', 'assert', 'publish', 'abort']),
  })
  .strict();
export type NativeSessionBodyFreezeRequest = z.infer<typeof nativeSessionBodyFreezeRequestSchema>;
export const nativeSessionBodyFreezeReceiptSchema = nativeSessionBodyFreezeRequestSchema
  .extend({
    ok: z.literal(true),
    phase: z.enum(['freeze', 'assert']),
    ownerGeneration: id,
    source: z
      .object({
        sourceId: id,
        present: z.boolean(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        byteLength: z.number().int().nonnegative().safe(),
      })
      .strict(),
  })
  .strict();
export type NativeSessionBodyFreezeReceipt = z.infer<typeof nativeSessionBodyFreezeReceiptSchema>;
export const nativeSessionBodyPrepareReceiptSchema = nativeSessionBodyFreezeRequestSchema
  .extend({
    ok: z.literal(true),
    phase: z.literal('prepare'),
    ownerGeneration: id,
    prepared: z.literal(true),
  })
  .strict();
export const nativeSessionBodyReleaseReceiptSchema = nativeSessionBodyFreezeRequestSchema
  .extend({
    ok: z.literal(true),
    phase: z.enum(['publish', 'abort']),
    ownerGeneration: id,
    released: z.literal(true),
  })
  .strict();
export const nativeSessionBodyFreezeResponseSchema = z.union([
  nativeSessionBodyFreezeReceiptSchema,
  nativeSessionBodyPrepareReceiptSchema,
  nativeSessionBodyReleaseReceiptSchema,
  z
    .object({
      ok: z.literal(false),
      error: z.enum(['invalid_request', 'scope_unavailable', 'freeze_unconfirmed']),
    })
    .strict(),
]);
export type NativeSessionBodyFreezeResponse = z.infer<typeof nativeSessionBodyFreezeResponseSchema>;
