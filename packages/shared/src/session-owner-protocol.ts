import { z } from 'zod';
import type { SessionDataChange } from './session-data/types';
import type { SessionDirectoryRow, SessionTurnRead } from './session-data/domain';

export const SessionOwnerRequestSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  leaseId: z.string().min(1).max(128),
  method: z.enum([
    'open',
    'close',
    'count',
    'readAt',
    'readTurn',
    'readRange',
    'readDirectory',
    'readAll',
    'readTurns',
    'readTurnOutput',
    'appendTurn',
    'replaceTurn',
    'respondPermission',
    'applyHistoryAction',
    'applyHistoryImport',
    'replaceEditableTail',
    'rollback',
    'capture',
    'copyFrom',
    'enqueue',
    'removeQueued',
    'updateQueued',
    'reorderQueued',
    'sync',
    'cancelSync',
    'setSync',
    'releaseHandle',
  ]),
  args: z.array(z.unknown()).max(8),
});

export type SessionOwnerRequest = z.infer<typeof SessionOwnerRequestSchema>;
export type SessionOwnerResult = { ok: true; value: unknown } | { ok: false; error: string };
export type SessionOwnerMessage = {
  requestId: string;
  clientId: string;
  request: SessionOwnerRequest;
};
export type SessionOwnerEvent = {
  clientId: string;
  leaseId: string;
  /** Owner incarnation fences replies and observations after a crash. */
  generation: string;
  sequence: number;
} & (
  | { kind: 'history'; change: SessionDataChange }
  | { kind: 'state'; state: unknown }
  | { kind: 'sync'; state: string }
  | { kind: 'lost'; error: string }
);
export type SessionOwnerSnapshot = {
  generation: string;
  sequence: number;
  directory: readonly SessionDirectoryRow[];
  tail: readonly SessionTurnRead[];
  state: unknown;
  syncState: string;
  historyBackend: 'loro' | 'roost';
};
