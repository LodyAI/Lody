import { z } from 'zod/v4';

export const PROTOCOL_VERSION = 1;

export const RuntimeError = z
  .object({
    code: z.string().min(1),
    retryable: z.boolean(),
    detail: z.string().optional(),
  })
  .meta({ id: 'RuntimeError' });
export type RuntimeError = z.infer<typeof RuntimeError>;

const header = {
  v: z.literal(PROTOCOL_VERSION),
  gen: z.number().int().nonnegative(),
  method: z.string().min(1),
};

export const Envelope = z.discriminatedUnion('kind', [
  z.object({
    ...header,
    kind: z.literal('request'),
    id: z.string().min(1),
    payload: z.unknown(),
  }),
  z.object({
    ...header,
    kind: z.literal('result'),
    id: z.string().min(1),
    payload: z.unknown(),
  }),
  z.object({
    ...header,
    kind: z.literal('error'),
    id: z.string().min(1),
    error: RuntimeError,
  }),
  z.object({ ...header, kind: z.literal('event'), payload: z.unknown() }),
]);
export type Envelope = z.infer<typeof Envelope>;
