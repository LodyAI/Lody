import type { AgentConfigMeta, SessionMeta, SessionStatus } from './schema';
import { isSessionActiveWithHeartbeat } from './session-status-machine';
import { resolveAgentBrandId, type AgentBrandId } from './agent-brand';
import { getSessionLaunchConfigLegacyFields } from './machine-flock';

export type LiveActivityConversationStatus = 'permission' | 'question' | 'running' | 'unread';
export type LiveActivityAgentLogoKind =
  | 'codex'
  | 'claude'
  | 'deepseek'
  | 'mimo'
  | 'minimax'
  | 'glm'
  | 'agent';

export type LiveActivityConversationItem = {
  id: string;
  status: LiveActivityConversationStatus;
  statusLabel: string;
  permissionRequestId?: string;
  permissionCommand?: string;
  agentLogoKind: LiveActivityAgentLogoKind;
  agentLogoText: string;
  title: string;
  updatedAt: number;
  updatedAtLabel: string;
};

export type LiveActivityStatusCounts = Record<LiveActivityConversationStatus, number>;
export type LiveActivityStatusLabels = Record<LiveActivityConversationStatus, string>;
export type LiveActivityPermissionAlert = {
  title: string;
  body: string;
};
export type LiveActivityPermissionAlertCandidate = {
  key: string;
  sessionTitle: string;
  updatedAt: number;
};

export type BuildLiveActivityConversationItemsOptions = {
  sessions: readonly SessionMeta[];
  agentConfigs?: readonly AgentConfigMeta[];
  currentUserId: string | null | undefined;
  defaultTitle: string;
  statusLabels: LiveActivityStatusLabels;
  formatUpdatedAt: (updatedAt: number) => string;
  maxItems?: number;
  liveSessionStatuses?: ReadonlyMap<string, SessionStatus>;
};

export type LodyConversationsLiveActivityIdOptions = {
  workspaceId: string;
  userId: string;
  schemaVersion: number;
};

const DEFAULT_MAX_ITEMS = 8;
export const LODY_CONVERSATIONS_LIVE_ACTIVITY_SCHEMA_VERSION = 5;
const STATUS_PRIORITY: Record<LiveActivityConversationStatus, number> = {
  question: 0,
  permission: 1,
  running: 2,
  unread: 3,
};

export function buildLodyConversationsLiveActivityId({
  workspaceId,
  userId,
  schemaVersion,
}: LodyConversationsLiveActivityIdOptions): string {
  return `lody-conversations:v${schemaVersion}:${workspaceId}:${userId}`;
}

