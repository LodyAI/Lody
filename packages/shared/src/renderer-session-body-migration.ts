import { z } from 'zod';
export const SESSION_BODY_CAPTURE_MAX_DATABASES = 128;
export const SESSION_BODY_CAPTURE_MAX_BYTES = 128 * 1024 * 1024;
const id = z.string().min(1).max(1024);
export const rendererSessionBodyBindingSchema = z
  .object({ accountId: id, workspaceId: id, contentMode: z.literal('plaintext') })
  .strict();
export type RendererSessionBodyBinding = z.infer<typeof rendererSessionBodyBindingSchema>;
export const rendererSessionBodyOwnerSchema = z
  .object({ sessionId: id, revision: id, owner: z.enum(['frozen', 'native']) })
  .strict();
export const rendererSessionBodyRegistrationSchema = z
  .object({
    binding: rendererSessionBodyBindingSchema,
    registrationId: z.string().uuid(),
    rooms: z.array(rendererSessionBodyOwnerSchema),
  })
  .strict();
export type RendererSessionBodyRegistration = z.infer<typeof rendererSessionBodyRegistrationSchema>;
export const rendererSessionBodyRequestSchema = z
  .object({
    binding: rendererSessionBodyBindingSchema,
    registrationId: z.string().uuid(),
    requestId: z.string().uuid(),
    sessionId: id,
    revision: id,
    phase: z.enum(['enumerate', 'freeze', 'capture', 'publish']),
  })
  .strict();
export type RendererSessionBodyRequest = z.infer<typeof rendererSessionBodyRequestSchema>;
export const rendererSessionBodySourceSchema = z
  .object({ sourceId: id, dbName: id, present: z.boolean(), snapshot: z.instanceof(Uint8Array) })
  .strict()
  .superRefine((source, ctx) => {
    if (source.present === (source.snapshot.byteLength === 0))
      ctx.addIssue({
        code: 'custom',
        message: 'Present sources require complete binary; absence requires empty binary',
      });
  });
export type RendererSessionBodySource = z.infer<typeof rendererSessionBodySourceSchema>;
export const rendererSessionBodyAckSchema = rendererSessionBodyRequestSchema
  .extend({
    databases: z
      .array(z.object({ sourceId: id, dbName: id }).strict())
      .max(SESSION_BODY_CAPTURE_MAX_DATABASES)
      .optional(),
    failure: z.enum(['drain_failed', 'capture_failed', 'owner_retired']).optional(),
    sources: z
      .array(rendererSessionBodySourceSchema)
      .max(SESSION_BODY_CAPTURE_MAX_DATABASES)
      .optional(),
  })
  .strict()
  .superRefine((ack, ctx) => {
    if (ack.phase === 'enumerate' && !ack.failure && !ack.databases)
      ctx.addIssue({ code: 'custom', message: 'Complete database enumeration required' });
    if (ack.failure && ack.sources)
      ctx.addIssue({ code: 'custom', message: 'Failure cannot include successful inventory' });
    if (ack.phase === 'capture' && !ack.failure && !ack.sources)
      ctx.addIssue({ code: 'custom', message: 'Complete capture inventory required' });
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
      ) > SESSION_BODY_CAPTURE_MAX_BYTES
    )
      ctx.addIssue({ code: 'custom', message: 'Complete Session inventory exceeds budget' });
  });
export type RendererSessionBodyAck = z.infer<typeof rendererSessionBodyAckSchema>;
export const rendererSessionBodyRegisterSchema = z
  .object({ registrationId: z.string().uuid() })
  .strict();
