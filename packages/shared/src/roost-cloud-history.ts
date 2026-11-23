import { z } from 'zod';
import type { SessionId, WorkspaceId } from './ids';

/** Keep exact-session grants outside the general workspace-token bucket. */
export const ROOST_HISTORY_BUCKET_ID = 'lody-rh';

export const roostCloudHistoryBindingSchema = z.object({
  generation: z.union([z.literal('root'), z.uuid()]),
  ownerPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export type RoostCloudHistoryBinding = z.infer<typeof roostCloudHistoryBindingSchema>;

export const roostCloudHistoryAuthoritySchema = z
  .object({
    rootSessionId: z.string().min(1).max(512),
    sessionOwnerUserId: z.string().min(1).max(512).optional(),
    localProjectId: z.string().min(1).max(512).optional(),
  })
  .strict();

export type RoostCloudHistoryAuthority = z.infer<typeof roostCloudHistoryAuthoritySchema>;

export const roostCloudHistoryGrantSchema = z.object({
  binding: roostCloudHistoryBindingSchema,
  streamUrl: z.url(),
  token: z.string().min(1),
  expiresIn: z.number().int().positive(),
});

export type RoostCloudHistoryGrant = z.infer<typeof roostCloudHistoryGrantSchema>;
export type RoostCloudHistoryTarget = {
  workspaceId: WorkspaceId;
  machineId: string;
  sessionId: SessionId;
};

export function roostCloudHistoryBinding(meta: Record<string, unknown> | undefined) {
  return roostCloudHistoryBindingSchema.safeParse({
    generation: meta?.roostCloudGeneration,
    ownerPublicKey: meta?.roostCloudAuthor,
  }).data;
}

export function roostHistoryAuthorKey(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function roostHistorySourceId(
  sessionId: SessionId,
  generation: RoostCloudHistoryBinding['generation']
): string {
  const root = `lody-session:${sessionId}`;
  return generation === 'root' ? root : `${root}:generation:${generation}`;
}

/** The machine owner and session are part of the exact Streams authorization. */
export function roostCloudHistoryStreamId(
  workspaceId: WorkspaceId,
  machineId: string,
  sessionId: SessionId,
  binding: RoostCloudHistoryBinding
): string {
  return `${workspaceId}:rh:${encodeURIComponent(machineId)}:${encodeURIComponent(sessionId)}:${binding.ownerPublicKey}:${binding.generation}`;
}
