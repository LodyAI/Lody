import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SessionMeta } from '@lody/shared';

export const DiscoveryPageShape = {
  query: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(2048).optional(),
};
export const DiscoveryQuerySchema = z
  .object({
    ...DiscoveryPageShape,
    machineId: z.string().trim().min(1).optional(),
    kind: z.enum(['local', 'github']).optional(),
    onlineStatus: z.enum(['online', 'offline', 'unknown']).optional(),
  })
  .strict();
export type DiscoveryQuery = z.input<typeof DiscoveryQuerySchema>;
const pageKeys = { query: true, limit: true, cursor: true } as const;
const machineScopedListSchema = DiscoveryQuerySchema.pick({ ...pageKeys, machineId: true });
export const ResourceListSchemas = {
  machine: DiscoveryQuerySchema.pick({ ...pageKeys, onlineStatus: true }),
  project: DiscoveryQuerySchema.pick({ ...pageKeys, machineId: true, kind: true }),
  agent_config: machineScopedListSchema,
  agent_role: machineScopedListSchema,
  mcp: DiscoveryQuerySchema.pick(pageKeys),
};
export type DiscoveryPage<T> = { items: T[]; hasMore: boolean; nextCursor?: string };

export function discoveryCursor(input: DiscoveryQuery, scope: string) {
  const { cursor, limit, ...filters } = DiscoveryQuerySchema.parse(input);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([scope, filters]))
    .digest('hex');
  let after: string | undefined;
  if (cursor) {
    try {
      const decoded = z
        .object({ v: z.literal(1), fingerprint: z.literal(fingerprint), after: z.string() })
        .strict()
        .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      after = decoded.after;
    } catch {
      throw new Error(
        'CURSOR_INVALID: cursor is malformed or belongs to different filters or scope.'
      );
    }
  }
  return {
    after,
    limit,
    encode: (key: string) =>
      Buffer.from(JSON.stringify({ v: 1, fingerprint, after: key })).toString('base64url'),
  };
}

/** Keyset cursors are bound to the resource, authorization scope and filters. */
export function discoveryPage<T>(
  rows: readonly T[],
  input: DiscoveryQuery,
  scope: string,
  key: (row: T) => string
): DiscoveryPage<T> {
  const { after, limit, encode } = discoveryCursor(input, scope);
  const candidates = [...rows]
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .filter((row) => after === undefined || key(row) > after);
  const items = candidates.slice(0, limit);
  const last = items.at(-1);
  const hasMore = candidates.length > limit;
  return { items, hasMore, ...(hasMore && last ? { nextCursor: encode(key(last)) } : {}) };
}

export const matchesDiscoveryQuery = (
  query: string | undefined,
  ...values: Array<string | undefined>
): boolean => !query || values.some((value) => value?.toLowerCase().includes(query.toLowerCase()));

export const SessionDiscoveryFilterShape = {
  query: DiscoveryPageShape.query,
  machineId: z.string().trim().min(1).optional(),
  agentConfigId: z.string().trim().min(1).optional(),
  agentRoleId: z.string().trim().min(1).optional(),
};
export type SessionDiscoveryFilters = z.infer<z.ZodObject<typeof SessionDiscoveryFilterShape>>;
export function matchesSessionDiscovery(
  session: SessionMeta,
  filters: SessionDiscoveryFilters
): boolean {
  return (
    matchesDiscoveryQuery(filters.query, session.title, session.id) &&
    (!filters.machineId || session.machineId === filters.machineId) &&
    (!filters.agentConfigId || session.agentConfigId === filters.agentConfigId) &&
    (!filters.agentRoleId || session.agentRoleId === filters.agentRoleId)
  );
}
