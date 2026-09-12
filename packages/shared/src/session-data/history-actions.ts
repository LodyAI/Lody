import { markAssistantTurnFinished } from './assistant-finalize';
import { planOperationProgress, planOperationCompletion } from './operation-progress';
import type { StoredLodyOperation } from '../session-orchestration';
import type { OperationProgressStatus } from '../session-orchestration';
import { planTaskProposal } from './task-proposal';
import type { TaskProposalMeta } from '../ai';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import {
  mergeToolCallWithPermission,
  buildToolCallFromPermissionRequest,
} from './permission-request';
import type { MessageContent } from '../ai';
import type { SessionEntry, SessionTurnStatus } from './domain';

export type HistoryAction =
  | {
      kind: 'assistant-file-diff';
      turnId?: string;
      change: { kind: 'set'; value: import('./domain').SessionFileDiff[] } | { kind: 'clear' };
    }
  | {
      kind: 'operation-progress';
      operation: StoredLodyOperation;
      timestamp: string;
      statuses?: readonly (readonly [string, OperationProgressStatus])[];
    }
  | { kind: 'operation-completion'; operation: StoredLodyOperation; turn: SessionEntry }
  | { kind: 'task-proposal'; turnId: string; meta: TaskProposalMeta; timestamp: string }
  | {
      kind: 'upsert-goal';
      goal: Extract<MessageContent, { type: 'goal' }>;
      targetTurnId?: string;
      fallback: SessionEntry;
    }
  | { kind: 'clear-goal'; threadId: string; updatedAt: number }
  | { kind: 'permission-request'; requestId: string; request: RequestPermissionRequest }
  | { kind: 'assistant-items'; turnId: string; mode: 'append' | 'replace'; items: MessageContent[] }
  | {
      kind: 'user-status';
      turnId: string;
      status: SessionTurnStatus;
      requeueUndelivered?: boolean;
      onlyPendingApply?: boolean;
      deliveredSteer?: boolean;
    }
  | {
      kind: 'finish-assistant';
      turnId?: string;
      endedAt: number;
      permissionWaitMs?: number;
      settleContextCompactionAsFailed?: boolean;
      force?: boolean;
    }
  | { kind: 'upsert-turn'; turn: SessionEntry; beforeTurnId?: string; beforeLastUser?: boolean }
  | { kind: 'remove-turn'; turnId: string }
  | { kind: 'agent-warning'; turn: SessionEntry; message: string }
  | { kind: 'file-backfilled'; fileId: string; relayFileId: string };

/** Which actions can be committed by reading exactly one body. */
export function historyActionTarget(action: HistoryAction): string | undefined {
  return action.kind === 'assistant-items' ||
    action.kind === 'user-status' ||
    action.kind === 'finish-assistant' ||
    action.kind === 'assistant-file-diff'
    ? action.turnId
    : undefined;
}

