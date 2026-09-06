import { z } from 'zod';

import type { MachineId, SessionId, WorkspaceId } from './ids';
import type { SessionTurnInputConfig } from './ai';

export const LODY_OPERATION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const LODY_OPERATION_ID_MAX_LENGTH = 64;
export const LODY_OPERATION_DEFAULT_DEADLINE_SECONDS = 86_400;
export const LODY_OPERATION_MIN_DEADLINE_SECONDS = 60;
export const LODY_OPERATION_MAX_DEADLINE_SECONDS = 604_800;
export const LODY_OPERATION_COMMAND_MAX_BYTES = 256 * 1024;
export const LODY_OPERATION_COMPLETION_MAX_BYTES = 64 * 1024;
export const LODY_MAX_CHAIN_DEPTH = 5;

export const LodyOperationIdSchema = z
  .string()
  .min(1)
  .max(LODY_OPERATION_ID_MAX_LENGTH)
  .regex(LODY_OPERATION_ID_PATTERN);

export const LodyErrorSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();

export type LodyError = z.infer<typeof LodyErrorSchema>;

export type LodyOperationKind =
  | 'session_create'
  | 'session_create_many'
  | 'session_chat'
  | 'session_chat_many';

/**
 * Durable batch Operations intentionally bypass the cooperative session quotas;
 * single-target Commands stay subject to them (specs/session-orchestration.md).
 */
export function shouldBypassSessionQuota(kind: LodyOperationKind): boolean {
  return kind === 'session_create_many' || kind === 'session_chat_many';
}

export type LodyOperationItemTarget = {
  sessionId: SessionId;
  userTurnId: string;
};

export type LodyOperationOutputPreview = {
  text: string;
  truncated?: true;
  omittedBytes?: number;
};

export type LodyOperationItemResult =
  | {
      status: 'active';
      label?: string;
      target: LodyOperationItemTarget;
      inputDurable: boolean;
    }
  | {
      status: 'succeeded';
      label?: string;
      target: LodyOperationItemTarget;
      assistantTurnId: string;
      output?: LodyOperationOutputPreview;
    }
  | {
      status: 'failed';
      label?: string;
      target?: LodyOperationItemTarget;
      error: LodyError;
    }
  | {
      status: 'cancelled';
      label?: string;
      target?: LodyOperationItemTarget;
    };

export type LodyOperationResult = {
  items: LodyOperationItemResult[];
};

export type LodyCompletionTruncation = {
  truncated: true;
  omittedBytes: number;
};

export type LodyOperationCompletion =
  | { type: 'result'; value: LodyOperationResult; truncation?: LodyCompletionTruncation }
  | { type: 'error'; error: LodyError; truncation?: LodyCompletionTruncation }
  | {
      type: 'cancelled';
      partial?: LodyOperationResult;
      truncation?: LodyCompletionTruncation;
    };

export type LodyOperationSnapshot =
  | {
      id: string;
      kind: LodyOperationKind;
      state: 'active';
      createdAt: string;
      deadlineAt: string;
      progress?: { totalItems: number; terminalItems: number };
      items: LodyOperationItemResult[];
    }
  | {
      id: string;
      kind: LodyOperationKind;
      state: 'finished';
      createdAt: string;
      deadlineAt: string;
      finishedAt: string;
      completion: LodyOperationCompletion;
    };

export type FrozenOperationContinuationConfig = {
  agentConfigId?: string;
  inputConfig: SessionTurnInputConfig;
  /** Frozen causal Turn for delegated Operations; recovery must not re-resolve it. */
  sourceTurnId?: string;
  /**
   * Effective per-target create config captured at acceptance. Null entries
   * correspond to batch items rejected before a target was accepted.
   */
  targetDispatchConfigs?: Array<{
    modeId?: string;
    modelId?: string;
    configOptionValues?: Record<string, string | boolean>;
    /**
     * Frozen capability gate for the built-in Lody Task MCP tools, carried
     * from the driving Turn so recovery keeps the same tool surface.
     */
    taskToolsEnabled?: boolean;
    inheritSessionDefaults?: false;
  } | null>;
};

export type StoredLodyOperation = {
  workspaceId: WorkspaceId;
  ownerMachineId: MachineId;
  requesterSessionId: SessionId;
  requesterUserId: string;
  operationId: string;
  kind: LodyOperationKind;
  fingerprint: string;
  canonicalCommand: unknown;
  frozenContinuationConfig: FrozenOperationContinuationConfig;
  initiatorChainDepth: number;
  createdAt: string;
  deadlineAt: string;
  state: 'active' | 'finished';
  items: LodyOperationItemResult[];
  completion?: LodyOperationCompletion;
  finishedAt?: string;
};

export type StoredLodyDelivery = {
  sequence: number;
  workspaceId: WorkspaceId;
  requesterSessionId: SessionId;
  operationId: string;
  deliveryId: string;
  systemTurnId: string;
  state: 'pending' | 'consumed';
  initiatorChainDepth: number;
  completion: LodyOperationCompletion;
  consumedAt?: string;
};

export type OperationCompletionContent = {
  type: 'operation_completion';
  deliveryId: string;
  operationId: string;
  operationKind: LodyOperationKind;
  completion: LodyOperationCompletion;
  continuation?: {
    status: 'not_started';
    reason: {
      code: 'CONFIGURATION_UNAVAILABLE';
      message: string;
    };
  };
};

export const makeLodyError = (code: string, message: string, retryable: boolean): LodyError => ({
  code,
  message,
  retryable,
});

export const isTerminalLodyOperationItem = (item: LodyOperationItemResult): boolean =>
  item.status !== 'active';
