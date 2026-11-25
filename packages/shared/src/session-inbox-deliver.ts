import { z } from 'zod';

export const LOCAL_SESSION_INBOX_DELIVER_PATH = '/session-inbox-deliver';

/** Ryugi custom-host exit code that unsubscribes the Session and stops its worker. */
export const RYUGI_UNSUBSCRIBE_EXIT_CODE = 10;

export const SessionInboxDeliverSourceSchema = z.enum(['ryugi']);
export type SessionInboxDeliverSource = z.infer<typeof SessionInboxDeliverSourceSchema>;

export const SessionInboxDeliverMetadataSchema = z
  .object({
    host: z.string().trim().min(1).max(64).optional(),
    label: z.string().trim().min(1).max(256).optional(),
    artifact: z.string().trim().min(1).max(256).optional(),
    eventType: z.string().trim().min(1).max(256).optional(),
    project: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();
export type SessionInboxDeliverMetadata = z.infer<typeof SessionInboxDeliverMetadataSchema>;

export const SessionInboxDeliverRequestSchema = z
  .object({
    source: SessionInboxDeliverSourceSchema,
    sessionId: z.string().trim().min(1).max(256),
    /** Unchanged message text from the external host; must contain non-whitespace text. */
    message: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, 'Message must not be blank'),
    /** Optional deterministic identity for idempotent retry deduplication. */
    dedupeKey: z.string().trim().min(1).max(256).optional(),
    metadata: SessionInboxDeliverMetadataSchema.optional(),
  })
  .strict();
export type SessionInboxDeliverRequest = z.infer<typeof SessionInboxDeliverRequestSchema>;

export const SessionInboxDeliverResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('queued'),
      sessionId: z.string().min(1),
      userTurnId: z.string().min(1),
      deduplicated: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('retry'),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('unsubscribe'),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type SessionInboxDeliverResponse = z.infer<typeof SessionInboxDeliverResponseSchema>;
