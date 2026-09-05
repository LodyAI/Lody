import type {
  ACPSessionConfig,
  AcpConfigOptionValue,
  AgentConfigCliType,
  CommentReferencePayload,
  IssuePRMention,
  SessionFilePayload,
  SessionImagePayload,
  SessionInputBlock,
  SessionTurnInputConfig,
  VisualAnnotationReferencePayload,
} from './ai';
import { isSessionFileSourcePath } from './ai';
import type { SessionHistoryInput } from './schema';
import type { McpServerId } from './ids';
import { reanchorMessageTextSpansForTrim, sanitizeMessageTextSpans } from './message-text-spans';
import {
  AgentConfigCliTypeSchema,
  SessionInputBlocksSchema,
  normalizeSessionTurnInputConfig,
} from './message-schemas';

type BaseSessionHistoryItem = NonNullable<SessionHistoryInput['items']>[number];

export type SessionInputHistoryItem =
  | (BaseSessionHistoryItem & {
      type: 'text';
      text: string;
    })
  | (BaseSessionHistoryItem & {
      type: 'image';
      text: undefined;
    } & SessionImagePayload)
  | (BaseSessionHistoryItem & {
      text: undefined;
    } & SessionFilePayload)
  | (BaseSessionHistoryItem & {
      type: 'comment_reference';
      text: undefined;
    } & CommentReferencePayload)
  | (BaseSessionHistoryItem & {
      type: 'visual_annotation_reference';
      text: undefined;
    } & VisualAnnotationReferencePayload);

export type PendingUserHistoryEntry = {
  userId: string;
  role: 'user';
  items: NonNullable<SessionHistoryInput['items']>;
  timestamp: string;
  status: 'pending' | 'pending_apply';
  inputConfig?: SessionTurnInputConfig;
  read: false;
  fileDiff: [];
  finished: true;
};

export type SessionConversationConfig = {
  sourceConfigKey?: string;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  mcpServerIds?: McpServerId[];
  taskToolsEnabled?: boolean;
  scheduleToolsEnabled?: boolean;
};

export const resolveSessionConversationConfig = (
  history: readonly { id: string; role: unknown; inputConfig?: unknown }[],
  messageQueue: readonly { $cid?: unknown; acpSessionConfig?: unknown }[] = []
): SessionConversationConfig => {
  const resolveConfig = (
    value: unknown,
    sourceConfigKey: string
  ): SessionConversationConfig | null => {
    const inputConfig = normalizeSessionTurnInputConfig(value);
    if (!inputConfig) {
      return null;
    }

    return {
      sourceConfigKey,
      ...(inputConfig.modeId ? { modeId: inputConfig.modeId } : {}),
      ...(inputConfig.modelId ? { modelId: inputConfig.modelId } : {}),
      ...(inputConfig.configOptionValues && Object.keys(inputConfig.configOptionValues).length > 0
        ? { configOptionValues: inputConfig.configOptionValues }
        : {}),
      ...(inputConfig.mcpServerIds ? { mcpServerIds: inputConfig.mcpServerIds } : {}),
      ...(typeof inputConfig.taskToolsEnabled === 'boolean'
        ? { taskToolsEnabled: inputConfig.taskToolsEnabled }
        : {}),
      ...(typeof inputConfig.scheduleToolsEnabled === 'boolean'
        ? { scheduleToolsEnabled: inputConfig.scheduleToolsEnabled }
        : {}),
    };
  };

  const latestQueuedIndex = messageQueue.length - 1;
  if (latestQueuedIndex >= 0) {
    const item = messageQueue[latestQueuedIndex];
    const itemId = typeof item?.$cid === 'string' ? item.$cid : String(latestQueuedIndex);
    return resolveConfig(item?.acpSessionConfig, `queue:${itemId}`) ?? {};
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.role !== 'user') {
      continue;
    }
    return resolveConfig(entry.inputConfig, `history:${entry.id}`) ?? {};
  }

  return {};
};

/**
 * The MCP selection a restart inherits. The catalog selection is durable only in
 * turn input config, so fork/restore/edit-and-resend must read it back from the
 * conversation rather than from `SessionMeta` — and an absent selection resolves
 * to the explicit empty list every `SessionConfig` carries.
 */
export const resolveSessionMcpSelection = (
  history: readonly { id: string; role: unknown; inputConfig?: unknown }[],
  messageQueue: readonly { $cid?: unknown; acpSessionConfig?: unknown }[] = []
): McpServerId[] => resolveSessionConversationConfig(history, messageQueue).mcpServerIds ?? [];

