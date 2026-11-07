import { z } from 'zod/v4';

export const Empty = z.object({}).meta({ id: 'Empty' });

export const HelloParams = z
  .object({
    protocol: z.number().int(),
    gen: z.number().int().positive(),
  })
  .meta({ id: 'HelloParams' });

export const HelloResult = z
  .object({
    protocol: z.number().int(),
    methods: z.array(z.string()),
  })
  .meta({ id: 'HelloResult' });

export const EnsureSessionParams = z
  .object({ sessionId: z.string().min(1) })
  .meta({ id: 'EnsureSessionParams' });

export const Grant = z
  .object({
    token: z.string().min(1),
    gatewayBaseUrl: z.string().min(1),
    expiresIn: z.number().positive(),
    shardHostSuffix: z.string().optional(),
  })
  .meta({ id: 'Grant' });
export type Grant = z.infer<typeof Grant>;

export const CatalogEvent = z
  .object({
    catalog: z.string(),
    revision: z.number().int().nonnegative(),
  })
  .meta({ id: 'CatalogEvent' });
