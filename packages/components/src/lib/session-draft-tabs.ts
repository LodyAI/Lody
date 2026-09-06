import type {
  AcpConfigOptionValue,
  AgentConfigMeta,
  AgentConfigCliType,
  AgentConfigId,
  AgentRole,
  AgentRoleId,
  SessionId,
} from '@lody/shared';
import { isValidSessionImagePathSegment, SessionIdSchema } from '@lody/shared';
import { z } from 'zod';

const DRAFT_TAB_PREFIX = 'draft:';
const configOptionValueSchema = z.union([z.string(), z.boolean()]);

const draftSessionTabSchema = z.object({
  id: z.string().startsWith(DRAFT_TAB_PREFIX),
  sessionId: z.string().optional(),
  prompt: z.string(),
  agentConfigId: z.string().optional(),
  agentRoleId: z.string().optional(),
  cliType: z.enum(['builtin', 'registry', 'custom']),
  agentType: z.string(),
  modeId: z.string().nullable(),
  modelId: z.string().nullable(),
  configOptionValues: z.record(z.string(), configOptionValueSchema).optional(),
});
const diffCommentFocusTargetSchema = z.object({
  source: z.enum(['lody', 'github']),
  path: z.string(),
  lineNumber: z.number().int(),
  side: z.enum(['additions', 'deletions']),
  threadId: z.string().optional(),
  githubThreadId: z.number().int().optional(),
});
const persistedViewerTabSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('file'),
    filePath: z.string(),
    fileId: z.string().optional(),
    label: z.string(),
    startLine: z.number().int().optional(),
    endLine: z.number().int().optional(),
    focusRequestSeq: z.number().int().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('diff'),
    turnId: z.string(),
    filePaths: z.array(z.string()),
    focusFilePath: z.string().nullable(),
    focusComment: diffCommentFocusTargetSchema.nullable().optional(),
    focusRequestSeq: z.number().int(),
    mode: z.enum(['conversation', 'base']).optional(),
    label: z.string(),
  }),
]);
const persistedSidePanelTabSchema = z.enum(['files', 'changes', 'pr', 'browser']);
const persistedSidePanelStateSchema = z
  .object({
    open: z.boolean(),
    tab: persistedSidePanelTabSchema.nullable().default(null),
    tabs: z.array(persistedSidePanelTabSchema).default([]),
    sideSessionId: SessionIdSchema.nullable().default(null),
  })
  .transform((state) => {
    const tabs = [...new Set(state.tabs)];
    return {
      ...state,
      tabs,
      // States written before functional side-panel tabs became opt-in only
      // stored the selected tab. Treat those sessions as unopened so the new
      // empty state is the first thing users see.
      tab: state.tab && tabs.includes(state.tab) ? state.tab : null,
    };
  });
const persistedLastActiveTabStateSchema = z.object({
  sessionTabId: z.string(),
  viewerTab: persistedViewerTabSchema.nullable(),
  sidePanel: persistedSidePanelStateSchema.optional(),
});

export type DraftSessionTabId = `${typeof DRAFT_TAB_PREFIX}${string}`;
export type DraftSessionTab = {
  id: DraftSessionTabId;
  sessionId: SessionId;
  prompt: string;
  agentConfigId?: AgentConfigId;
  /** Role preference for this not-yet-created Session. */
  agentRoleId?: AgentRoleId;
  cliType: AgentConfigCliType;
  agentType: string;
  modeId: string | null;
  modelId: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};
export type PersistedViewerTab = z.infer<typeof persistedViewerTabSchema>;
export type PersistedSidePanelTab = z.infer<typeof persistedSidePanelTabSchema>;
export type PersistedSidePanelState = z.infer<typeof persistedSidePanelStateSchema>;
export type PersistedLastActiveTabState = z.infer<typeof persistedLastActiveTabStateSchema>;
type ParsedDraftSessionTab = z.infer<typeof draftSessionTabSchema>;

const createRandomId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const createDraftSessionId = (): SessionId => createRandomId() as SessionId;

const normalizeParsedDraftSessionTab = (draft: ParsedDraftSessionTab): DraftSessionTab => {
  const sessionId = isValidSessionImagePathSegment(draft.sessionId ?? '')
    ? (draft.sessionId as SessionId)
    : createDraftSessionId();
  return {
    ...draft,
    sessionId,
  } as DraftSessionTab;
};

const parseStoredDraftTabs = (raw: string | null): DraftSessionTab[] => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = draftSessionTabSchema.array().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.map(normalizeParsedDraftSessionTab) : [];
  } catch {
    return [];
  }
};

const getDraftTabsStorageKey = (parentSessionId: SessionId): string =>
  `lody:draft-tabs:${parentSessionId}`;

const getTabOrderStorageKey = (parentSessionId: SessionId): string =>
  `lody:tab-order:${parentSessionId}`;
const getLastActiveTabStorageKey = (parentSessionId: SessionId): string =>
  `lody:last-active-tab:${parentSessionId}`;

export const isDraftSessionTabId = (value: string): value is DraftSessionTabId =>
  typeof value === 'string' && value.startsWith(DRAFT_TAB_PREFIX);

export const createDraftSessionTab = (options: {
  agentConfigId?: AgentConfigId;
  cliType: AgentConfigCliType;
  agentType: string;
  modeId: string | null;
  modelId: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
}): DraftSessionTab => {
  return {
    id: `${DRAFT_TAB_PREFIX}${createRandomId()}` as DraftSessionTabId,
    sessionId: createDraftSessionId(),
    prompt: '',
    agentConfigId: options.agentConfigId,
    cliType: options.cliType,
    agentType: options.agentType,
    modeId: options.modeId,
    modelId: options.modelId,
    configOptionValues: options.configOptionValues,
  };
};

