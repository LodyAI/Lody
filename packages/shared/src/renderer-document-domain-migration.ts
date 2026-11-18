import { z } from 'zod';
import {
  nativeDocumentDomainTargetSchema,
  type NativeDocumentDomainTarget,
} from './native-document-domain-ipc';
const id = z.string().min(1).max(1024);
export const DOCUMENT_DOMAIN_CAPTURE_MAX_DATABASES = 128;
export const DOCUMENT_DOMAIN_CAPTURE_MAX_BYTES = 128 * 1024 * 1024;
export const rendererDocumentDomainBindingSchema = z
  .object({ accountId: id, workspaceId: id, contentMode: z.literal('plaintext') })
  .strict();
export type RendererDocumentDomainBinding = z.infer<typeof rendererDocumentDomainBindingSchema>;
export function documentDomainMigrationScope(target: NativeDocumentDomainTarget) {
  const parsed = nativeDocumentDomainTargetSchema.parse(target);
  const roomId = `${parsed.domain === 'preview_comments' ? 'preview-comment-' : 'schedule-'}${parsed.id}`;
  return {
    ...parsed,
    roomId,
    metadataDocId: roomId,
    ...(parsed.domain === 'preview_comments'
      ? { parentMetadataDocId: `session-${parsed.id}` }
      : {}),
  };
}
export const rendererDocumentDomainScopeSchema = z
  .object({
    domain: z.enum(['preview_comments', 'schedule_definition']),
    id: id.max(512),
    roomId: id,
    metadataDocId: id,
    parentMetadataDocId: id.optional(),
  })
  .strict()
  .superRefine((scope, ctx) => {
    const exact = documentDomainMigrationScope({ domain: scope.domain, id: scope.id });
    if (
      scope.roomId !== exact.roomId ||
      scope.metadataDocId !== exact.metadataDocId ||
      scope.parentMetadataDocId !== exact.parentMetadataDocId
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Document family, room and metadata scope must agree',
      });
  });
export type RendererDocumentDomainScope = z.infer<typeof rendererDocumentDomainScopeSchema>;
export const rendererDocumentDomainOwnerSchema = z
  .object({
    scope: rendererDocumentDomainScopeSchema,
    revision: id,
    owner: z.enum(['frozen', 'native']),
  })
  .strict();
export const rendererDocumentDomainRegistrationSchema = z
  .object({
    binding: rendererDocumentDomainBindingSchema,
    metadataGeneration: id,
    registrationId: z.uuid(),
    rooms: z.array(rendererDocumentDomainOwnerSchema),
    creationEnabled: z.boolean().optional(),
  })
  .strict();
export type RendererDocumentDomainRegistration = z.infer<
  typeof rendererDocumentDomainRegistrationSchema
>;
export const rendererDocumentDomainRequestSchema = z
  .object({
    binding: rendererDocumentDomainBindingSchema,
    metadataGeneration: id,
    registrationId: z.uuid(),
    requestId: z.uuid(),
    scope: rendererDocumentDomainScopeSchema,
    revision: id,
    phase: z.enum(['enumerate', 'freeze', 'capture', 'publish']),
  })
  .strict();
export type RendererDocumentDomainRequest = z.infer<typeof rendererDocumentDomainRequestSchema>;
export const rendererDocumentDomainSourceSchema = z
  .object({ sourceId: id, dbName: id, present: z.boolean(), snapshot: z.instanceof(Uint8Array) })
  .strict()
  .superRefine((source, ctx) => {
    if (source.present === (source.snapshot.byteLength === 0))
      ctx.addIssue({ code: 'custom', message: 'Only present sources contain binary bytes' });
  });
export type RendererDocumentDomainSource = z.infer<typeof rendererDocumentDomainSourceSchema>;
export const rendererDocumentDomainAckSchema = rendererDocumentDomainRequestSchema
  .extend({
    databases: z
      .array(z.object({ sourceId: id, dbName: id }).strict())
      .max(DOCUMENT_DOMAIN_CAPTURE_MAX_DATABASES)
      .optional(),
    failure: z.enum(['drain_failed', 'capture_failed', 'owner_retired']).optional(),
    sources: z
      .array(rendererDocumentDomainSourceSchema)
      .max(DOCUMENT_DOMAIN_CAPTURE_MAX_DATABASES)
      .optional(),
  })
  .strict()
  .superRefine((ack, ctx) => {
    if (
      !ack.failure &&
      ((ack.phase === 'enumerate' && !ack.databases) || (ack.phase === 'capture' && !ack.sources))
    )
      ctx.addIssue({ code: 'custom', message: 'Complete document source inventory required' });
    if (ack.failure && ack.sources)
      ctx.addIssue({
        code: 'custom',
        message: 'Failed capture cannot include a successful inventory',
      });
    if (
      ack.sources &&
      new Set(ack.sources.map((source) => source.sourceId)).size !== ack.sources.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate source identity' });
    if (
      (ack.sources ?? []).reduce(
        (size, source) =>
          size +
          source.snapshot.byteLength +
          new TextEncoder().encode(source.sourceId + source.dbName).byteLength +
          64,
        0
      ) > DOCUMENT_DOMAIN_CAPTURE_MAX_BYTES
    )
      ctx.addIssue({ code: 'custom', message: 'Complete document source budget exceeded' });
  });
export type RendererDocumentDomainAck = z.infer<typeof rendererDocumentDomainAckSchema>;
