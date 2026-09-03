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
import type { AgentRoleId, McpServerId } from './ids';
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
  /** Null is an explicit None; undefined means the selected Turn predates this field. */
  agentRoleId?: AgentRoleId | null;
  agentRoleRevision?: number;
};

type SessionConversationSource = {
  value: unknown;
  configKey: string;
  /** Stable across queue -> history promotion for the same logical Turn. */
  turnKey: string;
};

const collectSessionConversationSources = (
  history: readonly { id: string; role: unknown; inputConfig?: unknown }[],
  messageQueue: readonly {
    $cid?: unknown;
    userTurnId?: unknown;
    acpSessionConfig?: unknown;
  }[] = []
): SessionConversationSource[] => {
  const sources: SessionConversationSource[] = [];
  for (let index = messageQueue.length - 1; index >= 0; index -= 1) {
    const item = messageQueue[index];
    const itemId = typeof item?.$cid === 'string' ? item.$cid : String(index);
    const userTurnId =
      typeof item?.userTurnId === 'string' && item.userTurnId.trim()
        ? item.userTurnId.trim()
        : null;
    sources.push({
      value: item?.acpSessionConfig,
      configKey: `queue:${itemId}`,
      // Matches both renderer-native steer and CLI promotion fallback ids.
      turnKey: `turn:${userTurnId ?? `queued-${itemId}`}`,
    });
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.role !== 'user') continue;
    sources.push({
      value: entry.inputConfig,
      configKey: `history:${entry.id}`,
      turnKey: `turn:${entry.id}`,
    });
  }
  return sources;
};

export type SessionConversationSourceFence = {
  /** Latest logical accepted/queued user Turn. */
  currentTurnKey?: string;
  /** Every logical user Turn visible when a local composer draft is made. */
  knownTurnKeys: string[];
};

/**
 * Causal fence for unsent composer state.
 *
 * A queue row and its promoted history entry share one Turn key. Keeping the
 * whole currently known lineage lets queue deletion/reordering fall back to an
 * older known Turn without pretending that a newer Turn superseded the draft.
 */
export const resolveSessionConversationSourceFence = (
  history: readonly { id: string; role: unknown; inputConfig?: unknown }[],
  messageQueue: readonly {
    $cid?: unknown;
    userTurnId?: unknown;
    acpSessionConfig?: unknown;
  }[] = []
): SessionConversationSourceFence => {
  const sources = collectSessionConversationSources(history, messageQueue);
  return {
    ...(sources[0] ? { currentTurnKey: sources[0].turnKey } : {}),
    knownTurnKeys: [...new Set(sources.map((source) => source.turnKey))],
  };
};

export const resolveSessionConversationConfig = (
  history: readonly { id: string; role: unknown; inputConfig?: unknown }[],
  messageQueue: readonly {
    $cid?: unknown;
    userTurnId?: unknown;
    acpSessionConfig?: unknown;
  }[] = []
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
      ...(inputConfig.agentRoleId !== undefined ? { agentRoleId: inputConfig.agentRoleId } : {}),
      ...(typeof inputConfig.agentRoleId === 'string' && inputConfig.agentRoleRevision !== undefined
        ? { agentRoleRevision: inputConfig.agentRoleRevision }
        : {}),
    };
  };

  const sources = collectSessionConversationSources(history, messageQueue);

  const latest = sources[0];
  if (!latest) return {};
  const resolved = resolveConfig(latest.value, latest.configKey) ?? {};
  if (resolved.agentRoleId !== undefined) return resolved;

  // Role selection is sticky across legacy and non-composer Turn producers
  // that predate this metadata. The first explicit value (including null)
  // wins; the latest source key still fences unsent local composer drafts.
  for (const source of sources.slice(1)) {
    const older = normalizeSessionTurnInputConfig(source.value);
    if (!older || older.agentRoleId === undefined) continue;
    return {
      ...resolved,
      agentRoleId: older.agentRoleId,
      ...(older.agentRoleId !== null && older.agentRoleRevision !== undefined
        ? { agentRoleRevision: older.agentRoleRevision }
        : {}),
    };
  }
  return resolved;
};

const normalizeRuntimeConfigOptionValues = (
  value: unknown
): Record<string, AcpConfigOptionValue> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const normalized: Record<string, AcpConfigOptionValue> = {};
  for (const [configId, optionValue] of Object.entries(value)) {
    if (typeof optionValue === 'string' || typeof optionValue === 'boolean') {
      normalized[configId] = optionValue;
    }
  }
  return normalized;
};

/**
 * Resolves the ACP-reported shared baseline only when it is causally attached
 * to the latest accepted Turn. A queued Turn is already frozen and always wins.
 */
export const resolveSessionAcpRuntimeConfig = (
  history: readonly { id: string; role: unknown }[],
  messageQueue: readonly unknown[] = [],
  snapshot: unknown
): SessionConversationConfig | null => {
  if (messageQueue.length > 0 || !snapshot || typeof snapshot !== 'object') {
    return null;
  }
  const latestUserTurn = [...history].reverse().find((entry) => entry.role === 'user');
  if (!latestUserTurn) {
    return null;
  }

  const value = snapshot as Record<string, unknown>;
  if (
    typeof value.acpSessionId !== 'string' ||
    typeof value.basedOnUserTurnId !== 'string' ||
    value.basedOnUserTurnId !== latestUserTurn.id ||
    typeof value.revision !== 'number' ||
    !Number.isFinite(value.revision)
  ) {
    return null;
  }

  const hasConfigOptionValues = Object.prototype.hasOwnProperty.call(value, 'configOptionValues');
  const configOptionValues = normalizeRuntimeConfigOptionValues(value.configOptionValues);
  return {
    sourceConfigKey: `runtime:${value.acpSessionId}:${value.revision}`,
    ...(typeof value.modeId === 'string' ? { modeId: value.modeId } : {}),
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {}),
    ...(hasConfigOptionValues && configOptionValues ? { configOptionValues } : {}),
  };
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
  /** One-time informed acceptance of a wider permission, for THIS turn only. */
  acceptWiderPermission?: boolean;
  agentRoleId?: AgentRoleId | null;
  agentRoleRevision?: number;
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
    ...(args.acceptWiderPermission === true ? { acceptWiderPermission: true } : {}),
    ...(args.taskToolsEnabled !== undefined
      ? { taskToolsEnabled: args.taskToolsEnabled === true }
      : {}),
    ...(args.agentRoleId !== undefined ? { agentRoleId: args.agentRoleId } : {}),
    ...(typeof args.agentRoleId === 'string' && args.agentRoleRevision !== undefined
      ? { agentRoleRevision: args.agentRoleRevision }
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
