import { z } from 'zod';
import type {
  ExternalMetadataCommand,
  IncrementalExternalMetadataUpdate,
  JsonObject,
} from 'loro-repo';
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

const hasPrefix = (docId: string, prefix: string) =>
  docId.startsWith(prefix) && docId.length > prefix.length;
/** Session documents (`session-*`): read and patched remotely, never held by a renderer. */
export const isNativeSessionDocId = (docId: string): boolean => hasPrefix(docId, 'session-');
/** Schedule documents (`schedule-*`): small, so every process keeps a replica. */
export const isNativeScheduleDocId = (docId: string): boolean => hasPrefix(docId, 'schedule-');
/** Loro documents the native mode owns. */
export const isNativeDocId = (docId: string): boolean =>
  isNativeSessionDocId(docId) || isNativeScheduleDocId(docId);

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
      (payloads) =>
        payloads.reduce((total, bytes) => total + bytes.byteLength, 0) <= MAX_COMMIT_BYTES,
      'payloads too large'
    ),
}).strict();

const MAX_DOC_COMMIT_BYTES = 64 * 1024 * 1024;
const DocTarget = Workspace.extend({ docId: Id.refine(isNativeDocId, 'not an owned document') });
/** Remote reads and patches serve only Session documents. */
const SessionDocTarget = Workspace.extend({
  docId: Id.refine(isNativeSessionDocId, 'not a Session document'),
});
const LoroVersion = z
  .record(z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative())
  .refine((version) => Object.keys(version).length <= 4096, 'too many peers');
export const NativeDocOpenSchema = DocTarget.extend({
  observationId: Observation,
  /** The replica's retained version: the first load sends only newer ops. */
  since: LoroVersion.optional(),
}).strict();
export const NativeDocCommitSchema = DocTarget.extend({
  updates: z
    .array(z.instanceof(Uint8Array))
    .min(1)
    .max(64)
    .refine(
      (updates) =>
        updates.reduce((total, bytes) => total + bytes.byteLength, 0) <= MAX_DOC_COMMIT_BYTES,
      'updates too large'
    ),
}).strict();
const RendererSource = z.string().regex(/^renderer:[\w.-]{1,128}$/);
export const NativeDocLegacyCheckSchema = DocTarget.extend({ source: RendererSource }).strict();
/** One-time import of this renderer's replica of one document (snapshot + version). */
export const NativeDocLegacySchema = DocTarget.extend({
  source: RendererSource,
  snapshot: z.instanceof(Uint8Array),
  version: LoroVersion,
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

/** Update view of one owned Loro document. */
export type NativeDocEvent = {
  observationId: string;
  event:
    | { kind: 'snapshot'; file: Uint8Array; delta: boolean }
    | { kind: 'changes'; updates: Uint8Array[] }
    | { kind: 'invalidated' };
};
export const NATIVE_DOC_CHANNEL = 'nativeWorkspaceMeta.doc' as const;

// ---------------------------------------------------------------------------
// Remote Session documents: the renderer holds no replica. It reads bounded
// paths and list fields, observes changed paths, and commits JSON patches that
// main checks before the engine applies them.

const PathSeg = z.union([z.string().max(256), z.number().int().nonnegative()]);
const DocPath = z.array(PathSeg).max(32);
export const NativeDocReadSchema = SessionDocTarget.extend({ path: DocPath }).strict();
export const NativeDocListFieldsSchema = SessionDocTarget.extend({
  start: z.number().int(),
  end: z.number().int().optional(),
  fields: z.array(z.object({ path: DocPath, shape: z.boolean().optional() }).strict()).max(64),
}).strict();
export const NativeDocObservePathsSchema = SessionDocTarget.extend({
  observationId: Observation,
}).strict();
const PatchOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: DocPath, value: z.unknown() }).strict(),
  z.object({ op: z.literal('unset'), path: DocPath }).strict(),
  z
    .object({
      op: z.literal('arr_splice'),
      path: DocPath,
      at: z.number().int().nonnegative(),
      del: z.number().int().nonnegative(),
      items: z.array(z.unknown()).max(64),
    })
    .strict(),
  z.object({ op: z.literal('move'), from: DocPath, to: DocPath }).strict(),
]);
export const NativeDocPatchSchema = SessionDocTarget.extend({
  ops: z.array(PatchOp).min(1).max(256),
  precondition: z.union([
    z
      .object({ mode: z.literal('rebase'), base_room_tx_id: z.number().int().nonnegative() })
      .strict(),
    z
      .object({ mode: z.literal('cas'), expected_room_tx_id: z.number().int().nonnegative() })
      .strict(),
  ]),
}).strict();
export type NativeDocPatchOp = z.infer<typeof PatchOp>;

/** Changed paths of one remote Session document (`reset`: re-read what is held). */
export type NativeDocPathsEvent = {
  observationId: string;
  event:
    | { kind: 'reset' }
    | {
        kind: 'changes';
        changes: {
          path: (string | number)[];
          kind: string;
          ops?: ({ retain: number } | { insert: number } | { delete: number })[];
          keys?: string[];
        }[];
      };
};
export const NATIVE_DOC_PATHS_CHANNEL = 'nativeWorkspaceMeta.docPaths' as const;

/** Roots a renderer may write: user input history and the queue/receipt/stop roots. */
const WRITABLE_ROOTS = new Set(['history', 'mq', 'humanInputReceipts', 'cancelRequest']);

/**
 * Checks a renderer patch before it reaches the engine: only writable roots,
 * and a human-input receipt only for the current user, never removed or
 * reassigned (receipts authorize execution of human input).
 */
export function authorizeSessionPatch(ops: readonly NativeDocPatchOp[], userId: string): void {
  const deny = (reason: string): never => {
    throw new Error(`native_doc_patch_denied:${reason}`);
  };
  const isMine = (value: unknown) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { userId?: unknown }).userId === userId &&
    Object.keys(value).length === 1;
  for (const op of ops) {
    const paths = op.op === 'move' ? [op.from, op.to] : [op.path];
    for (const path of paths) if (!WRITABLE_ROOTS.has(String(path[0]))) deny('root');
    if (paths.some((path) => path[0] !== 'humanInputReceipts')) continue;
    if (op.op !== 'set') deny('receipt_op');
    const { path, value } = op as { path: (string | number)[]; value: unknown };
    if (path.length === 1) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) deny('receipt');
      if (!Object.values(value as object).every(isMine)) deny('receipt_user');
    } else if (path.length === 2) {
      if (!isMine(value)) deny('receipt_user');
    } else if (path.length === 3 && path[2] === 'userId') {
      if (value !== userId) deny('receipt_user');
    } else deny('receipt_path');
  }
}
