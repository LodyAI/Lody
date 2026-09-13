import { useMemo } from 'react';
import {
  isAskUserQuestionPermissionMeta,
  resolveLatestSessionGoalFromHistory,
  type MessageContent,
  type SessionGoalMessage,
  type SessionHistory,
  type ToolKind,
} from '@lody/shared';
import { useConversationDerivation, useConversationIndexRows } from '@/hooks/use-conversation-view';
import {
  findLatestCompletedCodexProposedPlan,
  type CompletedCodexProposedPlan,
} from '@/lib/codex-plan-decision';
import type { ConversationView, DeriveTurnFact, TurnIndexRow } from '@/lib/conversation-view';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

export type PermissionScanEntry = {
  requestId: string;
  requestKind: 'ask_user_question' | 'tool_permission';
  toolKind: ToolKind | null;
  hasOutcome: boolean;
  decision: 'allow' | 'deny' | 'cancelled' | 'other';
};

/**
 * Flatten every tool-call permission request in these turns so the permission
 * funnel (shown → responded) can be derived from CRDT state by diffing
 * snapshots rather than instrumenting the response handler.
 */
export const scanPermissionRequests = (
  history: readonly SessionHistory[] | undefined
): PermissionScanEntry[] => {
  if (!history?.length) return [];
  const entries: PermissionScanEntry[] = [];
  for (const historyEntry of history) {
    if (historyEntry.role !== 'assistant') continue;
    const rawItems: unknown = historyEntry.items;
    if (!Array.isArray(rawItems)) continue;
    for (const rawItem of rawItems) {
      const item = rawItem as MessageContent;
      if (!item || item.type !== 'tool_call') continue;
      const permission = (item as ToolCallMessage).permissionRequest;
      if (!permission?.requestId) continue;
      const outcome = permission.outcome;
      let decision: PermissionScanEntry['decision'] = 'other';
      if (outcome) {
        if (outcome.outcome === 'cancelled') {
          decision = 'cancelled';
        } else if (outcome.outcome === 'selected') {
          const selected = permission.options.find((opt) => opt.optionId === outcome.optionId);
          const kind = selected?.kind ?? '';
          decision = kind.startsWith('allow')
            ? 'allow'
            : kind.startsWith('deny') || kind.startsWith('reject')
              ? 'deny'
              : 'other';
        }
      }
      entries.push({
        requestId: permission.requestId,
        requestKind: isAskUserQuestionPermissionMeta(permission._meta)
          ? 'ask_user_question'
          : 'tool_permission',
        toolKind: (item as ToolCallMessage).kind ?? null,
        hasOutcome: Boolean(outcome),
        decision,
      });
    }
  }
  return entries;
};

/** Completed scheduling tool calls, kept with the timestamps the collector anchors on. */
export type ScheduledTaskTurnEntry = {
  timestamp?: string;
  startedAt?: number;
  endedAt?: number;
  items: MessageContent[];
};

const isSchedulingToolCall = (item: MessageContent): boolean => {
  if (item.type !== 'tool_call' || item.status !== 'completed') return false;
  const call = item as ToolCallMessage & { toolName?: unknown };
  const name = typeof call.toolName === 'string' ? call.toolName : (call.title ?? '');
  return name === 'ScheduleWakeup' || name.startsWith('Cron');
};

/**
 * Everything the session surfaces need from turns outside the hydrated tail.
 * Derived once per turn object by `useSessionTurnFacts`.
 */
export type SessionTurnFacts = {
  id: string;
  role: SessionHistory['role'];
  /** The turn's last goal item, for the goal banner. */
  goal: SessionGoalMessage | null;
  /** Scheduling tool calls with their anchor timestamps; null when none. */
  scheduling: ScheduledTaskTurnEntry | null;
  /** The turn's latest completed Codex proposed plan. */
  proposedPlan: CompletedCodexProposedPlan | null;
  permissionRequests: PermissionScanEntry[];
};

export const deriveSessionTurnFacts: DeriveTurnFact<SessionTurnFacts> = (turn) => {
  const items = Array.isArray(turn.items) ? (turn.items as unknown as MessageContent[]) : [];
  const scheduling = items.filter(isSchedulingToolCall);
  return {
    id: turn.id,
    role: turn.role,
    goal: resolveLatestSessionGoalFromHistory([turn]),
    scheduling:
      scheduling.length > 0
        ? {
            timestamp: turn.timestamp,
            startedAt: turn.startedAt,
            endedAt: turn.endedAt,
            items: scheduling,
          }
        : null,
    proposedPlan: findLatestCompletedCodexProposedPlan([turn] as never),
    permissionRequests: scanPermissionRequests([turn]),
  };
};

export type SessionTurnFactsResult = {
  /** Facts in conversation order; turns not yet derived are absent. */
  ordered: readonly SessionTurnFacts[];
  /** Whether the background pass has covered the whole conversation. */
  complete: boolean;
};

const EMPTY_ORDERED: readonly SessionTurnFacts[] = [];

/**
 * One fact table per session, shared by every "latest X anywhere in history"
 * reader. The newest turns are derived first, so readers converge from the
 * tail outward while the background pass runs.
 */
export function useSessionTurnFacts(view: ConversationView | null | undefined): SessionTurnFactsResult {
  const rows = useConversationIndexRows(view);
  const { facts, complete, version } = useConversationDerivation(view, deriveSessionTurnFacts);
  const ordered = useMemo(() => {
    if (facts.size === 0) return EMPTY_ORDERED;
    const list: SessionTurnFacts[] = [];
    for (const row of rows as readonly TurnIndexRow[]) {
      const fact = facts.get(row.id);
      if (fact) list.push(fact);
    }
    return list;
    // `version` is the change signal for the fact table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts, rows, version]);
  return useMemo(() => ({ ordered, complete }), [ordered, complete]);
}

/** The newest goal item anywhere in the conversation. */
export const latestGoalFromFacts = (ordered: readonly SessionTurnFacts[]): SessionGoalMessage | null => {
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const goal = ordered[i]?.goal;
    if (goal) return goal;
  }
  return null;
};

/** The newest completed proposed plan anywhere in the conversation. */
export const latestProposedPlanFromFacts = (
  ordered: readonly SessionTurnFacts[]
): CompletedCodexProposedPlan | null => {
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const plan = ordered[i]?.proposedPlan;
    if (plan) return plan;
  }
  return null;
};

export const schedulingEntriesFromFacts = (
  ordered: readonly SessionTurnFacts[]
): ScheduledTaskTurnEntry[] => {
  const entries: ScheduledTaskTurnEntry[] = [];
  for (const fact of ordered) if (fact.scheduling) entries.push(fact.scheduling);
  return entries;
};

export const permissionRequestsFromFacts = (
  ordered: readonly SessionTurnFacts[]
): PermissionScanEntry[] => {
  const entries: PermissionScanEntry[] = [];
  for (const fact of ordered) for (const entry of fact.permissionRequests) entries.push(entry);
  return entries;
};
