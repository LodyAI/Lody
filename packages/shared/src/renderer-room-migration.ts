import { z } from 'zod';
export const RENDERER_WF_MAX_SOURCES = 128;
export const RENDERER_WF_MAX_BYTES = 16 * 1024 * 1024;

/** Internal product-window protocol. Main derives window/account identity from its trusted registration. */
export const rendererWfBindingSchema = z
  .object({
    accountId: z.string().min(1).max(512),
    workspaceId: z.string().min(1).max(256),
    roomId: z.string().min(1).max(1024),
    contentMode: z.literal('plaintext'),
  })
  .strict()
  .refine((value) => value.roomId === `${value.workspaceId}:wf:workspace`);
export type RendererWfBinding = z.infer<typeof rendererWfBindingSchema>;
export const rendererWfOwnerSchema = z
  .object({
    binding: rendererWfBindingSchema,
    revision: z.string().min(1).max(128),
    owner: z.enum(['legacy', 'frozen', 'native']),
  })
  .strict();
export type RendererWfOwner = z.infer<typeof rendererWfOwnerSchema>;
export const rendererWfRegistrationSchema = rendererWfOwnerSchema
  .extend({ registrationId: z.string().uuid() })
  .strict();
export type RendererWfRegistration = z.infer<typeof rendererWfRegistrationSchema>;
export const rendererWfPublishedOwnerSchema = rendererWfRegistrationSchema
  .extend({ owner: z.literal('native') })
  .strict();
export type RendererWfPublishedOwner = z.infer<typeof rendererWfPublishedOwnerSchema>;
export const rendererWfRequestSchema = z
  .object({
    binding: rendererWfBindingSchema,
    revision: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
    registrationId: z.string().uuid(),
    phase: z.enum(['freeze', 'capture']),
  })
  .strict();
export type RendererWfRequest = z.infer<typeof rendererWfRequestSchema>;
export const rendererWfAckSchema = rendererWfRequestSchema
  .extend({
    failure: z.enum(['drain_failed', 'capture_failed', 'owner_retired']).optional(),
    sources: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(2048),
            dbName: z.string().min(1).max(1024),
            present: z.boolean(),
            snapshot: z.instanceof(Uint8Array),
          })
          .strict()
      )
      .max(RENDERER_WF_MAX_SOURCES)
      .optional(),
  })
  .strict()
  .superRefine((ack, context) => {
    if (ack.failure && ack.sources)
      context.addIssue({ code: 'custom', message: 'Failure ACK cannot carry source payloads' });
    const encoder = new TextEncoder();
    let bytes = encoder.encode(JSON.stringify({ ...ack, sources: undefined })).length;
    for (const source of ack.sources ?? [])
      bytes +=
        source.snapshot.byteLength + encoder.encode(source.dbName + source.sourceId).length + 32;
    if (bytes > RENDERER_WF_MAX_BYTES)
      context.addIssue({ code: 'custom', message: 'Renderer WF inventory exceeds byte budget' });
  });
export type RendererWfAck = z.infer<typeof rendererWfAckSchema>;
export const rendererWfBindingKey = (binding: RendererWfBinding) =>
  JSON.stringify(rendererWfBindingSchema.parse(binding));
