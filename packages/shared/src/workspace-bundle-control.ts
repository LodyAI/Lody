import { z } from 'zod';

/** Local daemon control for workspace bundles at an absolute path. */
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

/** What a bundle room is to a person; the CLI planner assigns it from the codec. */
export const BUNDLE_KINDS = [
  'conversations',
  'schedules',
  'previewComments',
  'catalog',
  'machines',
  'other',
] as const;
export type BundleKind = (typeof BUNDLE_KINDS)[number];

export const BUNDLE_SKIP_REASONS = [
  'unrelated-same-id',
  'deleted-in-target',
  'machine-room',
  'unauthorized',
  'roost-exists',
] as const;
export type BundleSkipReason = (typeof BUNDLE_SKIP_REASONS)[number];

const BundleGapSchema = z.object({ id: z.string(), kind: z.string(), reason: z.string() });

export const WorkspaceBundleExportSummarySchema = z.object({
  file: z.string(),
  rooms: z.number(),
  blobs: z.number(),
  gaps: z.array(BundleGapSchema),
  digest: z.string(),
});
export type WorkspaceBundleExportSummary = z.infer<typeof WorkspaceBundleExportSummarySchema>;

/** The plan fields a person sees; the planner's full room record is a superset. */
export const WorkspaceBundlePlanSchema = z.object({
  digest: z.string(),
  sourceWorkspaceId: z.string(),
  targetWorkspaceId: z.string(),
  gaps: z.array(BundleGapSchema),
  rooms: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(BUNDLE_KINDS),
      counted: z.boolean(),
      action: z.enum(['merge', 'skip']),
      state: z.enum(['new', 'unchanged', 'merge']).optional(),
      reason: z.enum(BUNDLE_SKIP_REASONS).optional(),
      detail: z.string().optional(),
      label: z.string().optional(),
    })
  ),
});
export type WorkspaceBundlePlan = z.infer<typeof WorkspaceBundlePlanSchema>;

export const WorkspaceBundleImportOutcomeSchema = z.object({
  plan: WorkspaceBundlePlanSchema,
  result: z.object({ imported: z.number(), skipped: z.number(), resumed: z.number() }).optional(),
  uploadPending: z.array(z.string()),
});
export type WorkspaceBundleImportOutcome = z.infer<typeof WorkspaceBundleImportOutcomeSchema>;
