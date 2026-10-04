import { z } from 'zod';

/** Only identity references cross Lody's catalog/turn boundary; never memory contents. */
export const MemoryBindingSchema = z
  .object({
    providerId: z.string().trim().min(1).max(100),
    memoryId: z.string().trim().min(1).max(200),
  })
  .strict();
export type MemoryBinding = z.infer<typeof MemoryBindingSchema>;

export const MemoryCreateInputSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    name: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    role: z.string().max(200).optional(),
    defaultSpace: z.string().max(200).optional(),
  })
  .strict();
export type MemoryCreateInput = z.infer<typeof MemoryCreateInputSchema>;
export const MemoryProviderRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), providerId: z.string().min(1).max(100) }).strict(),
  z
    .object({
      action: z.literal('create'),
      providerId: z.string().min(1).max(100),
      input: MemoryCreateInputSchema,
    })
    .strict(),
]);
export type MemoryProviderRequest = z.infer<typeof MemoryProviderRequestSchema>;
export const MemoryIdentitySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
});
export type MemoryIdentity = z.infer<typeof MemoryIdentitySchema>;
export const MemoryProviderResponseSchema = z
  .object({
    type: z.literal('machine/memory'),
    status: z.enum(['ready', 'not_installed', 'not_running', 'error']),
    memories: z.array(MemoryIdentitySchema),
    error: z.string().optional(),
  })
  .strict();
export type MemoryProviderResponse = z.infer<typeof MemoryProviderResponseSchema>;

/** UI metadata only. Commands and environment mapping belong to the daemon adapter. */
export const MEMORY_PROVIDERS = [
  {
    id: 'nowledge-mem',
    name: 'Nowledge Mem',
    installUrl: 'https://mem.nowledge.co/en',
    createFields: ['id', 'name', 'description', 'role', 'defaultSpace'],
  },
] as const;