/** The Task MCP gate frozen by the latest driving Turn. Missing legacy values are disabled. */
export const resolveSessionTaskToolsEnabled = (
  history: readonly { id: string; role: unknown; inputConfig?: unknown }[],
  messageQueue: readonly { $cid?: unknown; acpSessionConfig?: unknown }[] = []
): boolean => resolveSessionConversationConfig(history, messageQueue).taskToolsEnabled === true;

export const resolveSessionScheduleToolsEnabled = (
  history: readonly { id: string; role: unknown; inputConfig?: unknown }[],
  messageQueue: readonly { $cid?: unknown; acpSessionConfig?: unknown }[] = []
): boolean => resolveSessionConversationConfig(history, messageQueue).scheduleToolsEnabled === true;

const normalizeTextInputBlock = (
  block: Extract<SessionInputBlock, { type: 'text' }>
): Extract<SessionInputBlock, { type: 'text' }> | null => {
  const trimmed = block.text.trim();
  if (!trimmed) return null;
  // The trim is what makes this more than a field copy: dropping leading
  // whitespace shifts every offset left, so spans have to be re-anchored
  // against the trimmed string rather than carried across as-is.
  const spans = reanchorMessageTextSpansForTrim(block.text, trimmed, block.spans);
  return spans ? { type: 'text', text: trimmed, spans } : { type: 'text', text: trimmed };
};

const toImagePayload = (
  block:
    | Extract<SessionInputBlock, { type: 'image' }>
    | Extract<SessionInputHistoryItem, { type: 'image' }>
): SessionImagePayload => {
  const fileName = typeof block.fileName === 'string' ? block.fileName : undefined;
  const width = typeof block.width === 'number' ? block.width : undefined;
  const height = typeof block.height === 'number' ? block.height : undefined;
  const storageSessionId =
    typeof block.storageSessionId === 'string' ? block.storageSessionId : undefined;

  return {
    imageId: block.imageId,
    mimeType: block.mimeType,
    fileName,
    sizeBytes: block.sizeBytes,
    width,
    height,
    storageSessionId,
  };
};

const toFilePayload = (
  block:
    | Extract<SessionInputBlock, { type: 'file' }>
    | Extract<SessionInputHistoryItem, { type: 'file' }>
): SessionFilePayload => {
  // transport='local' requires machineId; the runtime validator enforces this,
  // but we still preserve whatever was provided so the pending state can render.
  const machineId = typeof block.machineId === 'string' ? block.machineId : undefined;
  const sourcePath =
    typeof block.sourcePath === 'string' && isSessionFileSourcePath(block.sourcePath)
      ? block.sourcePath
      : undefined;
  const storageSessionId =
    typeof block.storageSessionId === 'string' ? block.storageSessionId : undefined;

  return {
    type: 'file',
    fileId: block.fileId,
    fileName: block.fileName,
    mimeType: block.mimeType,
    sizeBytes: block.sizeBytes,
    sha256: block.sha256,
    textPreview: block.textPreview,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    transport: block.transport,
    ...(machineId === undefined ? {} : { machineId }),
    uploadedAt: block.uploadedAt,
    ...(storageSessionId === undefined ? {} : { storageSessionId }),
  };
};

const isTextHistoryItem = (
  item: unknown
): item is Extract<SessionInputHistoryItem, { type: 'text' }> => {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'text' &&
    'text' in item &&
    typeof item.text === 'string'
  );
};

const isImageHistoryItem = (
  item: unknown
): item is Extract<SessionInputHistoryItem, { type: 'image' }> => {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'image' &&
    'imageId' in item &&
    typeof item.imageId === 'string' &&
    'mimeType' in item &&
    typeof item.mimeType === 'string' &&
    'sizeBytes' in item &&
    typeof item.sizeBytes === 'number'
  );
};

const isFileHistoryItem = (
  item: unknown
): item is Extract<SessionInputHistoryItem, { type: 'file' }> => {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'file' &&
    'fileId' in item &&
    typeof item.fileId === 'string' &&
    'fileName' in item &&
    typeof item.fileName === 'string' &&
    'mimeType' in item &&
    typeof item.mimeType === 'string' &&
    'sizeBytes' in item &&
    typeof item.sizeBytes === 'number' &&
    'sha256' in item &&
    typeof item.sha256 === 'string' &&
    'textPreview' in item &&
    typeof item.textPreview === 'boolean' &&
    'transport' in item &&
    (item.transport === 'r2' || item.transport === 'local') &&
    'uploadedAt' in item &&
    typeof item.uploadedAt === 'number'
  );
};

