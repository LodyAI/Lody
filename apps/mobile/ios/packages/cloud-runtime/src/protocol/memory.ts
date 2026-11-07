import { z } from 'zod';
// Official Lody memory-provider.ts: identities only; provider contents never cross this boundary.
export const memoryAssociation = z
  .object({
    machineId: z.string().min(1),
    providerId: z.string().trim().min(1).max(100),
    memoryId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
  })
  .strict();
export const memoryInventory = z
  .object({
    type: z.literal('machine/memory'),
    status: z.enum(['ready', 'not_installed', 'not_running', 'error']),
    memories: z
      .array(
        z.object({
          id: z.string().min(1).max(200),
          name: z.string().max(200),
          description: z.string().max(2000).optional(),
          role: z.string().max(200).optional(),
        }),
      )
      .max(10000),
    error: z.string().optional(),
  })
  .strict();
