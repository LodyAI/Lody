import { z } from 'zod';
import { ScheduleDefinitionSchema, ScheduleTriggerSchema } from './schedule-types';

const id = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const ScheduleDraftSchema = ScheduleDefinitionSchema.pick({
  title: true,
  machineId: true,
  trigger: true,
  misfirePolicy: true,
  overlapPolicy: true,
  agent: true,
  project: true,
  retryPolicy: true,
})
  .extend({ prompt: z.string().min(1).max(32768) })
  .strict();

export const ScheduleCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(30),
      offset: z.number().int().min(0).max(100_000).optional(),
    })
    .strict(),
  z.object({ action: z.literal('show'), scheduleId: id }).strict(),
  z
    .object({
      action: z.literal('create'),
      scheduleId: id,
      requestId: id,
      draft: ScheduleDraftSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('edit'),
      scheduleId: id,
      requestId: id,
      draft: ScheduleDraftSchema,
    })
    .strict(),
  z.object({ action: z.literal('pause'), scheduleId: id, requestId: id }).strict(),
  z.object({ action: z.literal('resume'), scheduleId: id, requestId: id }).strict(),
  z.object({ action: z.literal('run'), scheduleId: id, requestId: id }).strict(),
  z.object({ action: z.literal('delete'), scheduleId: id }).strict(),
  z
    .object({
      action: z.literal('propose'),
      requestId: id,
      title: z.string().trim().min(1).max(200),
      prompt: z.string().min(1).max(32768),
      trigger: ScheduleTriggerSchema,
    })
    .strict(),
]);
export type ScheduleCommand = z.infer<typeof ScheduleCommandSchema>;
export const LOCAL_SCHEDULE_CONTROL_PATH = '/schedule-control';
export const ScheduleControlRequestSchema = z
  .object({
    machineId: z.string().min(1),
    workspaceId: z.string().min(1),
    requesterSessionId: z.string().min(1).optional(),
    command: ScheduleCommandSchema,
  })
  .strict();
export type ScheduleControlRequest = z.infer<typeof ScheduleControlRequestSchema>;
export const ScheduleControlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type ScheduleControlResponse = z.infer<typeof ScheduleControlResponseSchema>;
