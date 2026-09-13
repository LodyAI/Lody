import type { MessageContent, SessionHistoryInput, SessionId } from '@lody/shared';
import type { SessionDocument } from '@/lib/loro/doc';

export type StructuredSessionOutputMode = 'json' | 'jsonl';

type SessionDocForOutput = Pick<SessionDocument, 'sessionId' | 'sessionData' | 'subscribeAll'>;

export type SessionTurnOutputEvent =
  | {
      type: 'update';
      sessionId: SessionId;
      turnId: string;
      content: MessageContent;
    }
  | {
      type: 'done';
      sessionId: SessionId;
      turnId: string;
      durationMs: number;
    };

export type CompletedAssistantTurn = {
  sessionId: SessionId;
  userTurnId: string;
  turnId: string;
  content: MessageContent[];
  durationMs: number;
  entry: SessionHistoryInput;
};

export type SessionTurnWaitErrorCode = 'failed' | 'canceled' | 'timeout';

export class SessionTurnWaitError extends Error {
  constructor(
    public readonly code: SessionTurnWaitErrorCode,
    public readonly sessionId: SessionId,
    public readonly userTurnId: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionTurnWaitError';
  }
}

const normalizeMessageItems = (items: SessionHistoryInput['items']): MessageContent[] => {
  return Array.isArray(items) ? (items as MessageContent[]) : [];
};

const findUserTurnIndex = (history: SessionHistoryInput[], userTurnId: string): number => {
  return history.findIndex((entry) => entry?.id === userTurnId && entry.role === 'user');
};

export function findAssistantEntryForUserTurn(
  history: SessionHistoryInput[],
  userTurnId: string
): SessionHistoryInput | undefined {
  const userTurnIndex = findUserTurnIndex(history, userTurnId);
  if (userTurnIndex < 0) {
    return undefined;
  }

  for (let index = userTurnIndex + 1; index < history.length; index += 1) {
    const entry = history[index];
    if (entry?.role === 'assistant' && entry.userTurnId === userTurnId) {
      return entry;
    }
  }

  return undefined;
}

const findUserTurn = (
  history: SessionHistoryInput[],
  userTurnId: string
): SessionHistoryInput | undefined => {
  const userTurnIndex = findUserTurnIndex(history, userTurnId);
  return userTurnIndex >= 0 ? history[userTurnIndex] : undefined;
};

const findChatFailureMessage = (
  history: SessionHistoryInput[],
  userTurnId: string
): string | undefined => {
  const userTurnIndex = findUserTurnIndex(history, userTurnId);
  if (userTurnIndex < 0) {
    return undefined;
  }

  for (let index = history.length - 1; index > userTurnIndex; index -= 1) {
    const entry = history[index];
    if (entry?.role !== 'system' || !Array.isArray(entry.items)) {
      continue;
    }

    for (const item of entry.items as MessageContent[]) {
      const noticeMeta = item.type === 'system_notice' ? item.meta : undefined;
      if (
        item.type === 'system_notice' &&
        item.name === 'chat_failed' &&
        noticeMeta &&
        typeof noticeMeta === 'object' &&
        'message' in noticeMeta &&
        typeof noticeMeta.message === 'string' &&
        noticeMeta.message.trim()
      ) {
        return noticeMeta.message.trim();
      }
    }
  }

  return undefined;
};

export function calculateTurnDurationMs(
  entry: Pick<SessionHistoryInput, 'timestamp' | 'endedAt'>
): number {
  const startedAt = Date.parse(entry.timestamp);
  if (!Number.isFinite(startedAt) || typeof entry.endedAt !== 'number') {
    return 0;
  }
  return Math.max(0, entry.endedAt - startedAt);
}

