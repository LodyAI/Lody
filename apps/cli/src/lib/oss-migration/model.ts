import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LoroDoc } from 'loro-crdt';
import type { JsonObject } from 'loro-repo';
import { isSessionDocRoomId } from '@lody/shared';

export const safeId = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9_-]+$/);
export const jsonObject = z.record(z.string(), z.json());
export const catalogSchema = z.object({
  version: z.literal(1),
  identity: z.object({ userId: z.string().startsWith('local:') }),
  machine: z.object({ machineId: safeId }),
  workspaces: z.array(z.object({ workspaceId: safeId, state: z.string(), name: z.string() })),
});
export const rowSchema = z.object({
  key: z.array(z.union([z.string(), z.number()])),
  value: z.json(),
});
export const documentSchema = z.object({
  id: safeId,
  meta: jsonObject,
  sha256: z.string().length(64),
});
export const manifestSchema = z.object({
  version: z.literal(2),
  sourcePath: z.string(),
  sourceWorkspaceId: safeId,
  sourceMachineId: safeId,
  sourceUserId: z.string().startsWith('local:'),
  sourceName: z.string(),
  targetWorkspaceId: safeId,
  targetMachineId: safeId,
  targetUserId: z.string(),
  deployment: z.string(),
  migrationId: z.string().length(32),
  documents: z.array(documentSchema),
  flocks: z.array(z.object({ id: z.string(), rows: z.array(rowSchema) })),
  machineMeta: jsonObject,
  createdAt: z.string(),
});
export const journalSchema = z.object({
  version: z.literal(2),
  migrationId: z.string().length(32),
  prepared: z.record(z.string(), z.string()),
  reserved: z.array(z.string()),
  published: z.array(z.string()),
  attachments: z.record(z.string(), jsonObject),
  complete: z.boolean(),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type Journal = z.infer<typeof journalSchema>;
export type MigrationDocument = Manifest['documents'][number];
export type MigrationRow = z.infer<typeof rowSchema>;
export const hashBytes = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');
export const receiptRoot = 'ossMigration';

export function migratedMetadata(
  meta: JsonObject,
  manifest: Pick<Manifest, 'targetMachineId' | 'targetUserId' | 'migrationId'>
): JsonObject {
  const result: JsonObject = {
    ...meta,
    machineId: manifest.targetMachineId,
    userId: manifest.targetUserId,
  };
  for (const key of [
    'latestUserMsgId',
    'processingUserMsgId',
    'steerTurnStatuses',
    'steerOperationLedger',
    'queuePromotionLedger',
    'messageQueueUpdatedAt',
    'messageQueueUpdateVersion',
    'messageQueueCheckedAt',
    'awaitingUserSince',
    'previewConnection',
    'previewCandidate',
  ])
    delete result[key];
  return {
    ...result,
    status: { type: 'idle' },
    collaborationStopped: true,
    ossMigrationId: manifest.migrationId,
  };
}

/** Full-history import first; only execution control gets new migration-authored ops. */
export function prepareDocument(
  bytes: Uint8Array,
  entry: MigrationDocument,
  manifest: Manifest
): LoroDoc {
  const doc = new LoroDoc();
  doc.import(bytes);
  if (doc.isShallow()) throw new Error(`Cannot migrate shallow history: ${entry.id}`);
  if (isSessionDocRoomId(entry.id)) {
    if (entry.meta.historyBackend && entry.meta.historyBackend !== 'loro')
      throw new Error(
        `Unsupported history backend ${entry.meta.historyBackend}: ${entry.id}. No records were uploaded.`
      );
    const queue = doc.getMovableList('mq');
    if (queue.length) queue.delete(0, queue.length);
    const fork = doc.getMap('forkOperation');
    for (const key of fork.keys()) fork.delete(key);
  } else if (entry.id.startsWith('schedule-')) {
    const definition = doc.getMap('definition');
    definition.set('enabled', false);
    definition.set('machineId', manifest.targetMachineId);
    definition.set('ownerId', manifest.targetUserId);
  }
  doc.getMap(receiptRoot).set('id', manifest.migrationId);
  doc.getMap(receiptRoot).set('sourceSha256', entry.sha256);
  doc.commit();
  return doc;
}

export function assertOwnedDocument(
  doc: LoroDoc,
  entry: MigrationDocument,
  migrationId: string
): void {
  const receipt = doc.getMap(receiptRoot);
  if (receipt.get('id') !== migrationId || receipt.get('sourceSha256') !== entry.sha256)
    throw new Error(
      `Document ID collision: ${entry.id}. Existing cloud history was not overwritten.`
    );
}

export function mergeRowDecision(
  existing: unknown,
  incoming: MigrationRow,
  hasEntry = false
): 'insert' | 'keep' {
  if (existing === undefined && !hasEntry) return 'insert';
  if (canonical(existing) === canonical(incoming.value)) return 'keep';
  throw new Error(
    `Index collision at ${JSON.stringify(incoming.key)}. Cloud settings were not overwritten.`
  );
}
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  );
}
