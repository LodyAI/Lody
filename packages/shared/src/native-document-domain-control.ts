import { z } from 'zod';
import { rendererDocumentDomainScopeSchema } from './renderer-document-domain-migration';
/** Private authenticated local endpoint only. Never Machine RPC/cloud or an
 * executable/path/namespace chosen by a renderer. */
export const LOCAL_DOCUMENT_DOMAIN_FREEZE_PATH = '/document-domain-freeze';
const id = z.string().min(1).max(1024);
export const nativeDocumentDomainFreezeRequestSchema = z
  .object({
    accountId: id,
    workspaceId: id.regex(/^[A-Za-z0-9_-]+$/),
    scope: rendererDocumentDomainScopeSchema,
    nonce: z.uuid(),
    purpose: z.literal('create').optional(),
    phase: z.enum(['prepare', 'freeze', 'assert', 'publish', 'abort']),
  })
  .strict();
export type NativeDocumentDomainFreezeRequest = z.infer<
  typeof nativeDocumentDomainFreezeRequestSchema
>;
const success = nativeDocumentDomainFreezeRequestSchema
  .extend({ ok: z.literal(true), ownerGeneration: id, metadataGeneration: id })
  .strict();
export const nativeDocumentDomainFreezeReceiptSchema = success
  .extend({
    phase: z.enum(['freeze', 'assert']),
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
export type NativeDocumentDomainFreezeReceipt = z.infer<
  typeof nativeDocumentDomainFreezeReceiptSchema
>;
export const nativeDocumentDomainFreezeResponseSchema = z.union([
  nativeDocumentDomainFreezeReceiptSchema,
  success.extend({ phase: z.literal('prepare'), prepared: z.literal(true) }).strict(),
  success.extend({ phase: z.enum(['publish', 'abort']), released: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum(['invalid_request', 'scope_unavailable', 'freeze_unconfirmed']),
    })
    .strict(),
]);
export type NativeDocumentDomainFreezeResponse = z.infer<
  typeof nativeDocumentDomainFreezeResponseSchema
>;