/** Called on a private draft at commit time by either backend. */
export function applyHistoryAction(
  history: SessionEntry[],
  action: HistoryAction
): {
  turns: SessionEntry[];
  matched: boolean;
  proposal?: import('./task-proposal').TaskProposalPublishResult;
} {
  switch (action.kind) {
    case 'assistant-file-diff': {
      const entry = [...history]
        .reverse()
        .find((t) => t.role === 'assistant' && (!action.turnId || t.id === action.turnId));
      if (!entry) return { turns: history, matched: false };
      if (action.change.kind === 'clear') Reflect.deleteProperty(entry, 'fileDiff');
      else entry.fileDiff = action.change.value;
      return { turns: history, matched: true };
    }

    case 'operation-progress': {
      const turns = planOperationProgress(
        history,
        action.operation,
        action.timestamp,
        action.statuses
      );
      return { turns, matched: turns !== history };
    }
    case 'operation-completion': {
      const turns = planOperationCompletion(history, action.operation, action.turn);
      return { turns, matched: turns !== history };
    }
    case 'task-proposal':
      return planTaskProposal(history, action.turnId, action.meta, action.timestamp);
    case 'upsert-goal': {
      let replaced = false;
      for (const entry of history)
        entry.items = entry.items?.flatMap<MessageContent>((item) => {
          if (item.type === 'goal' && item.threadId === action.goal.threadId) {
            replaced = true;
            return [action.goal];
          }
          return item.type === 'goal' && item.status === 'cleared' ? [] : [item];
        });
      if (!replaced) {
        let target =
          history.find((t) => t.id === action.targetTurnId && t.role === 'assistant') ??
          [...history]
            .reverse()
            .find(
              (t) => t.role === 'assistant' && t.finished !== true && typeof t.endedAt !== 'number'
            );
        if (!target) {
          target = action.fallback;
          history.push(target);
        }
        target.items = [...(target.items ?? []), action.goal];
      }
      return { turns: history, matched: true };
    }
    case 'clear-goal': {
      let matched = false;
      for (const entry of history)
        for (const item of entry.items ?? [])
          if (
            item.type === 'goal' &&
            item.threadId === action.threadId &&
            item.status !== 'cleared'
          ) {
            item.status = 'cleared';
            item.updatedAt = action.updatedAt;
            matched = true;
          }
      return { turns: history, matched };
    }
    case 'permission-request': {
      let ownerFound = false;
      let matched = false;
      for (const entry of history)
        entry.items = entry.items?.map((item) => {
          if (item.type !== 'tool_call' || item.toolCallId !== action.request.toolCall.toolCallId)
            return item;
          ownerFound = true;
          if (entry.finished === true || typeof entry.endedAt === 'number') return item;
          matched = true;
          return mergeToolCallWithPermission(item, action.requestId, action.request);
        });
      const last = history.at(-1);
      if (
        !ownerFound &&
        last?.role === 'assistant' &&
        last.finished !== true &&
        typeof last.endedAt !== 'number'
      ) {
        last.items = [
          ...(last.items ?? []),
          buildToolCallFromPermissionRequest(action.requestId, action.request),
        ];
        matched = true;
      }
      return { turns: history, matched };
    }
    case 'assistant-items': {
      const entry = history.find((t) => t.id === action.turnId && t.role === 'assistant');
      if (!entry) return { turns: history, matched: false };
      entry.items =
        action.mode === 'append' ? [...(entry.items ?? []), ...action.items] : action.items;
      return { turns: history, matched: true };
    }
    case 'user-status': {
      const entry = history.find((t) => t.id === action.turnId && t.role === 'user');
      if (!entry) return { turns: history, matched: action.requeueUndelivered === true };
      if (action.onlyPendingApply && entry.status !== 'pending_apply')
        return { turns: history, matched: false };
      if (action.requeueUndelivered) {
        if (!['pending_apply', 'pending', 'seen'].includes(entry.status ?? ''))
          return { turns: history, matched: false };
        if (entry.status !== 'pending_apply') return { turns: history, matched: true };
      }
      entry.status = action.status;
      entry.read = action.status !== 'pending' && action.status !== 'pending_apply';
      if (action.deliveredSteer)
        entry.inputConfig = { ...entry.inputConfig, _lodyDeliveryKind: 'steer' };
      return { turns: history, matched: true };
    }
    case 'finish-assistant': {
      const matched = history.some(
        (t) => t.role === 'assistant' && (!action.turnId || t.id === action.turnId)
      );
      return { turns: markAssistantTurnFinished(history, action), matched };
    }
    case 'remove-turn':
      return {
        turns: history.filter((t) => t.id !== action.turnId),
        matched: history.some((t) => t.id === action.turnId),
      };
    case 'upsert-turn': {
      const index = history.findIndex((t) => t.id === action.turn.id);
      if (index >= 0) history[index] = action.turn;
      else {
        const before = action.beforeLastUser
          ? history.map((t) => t.role).lastIndexOf('user')
          : history.findIndex((t) => t.id === action.beforeTurnId);
        history.splice(before >= 0 ? before : history.length, 0, action.turn);
      }
      return { turns: history, matched: true };
    }
    case 'agent-warning': {
      if (
        history.some((t) =>
          t.items?.some(
            (item) =>
              item.type === 'system_notice' &&
              item.name === 'agent_warning' &&
              item.meta?.message === action.message
          )
        )
      )
        return { turns: history, matched: false };
      return { turns: [...history, action.turn], matched: true };
    }
    case 'file-backfilled': {
      let matched = false;
      for (const entry of history)
        for (const item of entry.items ?? []) {
          if (item.type === 'file' && item.fileId === action.fileId && item.transport === 'local') {
            item.fileId = action.relayFileId;
            item.transport = 'r2';
            delete item.machineId;
            matched = true;
          }
        }
      return { turns: history, matched };
    }
  }
  const unreachable: never = action;
  throw new Error('Unsupported history action', { cause: unreachable });
}
