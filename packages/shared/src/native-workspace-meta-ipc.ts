import { z } from 'zod';
import type { ExternalMetadataCommand, IncrementalExternalMetadataUpdate, JsonObject } from 'loro-repo';
import type { FlockRegisterEntry } from '@loro-dev/loro-repo-client';
import type { WorkspaceId } from './ids';
import { getWorkspaceFlockDocId } from './workspace-flock';
import { getScheduleRegistryFlockDocId } from './schedule-registry';
import { MACHINE_FLOCK_DOC_STREAM_SEGMENT } from './machine-flock';

/** Fixed named Flock documents the native mode owns in a workspace. */
export const nativeFlockDocIds = (workspaceId: string): string[] => [
  getWorkspaceFlockDocId(workspaceId as WorkspaceId),
  getScheduleRegistryFlockDocId(workspaceId as WorkspaceId),
];

/** Every owned named Flock document: the fixed ones plus each machine's Flock. */
export const isNativeFlockDocId = (workspaceId: string, flockDocId: string): boolean => {
  const machinePrefix = `${workspaceId}:${MACHINE_FLOCK_DOC_STREAM_SEGMENT}:`;
  return (
    nativeFlockDocIds(workspaceId).includes(flockDocId) ||
    (flockDocId.startsWith(machinePrefix) && flockDocId.length > machinePrefix.length)
  );
};

/** Owned ids among a legacy replica's documents, plus the fixed ones. */
export const ownedLegacyFlockDocIds = (workspaceId: string, stored: readonly string[]) => [
  ...new Set([
    ...nativeFlockDocIds(workspaceId),
    ...stored.filter((id) => isNativeFlockDocId(workspaceId, id)),
  ]),
];

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
const MAX_COMMIT_BYTES = 8 * 1024 * 1024;
export const NativeFlockOpenSchema = Workspace.extend({
  flockDocId: Id,
  observationId: Observation,
}).strict();
export const NativeFlockCommitSchema = Workspace.extend({
  flockDocId: Id,
  payloads: z
    .array(z.instanceof(Uint8Array))
    .min(1)
    .max(64)
    .refine(
      (payloads) => payloads.reduce((total, bytes) => total + bytes.byteLength, 0) <= MAX_COMMIT_BYTES,
      'payloads too large'
    ),
}).strict();

/** One-time import of this renderer's frozen legacy replica (Flock JSON export). */
export const NativeMetaImportSchema = Workspace.extend({
  /** An owned named Flock document; Workspace Meta when absent. */
  flockDocId: Id.optional(),
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

/** Register view of one owned named Flock document. */
export type NativeFlockEvent = {
  observationId: string;
  event:
    | { kind: 'snapshot'; file: Uint8Array }
    | { kind: 'changes'; registers: FlockRegisterEntry[] }
    | { kind: 'invalidated' };
};
export const NATIVE_FLOCK_CHANNEL = 'nativeWorkspaceMeta.flock' as const;
