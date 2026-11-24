import { canonicalIntentJson, E2EE_INTENT_KIND } from '../e2ee-execution-intent';
import { sha256Hex } from '../incremental-sha256';
import { z } from 'zod';
import { pluginManifestSchema, pluginIdSchema } from './manifest-schema';
export const syncChallengeSchema = z.strictObject({
  owner: z.string().min(1),
  plugin: z.string().min(1),
  machine: z.string().min(1),
  nonce: z.uuid(),
  decision: z.string().min(1).max(256),
  confirmedAt: z.number().int().positive().optional(),
  confirmation: z.string().max(256).optional(),
});
export type PluginSyncChallenge = z.infer<typeof syncChallengeSchema>;
export const workspacePluginEntrySchema = z
  .strictObject({
    plugin_id: pluginIdSchema,
    source: z.strictObject({
      kind: z.literal('npm'),
      package_name: z
        .string()
        .max(214)
        .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
      exact_version: pluginManifestSchema.shape.version,
      integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
    }),
    client_digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    manifest_summary: pluginManifestSchema,
    permissions: pluginManifestSchema.shape.permissions.unwrap(),
    config_schema: pluginManifestSchema.shape.config.unwrap(),
    enabled: z.boolean(),
    machine_sync: z.enum(['manual', 'owner_machines']),
    sync_owner_user_id: z.string().min(1).optional(),
    sync_confirmed_at: z.number().int().positive().optional(),
    sync_challenge: syncChallengeSchema.omit({ confirmation: true, confirmedAt: true }).optional(),
    sync_decision_id: z.uuid().optional(),
    sync_signature: z.string().min(1).optional(),
  })
  .refine(
    (r) =>
      r.plugin_id === r.manifest_summary.id &&
      r.source.exact_version === r.manifest_summary.version &&
      JSON.stringify(r.permissions) === JSON.stringify(r.manifest_summary.permissions ?? []) &&
      JSON.stringify(r.config_schema) === JSON.stringify(r.manifest_summary.config ?? {}),
    'Workspace disclosure does not match manifest'
  );
export type WorkspacePluginEntry = z.infer<typeof workspacePluginEntrySchema>;

export function pluginOwnerSyncSubject(raw: WorkspacePluginEntry) {
  const { sync_signature: _, ...entry } = workspacePluginEntrySchema.parse(raw);
  if (
    !entry.sync_decision_id ||
    !entry.sync_owner_user_id ||
    (entry.machine_sync === 'owner_machines' && !entry.enabled) ||
    (entry.sync_challenge &&
      (entry.machine_sync !== 'owner_machines' ||
        entry.sync_challenge.owner !== entry.sync_owner_user_id ||
        entry.sync_challenge.plugin !== entry.plugin_id))
  )
    throw Error('Explicit owner sync authorization required');
  return {
    kind: E2EE_INTENT_KIND.pluginOwnerSync,
    targetMachineId: entry.sync_challenge?.machine ?? '',
    scope: entry.plugin_id,
    messageId: entry.sync_owner_user_id,
    contentDigest: sha256Hex(new TextEncoder().encode(canonicalIntentJson(entry))),
  };
}

export const pluginInstallationSource = z.discriminatedUnion('kind', [
  workspacePluginEntrySchema.shape.source,
  z.strictObject({ kind: z.literal('local'), origin: z.enum(['dir', 'dev', 'archive', 'github']) }),
]);
export type PluginInstallationSource = z.infer<typeof pluginInstallationSource>;
