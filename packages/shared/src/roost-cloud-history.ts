import { z } from 'zod';
import type { SessionId, WorkspaceId } from './ids';

/** Keep exact-session grants outside the general workspace-token bucket. */
export const ROOST_HISTORY_BUCKET_ID = 'lody-rh';

export const roostCloudHistoryBindingSchema = z.object({
  generation: z.union([z.literal('root'), z.uuid()]),
  ownerPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export type RoostCloudHistoryBinding = z.infer<typeof roostCloudHistoryBindingSchema>;

export const roostCloudHistoryGrantSchema = z.object({
  binding: roostCloudHistoryBindingSchema,
  streamUrl: z.url(),
  token: z.string().min(1),
  expiresIn: z.number().int().positive(),
});

export type RoostCloudHistoryGrant = z.infer<typeof roostCloudHistoryGrantSchema>;

export const roostCloudHistoryReadResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending') }).strict(),
  z.object({ state: z.literal('owner-required') }).strict(),
  roostCloudHistoryGrantSchema.extend({
    state: z.literal('published'),
    newerVersionPending: z.boolean(),
  }),
]);

export type RoostCloudHistoryReadResult = z.infer<typeof roostCloudHistoryReadResultSchema>;

export type RoostCloudSyncState = {
  phase:
    | 'idle'
    | 'checking'
    | 'pending'
    | 'owner-required'
    | 'syncing'
    | 'ready'
    | 'retrying'
    | 'refused';
  httpStatus?: number;
  newerVersionPending?: boolean;
};

export type RoostHistorySyncState = RoostCloudSyncState & { source: 'machine' | 'streams' };

export class RoostCloudHistoryPendingError extends Error {
  constructor() {
    super('Roost history publication is pending');
    this.name = 'RoostCloudHistoryPendingError';
  }
}

export class RoostCloudHistoryRequestError extends Error {
  constructor(readonly status: number) {
    super(`Roost history request failed (HTTP ${status})`);
    this.name = 'RoostCloudHistoryRequestError';
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 409 || this.status === 429;
  }
}

export class RoostCloudHistoryTransportError extends Error {
  constructor(options?: ErrorOptions) {
    super('Roost history transport is unavailable', options);
    this.name = 'RoostCloudHistoryTransportError';
  }
}

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
