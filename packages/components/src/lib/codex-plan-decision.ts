import type {
  AcpConfigOptionValue,
  MessageContent,
  SessionDoc,
  SessionHistory,
} from '@lody/shared';

import {
  CODEX_COLLABORATION_MODE_CONFIG_ID,
  CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
  CODEX_COLLABORATION_MODE_PLAN_VALUE,
} from '@/components/shared/acp-selector-options';

export type CompletedCodexProposedPlan = {
  key: string;
  entryId: string;
  turnId: string;
};

export function shouldShowCodexProposedPlanDecision({
  plan,
  dismissed,
  pending,
  isCodexSession,
  isSessionIdle,
  isSessionActive,
  isAgentBusy,
}: {
  plan: CompletedCodexProposedPlan | null;
  dismissed: boolean;
  pending: boolean;
  isCodexSession: boolean;
  isSessionIdle: boolean;
  isSessionActive: boolean;
  isAgentBusy: boolean;
}): boolean {
  return (
    plan !== null &&
    !dismissed &&
    (pending || (isCodexSession && isSessionIdle && !isSessionActive && !isAgentBusy))
  );
}

export function isCodexPlanModeEnabled(
  configOptionValues: Record<string, AcpConfigOptionValue>
): boolean {
  return (
    configOptionValues[CODEX_COLLABORATION_MODE_CONFIG_ID] === CODEX_COLLABORATION_MODE_PLAN_VALUE
  );
}

export function disableCodexPlanMode(
  configOptionValues: Record<string, AcpConfigOptionValue>
): Record<string, AcpConfigOptionValue> {
  return {
    ...configOptionValues,
    [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
  };
}

export function findLatestCompletedCodexProposedPlan(
  history: SessionDoc['history'] | undefined
): CompletedCodexProposedPlan | null {
  if (!history?.length) {
    return null;
  }

  for (let entryIndex = history.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = history[entryIndex] as SessionHistory | undefined;
    if (!entry?.items?.length) {
      continue;
    }

    const items = entry.items as unknown as MessageContent[];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (
        item?.type !== 'proposed_plan' ||
        item.status !== 'completed' ||
        item.isLatest === false ||
        item.markdown.trim().length === 0
      ) {
        continue;
      }

      return {
        key: `${entry.id}:${item.turnId}`,
        entryId: entry.id,
        turnId: item.turnId,
      };
    }
  }

  return null;
}
