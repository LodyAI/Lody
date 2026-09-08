import type {
  AcpConfigOptionValue,
  MessageContent,
  SessionDoc,
  SessionHistory,
} from '@lody/shared';

import { LODY_PLAN_MODE_CONFIG_ID } from '@lody/shared';

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
  return configOptionValues[LODY_PLAN_MODE_CONFIG_ID] === true;
}

export function disableCodexPlanMode(
  configOptionValues: Record<string, AcpConfigOptionValue>
): Record<string, AcpConfigOptionValue> {
  return {
    ...configOptionValues,
    [LODY_PLAN_MODE_CONFIG_ID]: false,
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
