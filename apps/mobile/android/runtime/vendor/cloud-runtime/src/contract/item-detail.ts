import { z } from 'zod/v4';

export const ItemDetailParams = z
  .object({
    sessionId: z.string().min(1),
    entryId: z.string().min(1),
    itemId: z.string().min(1),
    cursor: z.string().optional(),
  })
  .meta({ id: 'ItemDetailParams' });

// The host folds a JSON null into an absent optional, so raw values that may
// legitimately be null travel boxed to keep null distinct from absent.
export const DetailValue = z
  .object({ value: z.unknown() })
  .meta({ id: 'DetailValue' });

export const ItemDetail = z
  .object({
    itemId: z.string(),
    rev: z.number().int(),
    blocks: z.array(z.unknown()),
    rawInput: DetailValue.optional(),
    rawOutput: DetailValue.optional(),
    options: z
      .array(
        z.object({
          optionId: z.string(),
          name: z.string(),
          kind: z.string().optional(),
        }),
      )
      .optional(),
    outcome: DetailValue.optional(),
    truncated: z.boolean(),
    nextCursor: z.string().optional(),
  })
  .meta({ id: 'ItemDetail' });
