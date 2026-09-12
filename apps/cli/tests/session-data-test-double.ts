import type { SessionHistory } from '@lody/shared';

type HistoryRecord = SessionHistory & Record<string, unknown>;

/**
 * Test double for the `SessionData` command seam used by `SessionDocument`.
 * It is backed by a fake session doc's own `updateHistory`, so a
 * message-handler test still observes its history array. Each command mirrors
 * the production contract: `openAssistantTurn` reopens or appends, and
 * `respondPermission` locates the request by id (optionally within one turn).
 */
export function fakeSessionData(
  updateHistory: (updater: (history: HistoryRecord[]) => HistoryRecord[]) => Promise<void>
) {
  const rejected = () => ({ status: 'rejected' as const, reason: { code: 'not_found' as const } });
  return {
    history: {
      count: async () => 0,
      readAt: async () => ({ state: 'missing' as const }),
      readTurn: async () => ({ state: 'missing' as const }),
      readRange: async () => [],
      readDirectory: async () => [],
      observe: () => ({ initial: Promise.resolve([]), unsubscribe: () => {} }),
    },
    durability: { waitDurable: async () => {} },
    commands: {
      async openAssistantTurn(input: {
        turnId: string;
        userTurnId?: string;
        modelInfo?: unknown;
        timestamp: string;
      }) {
        await updateHistory((history) => {
          const index = history.findIndex(
            (entry) => entry.id === input.turnId && entry.role === 'assistant'
          );
          if (index < 0) {
            return [
              ...history,
              {
                id: input.turnId,
                role: 'assistant',
                ...(input.userTurnId !== undefined ? { userTurnId: input.userTurnId } : {}),
                ...(input.modelInfo !== undefined ? { modelInfo: input.modelInfo } : {}),
                timestamp: input.timestamp,
                items: [],
                fileDiff: [],
              } as HistoryRecord,
            ];
          }
          const next = history.slice();
          const entry = { ...next[index]! };
          entry.finished = false;
          delete entry.endedAt;
          delete entry.permissionWaitMs;
          if (entry.userTurnId === undefined && input.userTurnId !== undefined)
            entry.userTurnId = input.userTurnId;
          if (input.modelInfo !== undefined) entry.modelInfo = input.modelInfo;
          next[index] = entry;
          return next;
        });
        return {
          status: 'accepted' as const,
          receipt: {
            sessionId: 'fake-session' as never,
            kind: 'open-assistant-turn' as const,
            turnIds: [input.turnId],
          },
        };
      },
      async respondPermission(
        requestId: string,
        outcome: unknown,
        permissionOptions?: { turnId?: string }
      ) {
        let matchedTurnId: string | undefined;
        await updateHistory((history) => {
          const findIn = (index: number) => {
            const entry = history[index];
            if (!entry) return -1;
            const items = Array.isArray(entry.items) ? entry.items : [];
            return items.findIndex(
              (item) =>
                (item as HistoryRecord | undefined)?.type === 'tool_call' &&
                ((item as HistoryRecord).permissionRequest as { requestId?: string } | undefined)
                  ?.requestId === requestId
            );
          };
          const start = permissionOptions?.turnId
            ? history.findIndex((entry) => entry.id === permissionOptions.turnId)
            : history.length - 1;
          if (permissionOptions?.turnId && start < 0) return history;
          for (let index = start; index >= 0; index -= 1) {
            const at = findIn(index);
            if (at < 0) continue;
            const entry = history[index]!;
            const nextItems = Array.isArray(entry.items) ? entry.items.slice() : [];
            const item = { ...(nextItems[at] as HistoryRecord) };
            item.permissionRequest = {
              ...(item.permissionRequest as Record<string, unknown>),
              outcome,
            };
            nextItems[at] = item;
            const next = history.slice();
            next[index] = { ...entry, items: nextItems };
            matchedTurnId = String(entry.id);
            return next;
          }
          return history;
        });
        if (!matchedTurnId) return rejected();
        return {
          status: 'accepted' as const,
          receipt: {
            sessionId: 'fake-session' as never,
            kind: 'respond-permission' as const,
            turnIds: [matchedTurnId],
          },
        };
      },
    },
  };
}
