import { withHistoryPort } from './history-port-fixture';
import type { SessionHistory } from '@lody/shared';
import {
  applyOpenAssistantTurn,
  applyRespondPermission,
  createAssistantTurn,
  type OpenAssistantTurnInput,
} from '@lody/shared/session-data';
import type { PermissionOutcome } from '@lody/shared/message';

type HistoryRecord = SessionHistory & Record<string, unknown>;

/** Service fixtures reuse production planners and their injected history updater. */
export function fakeSessionData(
  updateHistory: (updater: (history: HistoryRecord[]) => HistoryRecord[]) => Promise<void>
) {
  return {
    ...withHistoryPort({ updateHistory }).sessionData,
    agentWrites: {
      async openAssistantTurn(input: OpenAssistantTurnInput) {
        await updateHistory((history) => {
          const next = history.slice();
          const at = next.findIndex(
            (entry) => entry.id === input.turnId && entry.role === 'assistant'
          );
          if (at < 0) next.push(createAssistantTurn(input) as HistoryRecord);
          else {
            const entry = { ...next[at]! };
            applyOpenAssistantTurn(entry, input);
            next[at] = entry;
          }
          return next;
        });
        return { status: 'accepted' as const };
      },
    },
    commands: {
      ...withHistoryPort({ updateHistory }).sessionData.commands,
      async respondPermission(
        requestId: string,
        outcome: PermissionOutcome,
        options?: { turnId?: string }
      ) {
        let matched = false;
        await updateHistory((history) => {
          const next = structuredClone(history);
          for (const entry of next.slice().reverse()) {
            if (options?.turnId && entry.id !== options.turnId) continue;
            if (applyRespondPermission(entry, requestId, outcome)) {
              matched = true;
              break;
            }
          }
          return next;
        });
        return matched
          ? { status: 'accepted' as const }
          : { status: 'rejected' as const, reason: { code: 'not_found' as const } };
      },
    },
  };
}