export async function waitForTurnCompletion(options: {
  sessionDoc: SessionDocForOutput;
  userTurnId: string;
  outputMode: StructuredSessionOutputMode;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: SessionTurnOutputEvent) => void;
}): Promise<CompletedAssistantTurn> {
  if (!options.sessionDoc.sessionData || !options.sessionDoc.subscribeAll) {
    throw new Error('SessionDocument not initialized');
  }

  return await new Promise<CompletedAssistantTurn>((resolve, reject) => {
    let settled = false;
    let lastAssistantTurnId: string | undefined;
    let lastSerializedItems: string[] = [];
    let unsubscribe = () => {};
    let timeoutId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      unsubscribe();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      options.signal?.removeEventListener('abort', handleAbort);
    };

    const settle = (handler: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      handler();
    };

    const emit = (event: SessionTurnOutputEvent) => {
      options.onEvent?.(event);
    };

    const rejectWith = (error: Error) => {
      settle(() => reject(error));
    };

    const inspect = (history: SessionHistoryInput[]) => {
      if (settled) {
        return;
      }

      const userTurn = findUserTurn(history, options.userTurnId);
      if (userTurn?.status === 'failed') {
        rejectWith(
          new SessionTurnWaitError(
            'failed',
            options.sessionDoc.sessionId,
            options.userTurnId,
            findChatFailureMessage(history, options.userTurnId) ?? 'Session turn failed.'
          )
        );
        return;
      }

      if (userTurn?.status === 'canceled') {
        rejectWith(
          new SessionTurnWaitError(
            'canceled',
            options.sessionDoc.sessionId,
            options.userTurnId,
            'Session turn was canceled.'
          )
        );
        return;
      }

      const assistantEntry = findAssistantEntryForUserTurn(history, options.userTurnId);

      if (assistantEntry) {
        const items = normalizeMessageItems(assistantEntry.items);
        if (assistantEntry.id !== lastAssistantTurnId) {
          lastAssistantTurnId = assistantEntry.id;
          lastSerializedItems = [];
        }

        if (options.outputMode === 'jsonl') {
          const nextSerializedItems = items.map((item) => JSON.stringify(item));
          for (let index = 0; index < nextSerializedItems.length; index += 1) {
            if (nextSerializedItems[index] !== lastSerializedItems[index]) {
              emit({
                type: 'update',
                sessionId: options.sessionDoc.sessionId,
                turnId: assistantEntry.id,
                content: items[index]!,
              });
            }
          }
          lastSerializedItems = nextSerializedItems;
        }

        if (
          userTurn?.status === 'handled' &&
          (assistantEntry.finished === true || typeof assistantEntry.endedAt === 'number')
        ) {
          const completedTurn: CompletedAssistantTurn = {
            sessionId: options.sessionDoc.sessionId,
            userTurnId: options.userTurnId,
            turnId: assistantEntry.id,
            content: items,
            durationMs: calculateTurnDurationMs(assistantEntry),
            entry: assistantEntry,
          };
          if (options.outputMode === 'jsonl') {
            emit({
              type: 'done',
              sessionId: options.sessionDoc.sessionId,
              turnId: assistantEntry.id,
              durationMs: completedTurn.durationMs,
            });
          }
          settle(() => resolve(completedTurn));
          return;
        }
      }
    };

    // Start each consistent read at observation time, then deliver results in
    // observation order even when the backend completes requests out of order.
    let delivery = Promise.resolve();
    const refresh = () => {
      if (settled) return;
      const snapshot = options.sessionDoc.sessionData.history.readTurnOutput(options.userTurnId);
      // Attach immediately: a later read may reject before an earlier one finishes.
      const captured = snapshot.then(
        (history) => ({ history }),
        (error) => ({ error })
      );
      delivery = delivery
        .then(async () => {
          const result = await captured;
          if (settled) return;
          if ('error' in result) rejectWith(result.error);
          else inspect(result.history);
        })
        .catch(rejectWith);
    };

    const handleAbort = () => {
      rejectWith(new Error('Turn completion wait aborted.'));
    };

    unsubscribe = options.sessionDoc.subscribeAll(refresh);
    options.signal?.addEventListener('abort', handleAbort, { once: true });

    if (options.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        rejectWith(
          new SessionTurnWaitError(
            'timeout',
            options.sessionDoc.sessionId,
            options.userTurnId,
            `Timed out waiting for session turn completion after ${Math.ceil(
              options.timeoutMs / 1000
            )}s.`
          )
        );
      }, options.timeoutMs);
    }

    refresh();
  });
}