function parseTimestamp(value: number | string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function resolveStatus(
  session: SessionMeta,
  liveSessionStatuses?: ReadonlyMap<string, SessionStatus>
): LiveActivityConversationStatus | null {
  const liveStatus = liveSessionStatuses?.get(session.id);
  if (liveSessionStatuses) {
    if (liveStatus?.type === 'requestPermission') {
      return 'permission';
    }
    if (liveStatus != null) {
      return 'running';
    }
  } else {
    const isHeartbeatActive = isSessionActiveWithHeartbeat(session.status, session.lastRunningSeen);
    if (session.status?.type === 'requestPermission') {
      return isHeartbeatActive ? 'permission' : null;
    }
    if (isHeartbeatActive) {
      return 'running';
    }
  }

  const lastMessageAt = parseTimestamp(session.lastMessageAt);
  if (lastMessageAt === null) return null;
  const lastReadAt = parseTimestamp(session.lastReadAt);
  return lastReadAt === null || lastMessageAt > lastReadAt ? 'unread' : null;
}

function resolveUpdatedAt(session: SessionMeta): number {
  return parseTimestamp(session.lastMessageAt) ?? parseTimestamp(session.createdAt) ?? 0;
}

/** Two-letter logo abbreviation per brand; keep exhaustive over AgentBrandId. */
const BRAND_LOGO_ABBR: Record<AgentBrandId, string> = {
  deepseek: 'DS',
  mimo: 'MI',
  minimax: 'MM',
  glm: 'GL',
};

function resolveAgentLogoText(
  session: SessionMeta,
  agentConfig: AgentConfigMeta | undefined
): string {
  const brandId = resolveAgentBrandId({
    brandId: agentConfig?.brandId,
    env: agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env,
  });

  if (brandId) return BRAND_LOGO_ABBR[brandId];
  if (session.cliType === 'builtin' && session.agentType === 'codex') return 'CX';
  if (session.cliType === 'builtin' && session.agentType === 'claude') return 'CC';
  if (session.cliType === 'registry' && session.agentType === 'claude-p') return 'IC';

  const source =
    normalizeText(agentConfig?.name) ||
    normalizeText(session.agentType) ||
    normalizeText(session.cliType) ||
    'ACP';
  const letters = source
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return letters || 'ACP';
}

function resolveAgentLogoKind(
  session: SessionMeta,
  agentConfig: AgentConfigMeta | undefined
): LiveActivityAgentLogoKind {
  const brandId = resolveAgentBrandId({
    brandId: agentConfig?.brandId,
    env: agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env,
  });

  // Every brand id is itself a valid logo kind (enforced by LiveActivityAgentLogoKind).
  if (brandId) return brandId;
  if (session.cliType === 'builtin' && session.agentType === 'codex') return 'codex';
  if (session.cliType === 'builtin' && session.agentType === 'claude') return 'claude';
  if (session.cliType === 'registry' && session.agentType === 'claude-p') return 'claude';
  return 'agent';
}

export function buildLiveActivityConversationItems({
  sessions,
  agentConfigs = [],
  currentUserId,
  defaultTitle,
  statusLabels,
  formatUpdatedAt,
  maxItems = DEFAULT_MAX_ITEMS,
  liveSessionStatuses,
}: BuildLiveActivityConversationItemsOptions): LiveActivityConversationItem[] {
  if (!currentUserId || maxItems <= 0) {
    return [];
  }

  const agentConfigsById = new Map(agentConfigs.map((config) => [config.id, config]));
  return sessions
    .filter((session) => !session.isArchived && session.userId === currentUserId)
    .map((session) => {
      const status = resolveStatus(session, liveSessionStatuses);
      if (!status) return null;
      const updatedAt = resolveUpdatedAt(session);
      const agentConfig = session.agentConfigId
        ? agentConfigsById.get(session.agentConfigId)
        : undefined;
      const item: LiveActivityConversationItem = {
        id: String(session.id),
        status,
        statusLabel: statusLabels[status],
        agentLogoKind: resolveAgentLogoKind(session, agentConfig),
        agentLogoText: truncateText(resolveAgentLogoText(session, agentConfig), 3),
        title: truncateText(normalizeText(session.title) || defaultTitle, 96),
        updatedAt,
        updatedAtLabel: formatUpdatedAt(updatedAt),
      };
      return item;
    })
    .filter((item): item is LiveActivityConversationItem => item !== null)
    .sort((a, b) => {
      const priorityDelta = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
      if (priorityDelta !== 0) return priorityDelta;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, maxItems);
}

export function countLiveActivityConversationCandidates({
  sessions,
  currentUserId,
  liveSessionStatuses,
}: {
  sessions: readonly SessionMeta[];
  currentUserId: string | null | undefined;
  liveSessionStatuses?: ReadonlyMap<string, SessionStatus>;
}): number {
  if (!currentUserId) return 0;
  let count = 0;
  for (const session of sessions) {
    if (session.isArchived || session.userId !== currentUserId) continue;
    if (resolveStatus(session, liveSessionStatuses)) count += 1;
  }
  return count;
}

export function countLiveActivityConversationStatuses({
  sessions,
  currentUserId,
  liveSessionStatuses,
}: {
  sessions: readonly SessionMeta[];
  currentUserId: string | null | undefined;
  liveSessionStatuses?: ReadonlyMap<string, SessionStatus>;
}): LiveActivityStatusCounts {
  const counts: LiveActivityStatusCounts = {
    permission: 0,
    question: 0,
    running: 0,
    unread: 0,
  };
  if (!currentUserId) return counts;

  for (const session of sessions) {
    if (session.isArchived || session.userId !== currentUserId) continue;
    const status = resolveStatus(session, liveSessionStatuses);
    if (status) counts[status] += 1;
  }

  return counts;
}

export function findLiveActivityPermissionAlertCandidate({
  sessions,
  currentUserId,
  defaultTitle,
  liveSessionStatuses,
}: {
  sessions: readonly SessionMeta[];
  currentUserId: string | null | undefined;
  defaultTitle: string;
  liveSessionStatuses?: ReadonlyMap<string, SessionStatus>;
}): LiveActivityPermissionAlertCandidate | null {
  if (!currentUserId) return null;

  let candidate: LiveActivityPermissionAlertCandidate | null = null;
  for (const session of sessions) {
    if (session.isArchived || session.userId !== currentUserId) continue;
    if (liveSessionStatuses) {
      if (liveSessionStatuses.get(session.id)?.type !== 'requestPermission') {
        continue;
      }
    } else {
      if (
        session.status?.type !== 'requestPermission' ||
        !isSessionActiveWithHeartbeat(session.status, session.lastRunningSeen)
      ) {
        continue;
      }
    }

    const updatedAt = resolveUpdatedAt(session);
    const key = `${session.id}:${updatedAt}`;
    const sessionTitle = truncateText(normalizeText(session.title) || defaultTitle, 96);
    if (!candidate || updatedAt > candidate.updatedAt) {
      candidate = { key, sessionTitle, updatedAt };
    }
  }

  return candidate;
}
