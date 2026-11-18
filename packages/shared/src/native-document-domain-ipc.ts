import { z } from 'zod';
import {
  PreviewVisualCommentMutationSchema,
  previewVisualCommentPayloadSchema,
} from './preview-comment-mutation';
import {
  ScheduleDefinitionSchema,
  ScheduledMessageSchema,
  ScheduleActivitySchema,
  SCHEDULE_PROMPT_MAX_BYTES,
} from './schedule-types';
import type { PreviewVisualCommentDocInput } from './preview-comment-schema';
import type { ScheduleDocument } from './schedule-types';

const id = z.string().min(1).max(512);
export const nativeDocumentDomainTargetSchema = z.discriminatedUnion('domain', [
  z.object({ domain: z.literal('preview_comments'), id }).strict(),
  z.object({ domain: z.literal('schedule_definition'), id }).strict(),
]);
export type NativeDocumentDomainTarget = z.infer<typeof nativeDocumentDomainTargetSchema>;
export const nativeDocumentDomainRequestSchema = z
  .object({
    registrationId: z.uuid(),
    requestId: z.uuid(),
    target: nativeDocumentDomainTargetSchema,
  })
  .strict();
export type NativeDocumentDomainRequest = z.infer<typeof nativeDocumentDomainRequestSchema>;
const draft = ScheduleDefinitionSchema.pick({
  title: true,
  machineId: true,
  trigger: true,
  misfirePolicy: true,
  overlapPolicy: true,
  agent: true,
  project: true,
  retryPolicy: true,
})
  .extend({
    prompt: z.string().max(SCHEDULE_PROMPT_MAX_BYTES),
    message: ScheduledMessageSchema.optional(),
    destination: ScheduleDefinitionSchema.shape.destination.optional(),
  })
  .strict();
const key = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-zA-Z0-9_-]+$/);
const now = z.number().int().nonnegative().max(8_640_000_000_000_000);
/** Actor, namespace, room, writer, schema, paths and SDK capabilities are absent. */
export const nativeDocumentDomainCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('preview-mutate'), mutation: PreviewVisualCommentMutationSchema })
    .strict(),
  z
    .object({
      kind: z.literal('schedule-save'),
      draft,
      now,
      activationId: key,
      activityId: key,
      create: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('schedule-enabled'),
      enabled: z.boolean(),
      now,
      activationId: key,
      requestId: key,
      requesterSessionId: key.optional(),
    })
    .strict(),
]);
export type NativeDocumentDomainCommand = z.infer<typeof nativeDocumentDomainCommandSchema>;
export const nativeDocumentDomainExecuteSchema = nativeDocumentDomainRequestSchema
  .extend({
    expectedGeneration: z.string().min(1).max(4096),
    command: nativeDocumentDomainCommandSchema,
  })
  .strict();
/** Creation is separate from passive route/read and from already-admitted
 * business writes. Main chooses the author and whether this feature is enabled. */
export const nativeDocumentDomainCreateScheduleSchema = nativeDocumentDomainRequestSchema
  .extend({
    target: z.object({ domain: z.literal('schedule_definition'), id }).strict(),
    draft,
    now,
    activationId: key,
    activityId: key,
  })
  .strict();
export const nativeDocumentDomainEnsurePreviewSchema = nativeDocumentDomainRequestSchema
  .extend({
    target: z.object({ domain: z.literal('preview_comments'), id }).strict(),
  })
  .strict();
export type NativeDocumentDomainCreateScheduleRequest = z.infer<
  typeof nativeDocumentDomainCreateScheduleSchema
>;
export type NativeDocumentDomainEnsurePreviewRequest = z.infer<
  typeof nativeDocumentDomainEnsurePreviewSchema
>;
export const nativeDocumentDomainReleaseSchema = nativeDocumentDomainRequestSchema
  .extend({ leaseId: z.uuid() })
  .strict();
const preview = z
  .object({
    meta: z.object({ sessionId: id }).strip(),
    turns: z.record(
      z.string(),
      z.object({ turnId: id, comments: z.array(previewVisualCommentPayloadSchema.strip()) }).strip()
    ),
  })
  .strip();
const schedule = z
  .object({
    definition: ScheduleDefinitionSchema,
    prompt: z.string(),
    message: ScheduledMessageSchema.optional(),
    timeline: z.array(ScheduleActivitySchema.strip()),
  })
  .strip()
  .nullable();
export const nativeDocumentDomainSnapshotSchema = z.discriminatedUnion('domain', [
  z
    .object({
      domain: z.literal('preview_comments'),
      generation: z.string().min(1).max(4096),
      value: preview,
    })
    .strict(),
  z
    .object({
      domain: z.literal('schedule_definition'),
      generation: z.string().min(1).max(4096),
      value: schedule,
    })
    .strict(),
]);
export type NativeDocumentDomainSnapshot = z.infer<typeof nativeDocumentDomainSnapshotSchema>;
export const nativeDocumentDomainCommandResultSchema = z
  .object({
    generation: z.string().min(1).max(4096),
    changed: z.boolean(),
    snapshot: nativeDocumentDomainSnapshotSchema.optional(),
  })
  .strict();
export const nativeDocumentDomainEventSchema = nativeDocumentDomainRequestSchema
  .extend({
    leaseId: z.uuid(),
    event: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('snapshot'), snapshot: nativeDocumentDomainSnapshotSchema })
        .strict(),
      z
        .object({
          kind: z.literal('error'),
          code: z.enum(['restart_required', 'access_denied', 'unavailable']),
        })
        .strict(),
    ]),
  })
  .strict();
export type NativeDocumentDomainEvent = z.infer<typeof nativeDocumentDomainEventSchema>;
export const nativeDocumentDomainErrorCodeSchema = z.enum([
  'restart_required',
  'access_denied',
  'invalid_request',
  'cleanup_unconfirmed',
  'unavailable',
]);
export type NativeDocumentDomainErrorCode = z.infer<typeof nativeDocumentDomainErrorCodeSchema>;
export class NativeDocumentDomainIpcError extends Error {
  constructor(readonly code: NativeDocumentDomainErrorCode) {
    super(`native_document_domain_${code}`);
    this.name = 'NativeDocumentDomainIpcError';
  }
}
export function parseNativeDocumentDomainInput<A>(schema: z.ZodType<A>, input: unknown): A {
  try {
    // Only finite public JSON commands are accepted. This budget is enforced
    // before semantic work; an SDK value or private error is never serialized.
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 512 * 1024) throw new Error();
    return schema.parse(input);
  } catch {
    throw new NativeDocumentDomainIpcError('invalid_request');
  }
}
export function projectNativeDocumentDomainSnapshot(
  target: NativeDocumentDomainTarget,
  generation: string,
  value: PreviewVisualCommentDocInput | ScheduleDocument | null
): NativeDocumentDomainSnapshot {
  const parsed = nativeDocumentDomainSnapshotSchema.parse({
    domain: target.domain,
    generation,
    value,
  });
  if (parsed.domain === 'preview_comments' && parsed.value.meta.sessionId !== target.id)
    throw new NativeDocumentDomainIpcError('access_denied');
  if (
    parsed.domain === 'schedule_definition' &&
    parsed.value &&
    parsed.value.definition.scheduleId !== target.id
  )
    throw new NativeDocumentDomainIpcError('access_denied');
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 2 * 1024 * 1024)
    throw new NativeDocumentDomainIpcError('unavailable');
  return parsed;
}