const isCommentReferenceHistoryItem = (
  item: unknown
): item is { type: 'comment_reference' } & CommentReferencePayload => {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'comment_reference' &&
    'path' in item &&
    typeof item.path === 'string' &&
    'lineNumber' in item &&
    typeof item.lineNumber === 'number' &&
    'commentBody' in item &&
    typeof item.commentBody === 'string'
  );
};

const isVisualAnnotationReferenceHistoryItem = (
  item: unknown
): item is { type: 'visual_annotation_reference' } & VisualAnnotationReferencePayload => {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'visual_annotation_reference' &&
    'source' in item &&
    item.source === 'visual_annotation' &&
    'commentId' in item &&
    typeof item.commentId === 'string' &&
    'body' in item &&
    typeof item.body === 'string' &&
    'anchor' in item &&
    typeof item.anchor === 'object' &&
    item.anchor !== null
  );
};

const toCommentReferencePayload = (
  block: Extract<SessionInputBlock, { type: 'comment_reference' }>
): CommentReferencePayload => ({
  source: block.source,
  path: block.path,
  lineNumber: block.lineNumber,
  side: block.side,
  commentBody: block.commentBody,
  authorName: block.authorName,
  authorImage: block.authorImage,
  replies: block.replies,
  turnId: block.turnId,
  mode: block.mode,
  threadId: block.threadId,
  githubThreadId: block.githubThreadId,
});

const toVisualAnnotationReferencePayload = (
  block: Extract<SessionInputBlock, { type: 'visual_annotation_reference' }>
): VisualAnnotationReferencePayload => ({
  source: block.source,
  commentId: block.commentId,
  turnId: block.turnId,
  body: block.body,
  authorName: block.authorName,
  status: block.status,
  anchor: block.anchor,
});

export const normalizeSessionInputBlocks = (
  inputBlocks: unknown,
  fallbackPrompt: string
): SessionInputBlock[] => {
  const parsedInputBlocks = SessionInputBlocksSchema.safeParse(inputBlocks);
  if (parsedInputBlocks.success && parsedInputBlocks.data.length > 0) {
    const normalized: SessionInputBlock[] = [];
    for (const block of parsedInputBlocks.data) {
      if (block.type === 'text') {
        const normalizedTextBlock = normalizeTextInputBlock(block);
        if (normalizedTextBlock) {
          normalized.push(normalizedTextBlock);
        }
        continue;
      }
      normalized.push(block);
    }
    if (normalized.length > 0) {
      return normalized;
    }
  }

  const trimmedFallback = fallbackPrompt.trim();
  if (!trimmedFallback) {
    return [];
  }
  return [{ type: 'text', text: trimmedFallback }];
};

