import { z } from 'zod';

const opened = z.strictObject({ includeOpenedSessions: z.boolean().optional() });
export const sessionCommandInputs = {
  sessionSetPinned: z.strictObject({ pinned: z.boolean() }),
  sessionSettle: opened.optional(),
  sessionMoveToFocus: opened.optional(),
  sessionSnooze: opened.extend({ until: z.number().finite() }),
  sessionUpdateTitle: z.strictObject({ title: z.string() }),
  sessionMarkRead: z.undefined(),
  sessionMarkUnread: z.undefined(),
  sessionMoveOrder: z.strictObject({
    to: z.discriminatedUnion('area', [
      z.strictObject({ area: z.literal('focus') }),
      z.strictObject({ area: z.literal('pinned'), sectionId: z.string().nullable() }),
    ]),
    beforeSessionId: z.string().nullable(),
  }),
};

export const lifecycleCommandInputs = {
  sessionFork: z.strictObject({ fromTurnId: z.string().min(1).optional() }).optional(),
  sessionArchive: z.undefined(),
  sessionRestore: z.undefined(),
  sessionStop: z.undefined(),
  sessionRespondInteraction: z.strictObject({
    requestId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    outcome: z.discriminatedUnion('outcome', [
      z.strictObject({
        outcome: z.literal('cancelled'),
        _meta: z.record(z.string(), z.json()).nullable().optional(),
      }),
      z.strictObject({
        outcome: z.literal('selected'),
        optionId: z.string().min(1),
        _meta: z.record(z.string(), z.json()).nullable().optional(),
      }),
    ]),
  }),
  sessionSend: z.strictObject({
    prompt: z.string().min(1),
    delivery: z.enum(['queue', 'steer']).optional(),
    attachments: z.tuple([]).optional(),
  }),
};
export const scheduleCommandInputs = {
  scheduleSetEnabled: z.strictObject({ scheduleId: z.string().min(1), enabled: z.boolean() }),
  scheduleRunNow: z.strictObject({ scheduleId: z.string().min(1) }),
};
