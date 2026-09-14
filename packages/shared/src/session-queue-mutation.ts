import { z } from 'zod';
import { SessionIdSchema } from './message-schemas';

const id = z.string().trim().min(1);
export const SessionQueueMutationSchema = z
  .object({
    sessionId: SessionIdSchema,
    mutation: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('update'),
          queueItemId: id,
          expectedRevision: id,
          patch: z.record(z.string(), z.unknown()),
        })
        .strict(),
      z.object({ kind: z.literal('remove'), queueItemId: id, expectedRevision: id }).strict(),
      z
        .object({
          kind: z.literal('reorder'),
          orderedItemIds: z.array(id),
          expectedItemIds: z.array(id),
        })
        .strict(),
    ]),
  })
  .strict();

export const SessionQueueMutationResponseSchema = z
  .object({
    type: z.literal('session/queue-mutate_response'),
    success: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export type SessionQueueMutation = z.infer<typeof SessionQueueMutationSchema>;
export type SessionQueueMutationResponse = z.infer<typeof SessionQueueMutationResponseSchema>;

/** Canonical JSON identity for compare-and-update across independent replicas. */
export function queueItemRevision(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      );
    }
    return item;
  });
}
