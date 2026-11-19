import { z } from 'zod';

/**
 * Local daemon control for workspace bundles (specs/workspace-export-import.md).
 * On the local platform the daemon owns the only replica, so the CLI and desktop
 * ask it to read or write a bundle at an absolute path chosen by the same user.
 */
export const LOCAL_WORKSPACE_BUNDLE_PATH = '/workspace-bundle';

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'),
    {
      message: 'Path must be absolute',
    }
  );

export const WorkspaceBundleControlRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('export'),
      machineId: z.string().min(1),
      workspaceId: z.string().min(1),
      out: AbsolutePathSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('import'),
      machineId: z.string().min(1),
      workspaceId: z.string().min(1),
      file: AbsolutePathSchema,
      dryRun: z.boolean().optional(),
    })
    .strict(),
]);
export type WorkspaceBundleControlRequest = z.infer<typeof WorkspaceBundleControlRequestSchema>;

export const WorkspaceBundleControlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type WorkspaceBundleControlResponse = z.infer<typeof WorkspaceBundleControlResponseSchema>;