/**
 * Apply a Role as a complete new-Session preference to a child-tab draft.
 *
 * A draft tab has not created its Session yet, so unlike an existing Session it
 * may move to the Role's bound Agent Config. Unpinned run-config fields are
 * cleared here so the selected agent's defaults can fill them during the normal
 * ACP reconcile pass; retaining values from the previous agent would make the
 * footer claim the Role while dispatching unrelated settings.
 */
export const buildDraftSessionAgentRolePatch = (
  role: AgentRole,
  agentConfig: AgentConfigMeta
): Partial<DraftSessionTab> | null => {
  if (agentConfig.id !== role.agentConfigId || agentConfig.machineId !== role.machineId) {
    return null;
  }
  return {
    agentRoleId: role.id,
    agentConfigId: agentConfig.id,
    cliType: agentConfig.cliType,
    agentType: agentConfig.agentType,
    modeId: role.runConfig.modeId ?? null,
    modelId: role.runConfig.modelId ?? null,
    configOptionValues: role.runConfig.configOptionValues,
  };
};

export const getDraftTabLabel = (
  draft: Pick<DraftSessionTab, 'prompt'>,
  fallback = 'New Tab'
): string => {
  const firstLine = draft.prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? fallback;
};

export const readPersistedDraftTabs = (parentSessionId: SessionId): DraftSessionTab[] => {
  if (typeof window === 'undefined') {
    return [];
  }
  return parseStoredDraftTabs(localStorage.getItem(getDraftTabsStorageKey(parentSessionId)));
};

export const writePersistedDraftTabs = (
  parentSessionId: SessionId,
  draftTabs: DraftSessionTab[]
): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const persistedDraftTabs = draftTabs.filter((draft) => draft.prompt.length > 0);
    localStorage.setItem(
      getDraftTabsStorageKey(parentSessionId),
      JSON.stringify(persistedDraftTabs)
    );
  } catch {
    // ignore
  }
};

export const readStoredTabOrder = (parentSessionId: SessionId): string[] => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = localStorage.getItem(getTabOrderStorageKey(parentSessionId));
    if (!raw) {
      return [];
    }
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

export const writeStoredTabOrder = (parentSessionId: SessionId, tabOrder: string[]): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(getTabOrderStorageKey(parentSessionId), JSON.stringify(tabOrder));
  } catch {
    // ignore
  }
};

export const readStoredLastActiveTabState = (
  parentSessionId: SessionId
): PersistedLastActiveTabState | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(getLastActiveTabStorageKey(parentSessionId));
    if (!raw) {
      return null;
    }
    const parsed = persistedLastActiveTabStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const writeStoredLastActiveTabState = (
  parentSessionId: SessionId,
  state: PersistedLastActiveTabState
): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(getLastActiveTabStorageKey(parentSessionId), JSON.stringify(state));
  } catch {
    // ignore
  }
};

export const replaceTabOrderId = (
  tabOrder: string[],
  currentId: string,
  nextId: string
): string[] => {
  if (currentId === nextId) {
    return tabOrder;
  }
  if (tabOrder.includes(nextId)) {
    return tabOrder.filter((id) => id !== currentId);
  }
  const nextOrder = tabOrder.map((id) => (id === currentId ? nextId : id));
  return nextOrder.includes(nextId) ? nextOrder : [...nextOrder, nextId];
};

/** Adds a tab after the currently displayed fallback tabs without disturbing saved order. */
export const appendTabOrderId = (
  tabOrder: string[],
  displayedTabIds: Iterable<string>,
  nextId: string
): string[] => {
  const nextOrder = [...tabOrder];
  const seen = new Set(nextOrder);

  for (const id of displayedTabIds) {
    if (!seen.has(id)) {
      nextOrder.push(id);
      seen.add(id);
    }
  }
  if (!seen.has(nextId)) {
    nextOrder.push(nextId);
  }

  return nextOrder;
};

export const removeTabOrderId = (tabOrder: string[], targetId: string): string[] =>
  tabOrder.filter((id) => id !== targetId);

export const filterPendingPromotedChildSessions = <T extends { id: string }>(
  childSessions: T[],
  draftTabs: DraftSessionTab[],
  pendingDraftChildSessionIds: Partial<Record<DraftSessionTab['id'], string>>
): T[] => {
  const draftIds = new Set(draftTabs.map((draft) => draft.id));
  const pendingChildIds = new Set(
    Object.entries(pendingDraftChildSessionIds)
      .filter(([draftId]) => draftIds.has(draftId as DraftSessionTab['id']))
      .map(([, childSessionId]) => childSessionId)
      .filter((childSessionId): childSessionId is string => typeof childSessionId === 'string')
  );

  if (pendingChildIds.size === 0) {
    return childSessions;
  }

  return childSessions.filter((session) => !pendingChildIds.has(session.id));
};

export const mergeTabOrderGroup = (
  tabOrder: string[],
  orderedGroupIds: string[],
  groupIds: Iterable<string>
): string[] => {
  const groupIdSet = new Set(groupIds);
  const seen = new Set<string>();
  const nextGroupOrder: string[] = [];

  for (const id of orderedGroupIds) {
    if (!groupIdSet.has(id) || seen.has(id)) {
      continue;
    }
    nextGroupOrder.push(id);
    seen.add(id);
  }

  const leftoverGroupIds = tabOrder.filter((id) => groupIdSet.has(id) && !seen.has(id));
  const remainingIds = tabOrder.filter((id) => !groupIdSet.has(id));

  return [...nextGroupOrder, ...leftoverGroupIds, ...remainingIds];
};
