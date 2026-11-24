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
