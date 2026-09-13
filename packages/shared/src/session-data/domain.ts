import type { MessageContent, ModelInfo, SessionTurnInputConfig } from '../ai';
import type { PlanEntry } from '@agentclientprotocol/sdk';

// # Session domain DTOs
//
// Hand-written domain types for the session-data port. They deliberately do NOT
// import the storage schema (`../schema`), so the port's public surface is a
// business contract rather than a zod-inferred storage shape. The storage layer
// guarantees its own turns satisfy these; adapters convert at their boundary.
//
// `SessionTurn` is structurally satisfied by the stored history entry, which is
// what lets existing producers keep passing their entries without a conversion
// step, while consumers depend only on this file.

export type SessionTurnRole = 'user' | 'assistant' | 'system';

export type SessionTurnStatus =
  | 'pending'
  | 'pending_apply'
  | 'seen'
  | 'processing'
  | 'handled'
  | 'failed'
  | 'canceled';

/**
 * A session turn. Item payloads stay opaque here: display/business readers cast
 * them to their own message shapes, and unknown stored fields are preserved by
 * adapters without being typed.
 */
export type SessionTurn = {
  readonly id: string;
  readonly role: SessionTurnRole;
  readonly timestamp: string;
  readonly userTurnId?: string;
  readonly acpTurnId?: string;
  readonly items?: readonly unknown[];
  readonly plan?: readonly unknown[];
  readonly read?: boolean;
  readonly userId?: string;
  readonly modelInfo?: ModelInfo;
  readonly fileDiff?: readonly unknown[];
  readonly status?: SessionTurnStatus;
  readonly inputConfig?: unknown;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly permissionWaitMs?: number;
  readonly finished?: boolean;
  readonly sendStatus?: 'timeout';
};

/**
 * The values a domain field command may write, one entry per writable field.
 * `items`/`id` are excluded: item edits are whole-entry operations and identity
 * is immutable.
 */
export interface SessionTurnWritableValues {
  userTurnId: string | undefined;
  acpTurnId: string | undefined;
  timestamp: string;
  role: SessionTurnRole;
  read: boolean | undefined;
  userId: string | undefined;
  modelInfo: ModelInfo | undefined;
  fileDiff: readonly unknown[] | undefined;
  status: SessionTurnStatus | undefined;
  inputConfig: unknown;
  startedAt: number | undefined;
  endedAt: number | undefined;
  permissionWaitMs: number | undefined;
  plan: readonly unknown[] | undefined;
  finished: boolean | undefined;
  sendStatus: 'timeout' | undefined;
}

export type SessionWritableField = keyof SessionTurnWritableValues;

/** Why a raw slot or turn cannot be read as a complete domain turn. */
export type SessionUnavailableReason = 'incomplete' | 'unsupported' | 'failed';

/** One raw storage slot's domain read. */
export type SessionTurnRead =
  | { readonly state: 'ready'; readonly turn: SessionTurn }
  | { readonly state: 'invalid' }
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable'; readonly reason: SessionUnavailableReason };

/** A shallow directory row: identity and state without the turn body. */
export type SessionDirectoryRow = {
  readonly position: number;
  readonly state: 'ready' | 'invalid' | 'missing' | 'unavailable';
  /** Business id when the slot declares one; absent for invalid/unknown slots. */
  readonly turnId?: string;
  readonly reason?: SessionUnavailableReason;
  /**
   * Shallow scalar/index facts, read without materializing the turn body. The
   * UI display cache builds its index row from these before any body hydration.
   */
  readonly scalars?: SessionDirectoryScalars;
  /**
   * Shallow send configuration (Role / MCP selection / option values), never the
   * prompt or input blocks. Enough to send with the correct sticky Role before
   * the body is hydrated.
   */
  readonly inputConfig?: unknown;
  /** Item / plan counts when cheaply available; omitted rather than guessed. */
  readonly itemCount?: number;
  readonly planCount?: number;
};

/** The shallow scalars in a directory row, mirrored from the turn's own fields. */
export type SessionDirectoryScalars = {
  readonly id: string;
  readonly role: SessionTurnRole;
  readonly timestamp: string;
  readonly status?: SessionTurnStatus;
  readonly finished?: boolean;
  readonly endedAt?: number;
  readonly sendStatus?: 'timeout';
  readonly userTurnId?: string;
  readonly acpTurnId?: string;
  readonly startedAt?: number;
  readonly permissionWaitMs?: number;
};

/**
 * The body-independent send-config keys a directory row may carry. Kept here so
 * an adapter and any consumer pick the same subset in one place.
 */
export const SESSION_DIRECTORY_INPUT_CONFIG_KEYS = [
  'agentRoleId',
  'agentRoleRevision',
  'modeId',
  'modelId',
  'cliType',
  'agentType',
  'mcpServerIds',
  'configOptionValues',
  'taskToolsEnabled',
] as const;

/** Business history shape, independent of the storage schema and container ids.
 * Known content is interpreted by consumers; stored future variants are retained,
 * so consumers must continue guarding discriminators before reading their payload.
 */
export type SessionEntry = Omit<
  { -readonly [K in keyof SessionTurn]: SessionTurn[K] },
  'items' | 'plan' | 'inputConfig' | 'fileDiff'
> & {
  items?: Array<MessageContent & { text?: string }>;
  plan?: Array<Pick<PlanEntry, 'status' | 'content' | 'priority'>>;
  inputConfig?: SessionTurnInputConfig;
  fileDiff: SessionFileDiff[];
};

/** Opaque Code Collab checkpoint, unrelated to the session storage backend. */
export type SessionFileDiff = {
  filePath: string;
  add: number;
  del: number;
  cc?: {
    v: 1;
    fileId: string;
    opId?: `${string}:${number}`;
    baseOpId?: `${string}:${number}`;
    base?: 'missing';
    deleted?: true;
  };
};
