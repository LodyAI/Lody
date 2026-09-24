import { z } from 'zod';

export const PiExtensionDiscoverySchema = z
  .object({
    version: z.literal(1),
    agentDir: z.string().max(4096),
    extensions: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            name: z.string().max(4096),
            source: z.enum(['package', 'settings', 'directory']),
          })
          .strict()
      )
      .max(256),
    warnings: z.array(z.string().max(4096)).max(32),
  })
  .strict();
export type PiExtensionDiscovery = z.infer<typeof PiExtensionDiscoverySchema>;

export const MachinePiExtensionsResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), discovery: PiExtensionDiscoverySchema }).strict(),
  z.object({ success: z.literal(false), error: z.string() }).strict(),
]);
export type MachinePiExtensionsResponse = z.infer<typeof MachinePiExtensionsResponseSchema>;
