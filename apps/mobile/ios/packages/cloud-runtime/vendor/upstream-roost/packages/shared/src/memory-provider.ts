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
    name: z.string().trim().min(1).max(200),
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
      action: z.enum(['create', 'update']),
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
  role: z.string().optional(),
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
    createFields: ['name', 'id', 'description', 'role'],
  },
] as const;

/** Lody's machine-scoped association; the provider continues to own memory contents. */
export const MemoryAssociationSchema = MemoryBindingSchema.extend({
  machineId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
}).strict();
export type MemoryAssociation = z.infer<typeof MemoryAssociationSchema>;

/** Only a successful authoritative inventory can establish that an identity was deleted. */
export function isMemoryIdentityMissing(
  binding: MemoryBinding,
  inventory: MemoryProviderResponse | undefined
): boolean {
  return (
    inventory?.status === 'ready' &&
    !inventory.memories.some((entry) => entry.id === binding.memoryId)
  );
}
