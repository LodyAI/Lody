import { z } from 'zod';
import { pluginIdSchema } from './manifest-schema';
export const pluginProposalActions = [
  'propose_install',
  'propose_enable',
  'propose_reload',
] as const;
export const pluginProposalInput = z.strictObject({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  packagePath: z.string().min(1).max(1024),
});
export const pluginProposalCommand = pluginProposalInput.extend({
  action: z.enum(pluginProposalActions),
});
export const pluginArtifactSummary = z.strictObject({
  pluginId: pluginIdSchema,
  title: z.string().max(256),
  version: z.string().max(128),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  requestedCapabilities: z.array(z.string().max(100)).max(32),
});
export const pluginProposalMetaSchema = z.strictObject({
  command: pluginProposalCommand,
  workspaceId: z.string().min(1),
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
  requesterUserId: z.string().min(1),
  artifact: pluginArtifactSummary,
  expiresAt: z.number().int(),
  status: z.enum(['pending', 'approved', 'rejected', 'superseded']),
});
export type PluginProposalMeta = z.infer<typeof pluginProposalMetaSchema>;
export type PluginProposalCommand = z.infer<typeof pluginProposalCommand>;
export function pluginProposalState(meta: PluginProposalMeta, now: number, digest?: string) {
  if (meta.status !== 'pending') return meta.status;
  if (now >= meta.expiresAt) return 'expired';
  return digest !== undefined && digest !== meta.artifact.sha256 ? 'superseded' : 'pending';
}
export const pluginDecisionParams = z.strictObject({
  sessionId: z.string().min(1).max(256),
  requestId: pluginProposalInput.shape.requestId,
  sha256: pluginArtifactSummary.shape.sha256,
  decision: z.enum(['approve', 'deny']),
});
export const pluginDecisionResult = z.strictObject({
  type: z.literal('plugin/control'),
  action: z.literal('resolve-proposal'),
  status: z.enum(['approved', 'rejected', 'expired', 'superseded']),
});
