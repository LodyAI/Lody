import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { MachineId, SessionId, WorkspaceId } from '@lody/shared';

/**
 * Machine-local authority for the native queue-Steer saga. Shared Session data
 * cannot prove that the daemon accepted an RPC because collaborators may write
 * it. One owner-scoped file per Session survives process death and is replaced
 * by the next native operation; a completed marker doubles as the latest
 * crash-safe receipt. Atomic rename prevents recovery from reading a partial
 * phase transition.
 */
const QueueSteerResponseSchema = z
  .object({
    disposition: z.enum([
      'accepted',
      'queue-item-missing',
      'queue-item-editing',
      'invalid-queue-item',
      'no-active-turn',
      'stale-turn',
      'unsupported',
      'busy',
      'error',
    ]),
    userTurnId: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .strict();

const QueueSteerOperationMarkerSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    workspaceId: z.string().min(1),
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    operationKey: z.string().min(1),
    queueItemId: z.string().min(1),
    expectedTurnId: z.string().min(1),
    userTurnId: z.string().min(1),
    queueRevision: z.string().min(1).optional(),
    phase: z.enum(['reserved', 'submitting', 'acknowledged', 'applied', 'fallback']),
    response: QueueSteerResponseSchema.optional(),
    completedAt: z.number().finite().optional(),
    updatedAt: z.number().finite(),
  })
  .strict();

export type QueueSteerOperationMarker = z.infer<typeof QueueSteerOperationMarkerSchema>;

export type QueueSteerOperationStore = {
  record(marker: QueueSteerOperationMarker): Promise<void>;
  read(sessionId: SessionId): Promise<QueueSteerOperationMarker | null>;
  clear(sessionId: SessionId): Promise<void>;
  list(): Promise<QueueSteerOperationMarker[]>;
};

function getStoreRoot(): string {
  return path.join(os.homedir(), '.lody', 'session-queue-steer-operations');
}

function getMarkerPath(
  sessionId: SessionId,
  owner: { workspaceId: WorkspaceId; machineId: MachineId }
): string {
  const key = createHash('sha256')
    .update(JSON.stringify([owner.workspaceId, owner.machineId, sessionId]))
    .digest('hex');
  return path.join(getStoreRoot(), `${key}.json`);
}

async function readMarkerFile(markerPath: string): Promise<QueueSteerOperationMarker | null> {
  try {
    const parsed = QueueSteerOperationMarkerSchema.safeParse(
      JSON.parse(await readFile(markerPath, 'utf8')) as unknown
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createFileQueueSteerOperationStore(owner: {
  workspaceId: WorkspaceId;
  machineId: MachineId;
}): QueueSteerOperationStore {
  return {
    async record(marker) {
      if (!isQueueSteerMarkerOwnedBy(marker, owner.workspaceId, owner.machineId)) {
        throw new Error('Cannot persist a queue Steer marker for another owner');
      }
      const markerPath = getMarkerPath(marker.sessionId as SessionId, owner);
      await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, markerPath);
    },

    async read(sessionId) {
      const marker = await readMarkerFile(getMarkerPath(sessionId, owner));
      return marker && isQueueSteerMarkerOwnedBy(marker, owner.workspaceId, owner.machineId)
        ? marker
        : null;
    },

    async clear(sessionId) {
      await rm(getMarkerPath(sessionId, owner), { force: true });
    },

    async list() {
      let entries: string[];
      try {
        entries = await readdir(getStoreRoot());
      } catch {
        return [];
      }
      const markers: QueueSteerOperationMarker[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const marker = await readMarkerFile(path.join(getStoreRoot(), entry));
        if (marker && isQueueSteerMarkerOwnedBy(marker, owner.workspaceId, owner.machineId)) {
          markers.push(marker);
        }
      }
      return markers;
    },
  };
}

export function createMemoryQueueSteerOperationStore(): QueueSteerOperationStore {
  const markers = new Map<string, QueueSteerOperationMarker>();
  return {
    async record(marker) {
      markers.set(marker.sessionId, structuredClone(marker));
    },
    async read(sessionId) {
      const marker = markers.get(sessionId);
      return marker ? structuredClone(marker) : null;
    },
    async clear(sessionId) {
      markers.delete(sessionId);
    },
    async list() {
      return [...markers.values()].map((marker) => structuredClone(marker));
    },
  };
}

export function isQueueSteerMarkerOwnedBy(
  marker: QueueSteerOperationMarker,
  workspaceId: WorkspaceId,
  machineId: MachineId
): boolean {
  return marker.workspaceId === workspaceId && marker.machineId === machineId;
}
