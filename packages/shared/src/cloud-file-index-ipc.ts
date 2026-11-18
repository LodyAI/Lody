import { z } from 'zod';
import { LocalNativeFileIndexStateSchema } from './local-loro-data-plane';

export const cloudFileIndexErrorCodeSchema = z.enum([
  'invalid_request',
  'access_denied',
  'restart_required',
  'unavailable',
  'cleanup_unconfirmed',
]);
export type CloudFileIndexErrorCode = z.infer<typeof cloudFileIndexErrorCodeSchema>;
export class CloudFileIndexIpcError extends Error {
  constructor(readonly code: CloudFileIndexErrorCode = 'unavailable') {
    super(`cloud_file_index_${code}`);
    this.name = 'CloudFileIndexIpcError';
  }
}
const id = z.string().min(1).max(512);
export const cloudFileIndexRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    workspaceId: id,
    ownerSessionId: id,
  })
  .strict();
export const cloudFileIndexReleaseSchema = cloudFileIndexRequestSchema
  .extend({
    leaseId: z.string().uuid(),
    generation: id,
  })
  .strict();
export const cloudFileIndexObservedSchema = z.discriminatedUnion('backend', [
  z.object({ backend: z.literal('legacy') }).strict(),
  cloudFileIndexReleaseSchema.extend({ backend: z.literal('native'), workspaceId: id }).strict(),
]);
const stateSchema = z.union([
  LocalNativeFileIndexStateSchema.options[0],
  LocalNativeFileIndexStateSchema.options[1],
  z.object({ status: z.literal('error'), code: cloudFileIndexErrorCodeSchema }).strict(),
]);
export const cloudFileIndexEventSchema = cloudFileIndexReleaseSchema
  .extend({
    workspaceId: id,
    state: stateSchema,
  })
  .strict();
export type CloudFileIndexRequest = z.infer<typeof cloudFileIndexRequestSchema>;
export type CloudFileIndexRelease = z.infer<typeof cloudFileIndexReleaseSchema>;
export type CloudFileIndexObserved = z.infer<typeof cloudFileIndexObservedSchema>;
export type CloudFileIndexEvent = z.infer<typeof cloudFileIndexEventSchema>;
/** Index snapshots are bounded projections, never content, credentials or raw SDK handles. */
export function parseCloudFileIndexInput<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024) throw new Error();
    return schema.parse(value);
  } catch {
    throw new CloudFileIndexIpcError('invalid_request');
  }
}

export const cloudFileIndexCanceledSchema = z.object({ canceled: z.literal(true) }).strict();
export const cloudFileIndexReleasedSchema = z.object({ released: z.literal(true) }).strict();