export const extractPromptPreviewFromInputBlocks = (
  inputBlocks: readonly SessionInputBlock[]
): string => {
  return inputBlocks
    .filter((block): block is Extract<SessionInputBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
};

export const inputBlocksToHistoryItems = (
  inputBlocks: readonly SessionInputBlock[]
): NonNullable<SessionHistoryInput['items']> => {
  const items: NonNullable<SessionHistoryInput['items']> = [];

  for (const block of inputBlocks) {
    if (block.type === 'image') {
      items.push({
        type: 'image',
        text: undefined,
        ...toImagePayload(block),
      } satisfies SessionInputHistoryItem);
      continue;
    }

    if (block.type === 'comment_reference') {
      items.push({
        type: 'comment_reference',
        text: undefined,
        ...toCommentReferencePayload(block),
      } as unknown as SessionInputHistoryItem);
      continue;
    }

    if (block.type === 'visual_annotation_reference') {
      items.push({
        type: 'visual_annotation_reference',
        text: undefined,
        ...toVisualAnnotationReferencePayload(block),
      } as unknown as SessionInputHistoryItem);
      continue;
    }

    if (block.type === 'file') {
      items.push({
        text: undefined,
        ...toFilePayload(block),
      } satisfies SessionInputHistoryItem);
      continue;
    }

    const normalizedTextBlock = normalizeTextInputBlock(block);
    if (normalizedTextBlock) {
      items.push({
        type: 'text',
        text: normalizedTextBlock.text,
        ...(normalizedTextBlock.spans ? { spans: normalizedTextBlock.spans } : {}),
      } satisfies SessionInputHistoryItem);
    }
  }

  return items;
};

export const historyItemsToInputBlocks = (
  items: SessionHistoryInput['items'] | readonly unknown[] | null | undefined
): SessionInputBlock[] => {
  if (!items || items.length === 0) {
    return [];
  }

  const blocks: SessionInputBlock[] = [];

  for (const item of items) {
    if (isTextHistoryItem(item)) {
      // `item` came out of the session document, where spans ride an untyped
      // catchall — whatever wrote them, including an older or newer client,
      // never had its shape checked. Sanitize before anything downstream
      // indexes into the text with these offsets.
      const spans = sanitizeMessageTextSpans(item.text, (item as { spans?: unknown }).spans);
      const normalizedTextBlock = normalizeTextInputBlock({
        type: 'text',
        text: item.text,
        ...(spans ? { spans } : {}),
      });
      if (normalizedTextBlock) {
        blocks.push(normalizedTextBlock);
      }
      continue;
    }

    if (isImageHistoryItem(item)) {
      blocks.push({
        type: 'image',
        ...toImagePayload(item),
      });
      continue;
    }

    if (isFileHistoryItem(item)) {
      blocks.push(toFilePayload(item));
      continue;
    }

    if (isCommentReferenceHistoryItem(item)) {
      const ref = item as { type: 'comment_reference' } & CommentReferencePayload;
      blocks.push({
        type: 'comment_reference',
        source: ref.source,
        path: ref.path,
        lineNumber: ref.lineNumber,
        side: ref.side,
        commentBody: ref.commentBody,
        authorName: ref.authorName,
        authorImage: ref.authorImage,
        replies: ref.replies,
        turnId: ref.turnId,
        mode: ref.mode,
        threadId: ref.threadId,
        githubThreadId: ref.githubThreadId,
      });
      continue;
    }

    if (isVisualAnnotationReferenceHistoryItem(item)) {
      blocks.push({
        type: 'visual_annotation_reference',
        ...toVisualAnnotationReferencePayload(item),
      });
    }
  }

  return blocks;
};

export const buildSessionTurnInputConfig = (args: {
  inputBlocks: readonly SessionInputBlock[];
  cliType: AgentConfigCliType;
  agentType: string;
  modeId?: string | null;
  modelId?: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue> | null;
  mcpServerIds?: readonly McpServerId[] | null;
  taskToolsEnabled?: boolean;
  scheduleToolsEnabled?: boolean;
  issuePRMentions?: IssuePRMention[];
  resume?: ACPSessionConfig['resume'];
  prompt?: string;
}): ACPSessionConfig => {
  const normalizedInputBlocks = normalizeSessionInputBlocks(args.inputBlocks, '');

  return {
    prompt: args.prompt ?? extractPromptPreviewFromInputBlocks(normalizedInputBlocks),
    inputBlocks: normalizedInputBlocks.length > 0 ? normalizedInputBlocks : undefined,
    cliType: args.cliType,
    agentType: args.agentType,
    modeId: args.modeId ?? undefined,
    modelId: args.modelId ?? undefined,
    configOptionValues:
      args.configOptionValues && Object.keys(args.configOptionValues).length > 0
        ? args.configOptionValues
        : undefined,
    mcpServerIds: args.mcpServerIds ? [...args.mcpServerIds] : undefined,
    ...(args.taskToolsEnabled !== undefined
      ? { taskToolsEnabled: args.taskToolsEnabled === true }
      : {}),
    ...(args.scheduleToolsEnabled !== undefined
      ? { scheduleToolsEnabled: args.scheduleToolsEnabled === true }
      : {}),
    issuePRMentions: args.issuePRMentions,
    resume: args.resume,
  };
};

export const buildInitialSessionTurnInputConfig = (args: {
  prompt: string | undefined;
  cliType: string;
  agentType: string;
}): SessionTurnInputConfig | undefined => {
  const cliType = AgentConfigCliTypeSchema.safeParse(args.cliType);
  const agentType = args.agentType.trim();
  const inputBlocks = normalizeSessionInputBlocks(undefined, args.prompt ?? '');

  if (!cliType.success || !agentType || inputBlocks.length === 0) {
    return undefined;
  }

  return buildSessionTurnInputConfig({
    inputBlocks,
    prompt: extractPromptPreviewFromInputBlocks(inputBlocks),
    cliType: cliType.data,
    agentType,
  });
};

export const buildPendingUserHistoryEntry = (args: {
  userId: string | undefined;
  inputBlocks: readonly SessionInputBlock[];
  timestamp: string;
  inputConfig?: SessionTurnInputConfig;
  status?: PendingUserHistoryEntry['status'];
}): PendingUserHistoryEntry | null => {
  const userId = args.userId?.trim();
  if (!userId) {
    return null;
  }

  const items = inputBlocksToHistoryItems(args.inputBlocks);
  if (items.length === 0) {
    return null;
  }

  return {
    userId,
    role: 'user',
    items,
    timestamp: args.timestamp,
    status: args.status ?? 'pending',
    inputConfig: args.inputConfig,
    read: false,
    fileDiff: [],
    finished: true,
  };
};
