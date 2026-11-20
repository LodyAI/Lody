import { z } from 'zod';
import type { ExternalMetadataCommand, IncrementalExternalMetadataUpdate, JsonObject } from 'loro-repo';

/** Renderer ↔ main contract for native Workspace Meta. No raw engine access. */
const Id = z.string().min(1).max(512);
const Workspace = z.object({ workspaceId: Id }).strict();
const Observation = z.string().uuid();

const JsonPatch = z
  .record(z.string().max(256), z.unknown())
  .refine((patch) => Object.keys(patch).length <= 256, 'too many fields');

export const NativeMetaCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upsert-doc'), docId: Id, patch: JsonPatch }).strict(),
  z
    .object({
      kind: z.enum(['ensure-doc', 'delete-doc', 'restore-doc', 'purge-doc']),
      docId: Id,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ensure-flock'),
      flockDocId: Id,
      expiresAtMs: z.number().finite().nonnegative().optional(),
    })
    .strict(),
  z
    .object({ kind: z.enum(['delete-flock', 'restore-flock', 'purge-flock']), flockDocId: Id })
    .strict(),
]);

export const NativeMetaOpenSchema = Workspace.extend({ observationId: Observation }).strict();
export const NativeMetaReleaseSchema = z.object({ observationId: Observation }).strict();
export const NativeMetaCommitSchema = Workspace.extend({
  command: NativeMetaCommandSchema,
}).strict();
/** One-time import of this renderer's frozen legacy replica (Flock JSON export). */
export const NativeMetaImportSchema = Workspace.extend({
  source: z.string().regex(/^renderer:[\w.-]{1,128}$/),
  bundle: z
    .object({
      version: z.number(),
      entries: z.record(z.string(), z.object({ c: z.string(), d: z.unknown().optional() })),
    })
    .passthrough(),
}).strict();

export type NativeMetaCommand = ExternalMetadataCommand<JsonObject>;
export type NativeMetaEvent = {
  observationId: string;
  update: IncrementalExternalMetadataUpdate<JsonObject>;
};
export const NATIVE_META_CHANNEL = 'nativeWorkspaceMeta.update' as const;
