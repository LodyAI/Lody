import {
  applyNotificationOnHistoryWithChange,
  type ACPSessionId,
  type AcpContentBlock,
  type AcpSessionNotification,
  type LocalProjectHistoryProvider,
  type MessageContent,
  type SessionHistoryInput,
} from '@lody/shared';

export type BuildHistoryReplayImportOptions = {
  acpSessionId: string;
  provider: LocalProjectHistoryProvider;
  userId?: string;
  now?: () => string;
  createId?: () => string;
  mode?: 'resumable' | 'imported_snapshot';
};

export type BuildHistoryReplayImportResult = {
  history: SessionHistoryInput[];
  droppedNotifications: number;
};

const defaultNow = (): string => new Date().toISOString();

const defaultCreateId = (): string => {
  const maybeCrypto = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof maybeCrypto?.randomUUID === 'function') {
    return maybeCrypto.randomUUID();
  }
  return `history-replay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

function textFromContentBlock(content: AcpContentBlock | undefined): string | null {
  if (!content || content.type !== 'text') {
    return null;
  }
  return content.text;
}

function appendUserText(entry: SessionHistoryInput, text: string): SessionHistoryInput {
  const items = Array.isArray(entry.items)
    ? ([...(entry.items as unknown as MessageContent[])] as MessageContent[])
    : [];
  const last = items[items.length - 1];
  if (last?.type === 'text') {
    items[items.length - 1] = {
      ...last,
      text: `${last.text}${text}`,
    };
  } else {
    items.push({ type: 'text', text });
  }
  return {
    ...entry,
    items: items as unknown as SessionHistoryInput['items'],
    inputConfig: entry.inputConfig
      ? {
          ...entry.inputConfig,
          prompt: `${entry.inputConfig.prompt ?? ''}${text}`,
        }
      : entry.inputConfig,
  };
}

function createUserEntry(args: {
  id: string;
  text: string;
  timestamp: string;
  userId?: string;
  acpSessionId: string;
  provider: LocalProjectHistoryProvider;
  mode: NonNullable<BuildHistoryReplayImportOptions['mode']>;
}): SessionHistoryInput {
  const inputConfig: NonNullable<SessionHistoryInput['inputConfig']> = {
    prompt: args.text,
    cliType: args.provider.cliType,
    agentType: args.provider.agentType,
    ...(args.mode === 'resumable' ? { resume: args.acpSessionId as ACPSessionId } : {}),
  };

  return {
    id: args.id,
    role: 'user',
    items: [{ type: 'text', text: args.text }] as unknown as SessionHistoryInput['items'],
    timestamp: args.timestamp,
    status: args.mode === 'resumable' ? 'seen' : 'handled',
    read: true,
    userId: args.userId,
    finished: true,
    fileDiff: [],
    inputConfig,
  };
}

export function buildHistoryReplayImport(
  notifications: AcpSessionNotification[],
  options: BuildHistoryReplayImportOptions
): BuildHistoryReplayImportResult {
  const now = options.now ?? defaultNow;
  const createId = options.createId ?? defaultCreateId;
  const mode = options.mode ?? 'resumable';
  const provider = options.provider;
  let history: SessionHistoryInput[] = [];
  let lastWasUserChunk = false;
  let droppedNotifications = 0;

  for (const notification of notifications) {
    if (notification.update.sessionUpdate === 'user_message_chunk') {
      const text = textFromContentBlock(notification.update.content);
      if (text === null) {
        droppedNotifications += 1;
        lastWasUserChunk = false;
        continue;
      }

      const lastIndex = history.length - 1;
      const last = lastIndex >= 0 ? history[lastIndex] : undefined;
      if (lastWasUserChunk && last?.role === 'user') {
        history[lastIndex] = appendUserText(last, text);
      } else {
        history.push(
          createUserEntry({
            id: createId(),
            text,
            timestamp: now(),
            userId: options.userId,
            acpSessionId: options.acpSessionId,
            provider,
            mode,
          })
        );
      }
      lastWasUserChunk = true;
      continue;
    }

    const applied = applyNotificationOnHistoryWithChange(history, [notification], undefined, {
      createId,
      now,
    });
    history = applied.history;
    if (!applied.changed) {
      const updateType = notification.update.sessionUpdate;
      if (
        updateType !== 'session_info_update' &&
        updateType !== 'current_mode_update' &&
        updateType !== 'config_option_update' &&
        updateType !== 'usage_update' &&
        updateType !== 'available_commands_update'
      ) {
        droppedNotifications += 1;
      }
    }
    lastWasUserChunk = false;
  }

  return {
    history: history.map((entry) =>
      entry.role === 'assistant'
        ? {
            ...entry,
            finished: entry.finished ?? true,
          }
        : entry
    ),
    droppedNotifications,
  };
}
