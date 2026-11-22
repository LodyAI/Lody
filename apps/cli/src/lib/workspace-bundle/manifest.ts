import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Spec: specs/workspace-export-import.md, "Bundle format". */
export const BUNDLE_FORMAT = 'lody-workspace-bundle';
export const BUNDLE_VERSION = 1;
export const MANIFEST_PATH = 'manifest.json';
export const DEFAULT_CHUNK_SIZE = 64 * 1024 * 1024;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const RoomModelSchema = z.enum(['meta', 'flock', 'loro', 'roost']);
export type RoomModel = z.infer<typeof RoomModelSchema>;

export const ChunkSchema = z.object({
  path: z.string().min(1),
  sha256: sha256Hex,
  size: z.number().int().nonnegative(),
});

export const RoomEntrySchema = z.object({
  /** Source room id; never trusted as a target id without classification. */
  id: z.string().min(1).max(1024),
  model: RoomModelSchema,
  codec: z.string().min(1).max(64),
  encoding: z.string().min(1).max(64),
  sha256: sha256Hex,
  size: z.number().int().nonnegative(),
  chunks: z.array(ChunkSchema),
});
export type RoomEntry = z.infer<typeof RoomEntrySchema>;
export type RoomDescriptor = Pick<RoomEntry, 'id' | 'model' | 'codec' | 'encoding'>;

export const BlobEntrySchema = z.object({
  sha256: sha256Hex,
  size: z.number().int().nonnegative(),
  kind: z.string().min(1).max(32),
  /** Display information only. */
  name: z.string().max(1024).optional(),
  mime: z.string().max(256).optional(),
  /** Where the bytes are referenced, for example `session-file:<sessionId>/<fileId>`. */
  refs: z.array(z.string().min(1).max(1024)).optional(),
  path: z.string().min(1),
});
export type BlobEntry = z.infer<typeof BlobEntrySchema>;
export type BlobDescriptor = Pick<BlobEntry, 'kind' | 'name' | 'mime' | 'refs'>;

export const GapSchema = z.object({
  id: z.string().min(1).max(1024),
  kind: z.string().min(1).max(64),
  reason: z.string().min(1).max(1024),
});
export type BundleGap = z.infer<typeof GapSchema>;

export const BundleSourceSchema = z.object({
  workspaceId: z.string().min(1),
  exporterUserId: z.string().min(1),
  exporterMachineId: z.string().min(1),
  lodyVersion: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
});
export type BundleSource = z.infer<typeof BundleSourceSchema>;

const ManifestBodySchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  source: BundleSourceSchema,
  rooms: z.array(RoomEntrySchema),
  blobs: z.array(BlobEntrySchema),
  gaps: z.array(GapSchema),
});
export const BundleManifestSchema = ManifestBodySchema.extend({ digest: sha256Hex });
export type BundleManifest = z.infer<typeof BundleManifestSchema>;
type ManifestBody = z.infer<typeof ManifestBodySchema>;

export class BundleFormatError extends Error {
  override readonly name = 'BundleFormatError';
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Canonical JSON: object keys sorted, no whitespace; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function sealManifest(body: ManifestBody): BundleManifest {
  return { ...body, digest: sha256(canonicalJson(body)) };
}

export function parseManifest(text: string): BundleManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BundleFormatError('Bundle manifest is not valid JSON');
  }
  const probe = z.object({ format: z.unknown(), version: z.unknown() }).safeParse(raw);
  if (!probe.success || probe.data.format !== BUNDLE_FORMAT)
    throw new BundleFormatError('Not a Lody workspace bundle');
  if (probe.data.version !== BUNDLE_VERSION)
    throw new BundleFormatError(
      `Unsupported bundle version ${String(probe.data.version)}; this Lody reads version ${BUNDLE_VERSION}`
    );
  const parsed = BundleManifestSchema.safeParse(raw);
  if (!parsed.success) throw new BundleFormatError('Bundle manifest is malformed');
  const { digest, ...body } = parsed.data;
  if (sha256(canonicalJson(body)) !== digest)
    throw new BundleFormatError('Bundle manifest digest does not match its contents');
  return parsed.data;
}
