import { CliType } from './ai';
import type { AgentConfigId, MachineId, SessionId, TaskId, WorkspaceId } from './ids';
import { PREVIEW_COMMENT_DOC_PREFIX, getLoroPreviewCommentStreamId } from './preview-comment-types';
import { TASK_DOC_PREFIX, getLoroTaskStreamId } from './task-types';
import type { StreamsCrdtShardUrlsOptions } from '@loro-dev/streams-crdt';

export type {
  AbsolutePath,
  AgentConfigId,
  BindingId,
  ClientId,
  MachineId,
  RepoId,
  ReviewRunId,
  SessionId,
  TaskId,
  WorkspaceId,
} from './ids';
export * from './message';
export * from './ai';
export * from './acp-run-config';
export * from './image-file-types';
export * from './custom-acp-command';
export * from './session-image';
export * from './task-image';
export * from './avatar';
export * from './community';
export * from './session-file';
export * from './session-file-text';
export * from './incremental-sha256';
export * from './bug-report';
export * from './billing';
export * from './agent-brand';
export * from './agent-authentication';
export * from './schema';
export * from './cron-next-fire';
export * from './scheduled-tasks-from-history';
export * from './project';
export * from './time-sync';
export * from './session-status-machine';
export * from './session-orchestration';
export * from './electron-ipc';
export * from './loro-server-auth';
export * from './auth';
export * from './message-schemas';
export * from './acp/registry-generated';
export * from './acp/codex-raw';
export * from './acp/claude-code-raw';
export * from './acp/claude-subagent-task';
export * from './acp/codex-collab-agent-task';
export * from './acp/schema';
export * from './acp/tool-call-history';
export * from './acp/history-apply';
export * from './acp/history-replay-import';
export * from './acp/ask-user-question';
export * from './acp/skills';
export * from './replay-prompt-builder';
export * from './conversation-markdown';
export * from './reliable-message';
export * from './worktree-paths';
export * from './loro-streams-auth';
export * from './rpc-secret';
export * from './streams-snapshot-codec';
export * from './presence';
export * from './machine-monitor';
export * from './repo-doc-meta';
export * from './session-input';
export * from './session-preparation';
export * from './session-bootstrap';
export * from './session-delete-queue';
export * from './goal';
export * from './comment-reference-format';
export * from './session-comment-types';
export * from './preview-comment-types';
export * from './preview-comment-schema';
export * from './task-types';
export * from './task-schema';
export * from './task-index';
export * from './task-order';
export * from './review';
export * from './review-prompts';
export * from './preview-comment-mutation';
export * from './account-data';
export * from './visual-annotation-types';
export * from './visual-annotation-injected-script';
export * from './github-api';
export * from './github-url';
export * from './filtered-diff-files';
export * from './cli-api-key';
export * from './machine-pairing';
export * from './preview';
export * from './browser-url';
export * from './workspace-slugs';
export * from './workspace-route';
export * from './layout';
export * from './code-collab';
export * from './file-preview';
export * from './machine-flock';
export * from './local-machine-rpc';
export * from './local-loro-data-plane';
export * from './local-loro-data-plane-server';
export * from './local-loro-data-plane-scheduler';
export * from './local-loro-transport';
export * from './json-guards';
export * from './password-validation';
export * from './in-flight-dedupe';
export * from './analytics';
export * from './live-activity-summary';
export * from './live-activity-permission-action';
export * from './convex-site-url';
export * from './terminal-protocol';
export type { WebSocketMessage } from './message';

export const LORO_STREAMS_BUCKET_ID = 'lody';
// Inert compatibility origins used only by migration helpers and tests. Public
// builds have no hosted Streams topology; a real gateway must be injected.
export const LEGACY_LORO_STREAMS_BASE_URL = 'https://legacy.streams.invalid';
export const DEFAULT_LORO_STREAMS_BASE_URL = 'https://streams.invalid';
export const DEFAULT_LORO_STREAMS_PRESENCE_BASE_URL = 'https://presence.streams.invalid';
export const DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX = 'streams.invalid';
export const LORO_STREAMS_REMOTE_CURSOR_HISTORICAL_ALIAS_BASE_URLS = [
  'https://previous.streams.invalid',
  LEGACY_LORO_STREAMS_BASE_URL,
] as const;
export const LORO_STREAMS_LARGE_POST_SHARD_MIN_BYTES = 64 * 1024;
export const LORO_META_STREAM_SUFFIX = 'meta';
export const LORO_SESSION_STREAM_SEGMENT = 's';
export const LORO_CODE_COLLAB_FILE_INDEX_STREAM_SEGMENT = 'fi';
export const LORO_CODE_COLLAB_FILE_INDEX_SIGNAL_STREAM_SEGMENT = 'fis';
export const CODE_COLLAB_FILE_INDEX_FLOCK_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const LORO_STREAMS_CONTROL_SHARD_IDS = ['a', 'b', 'c'] as const;
const LORO_STREAMS_OTHER_SHARD_IDS = ['a', 'b'] as const;
const LORO_STREAMS_WRITE_SHARD_IDS = ['a', 'b', 'c', 'd'] as const;

export const getLoroStreamsBaseUrl = (baseUrl?: string | null): string => {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    throw new Error('Loro Streams base URL must be provided by the platform adapter');
  }
  return trimmed.replace(/\/+$/g, '');
};

// Hosted adapters may route ephemeral traffic to a separate host. Browsers cap simultaneous connections per
// host (Firefox defaults to ~6), so opening Lody in several tabs can exhaust that
// budget and stall presence connections. Spreading presence across sibling
// subdomains gives each tab its own per-host budget. These inert suffixes preserve
// the protocol helper contract without publishing a hosted deployment topology.
export const LORO_STREAMS_PRESENCE_SHARD_IDS = [
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
  '21',
  '22',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '29',
  '30',
  '31',
  '32',
] as const;

export type LoroStreamsPresenceShardId = (typeof LORO_STREAMS_PRESENCE_SHARD_IDS)[number];

export const isLoroStreamsPresenceShardId = (
  value: string | null | undefined
): value is LoroStreamsPresenceShardId =>
  value != null && (LORO_STREAMS_PRESENCE_SHARD_IDS as readonly string[]).includes(value);

/**
 * Pick a presence shard id at random. Call once per browser tab so each tab gets
 * its own presence subdomain — and thus its own per-host connection budget —
 * reducing the chance multiple tabs pile onto one host and stall.
 */
export const pickLoroStreamsPresenceShardId = (): LoroStreamsPresenceShardId => {
  const index = Math.floor(Math.random() * LORO_STREAMS_PRESENCE_SHARD_IDS.length);
  return LORO_STREAMS_PRESENCE_SHARD_IDS[index] ?? LORO_STREAMS_PRESENCE_SHARD_IDS[0];
};

export const getLoroStreamsPresenceBaseUrl = (
  baseUrl?: string | null,
  shardId?: LoroStreamsPresenceShardId | string | null
): string => {
  const normalized = getLoroStreamsBaseUrl(baseUrl);
  try {
    const url = new URL(normalized);
    if (url.origin !== new URL(DEFAULT_LORO_STREAMS_BASE_URL).origin) {
      return normalized;
    }
    const presence = new URL(DEFAULT_LORO_STREAMS_PRESENCE_BASE_URL);
    url.protocol = presence.protocol;
    // Only sharded subdomains we control; anything else falls back to the
    // canonical presence host so a bad id can never produce a stray origin.
    url.host = isLoroStreamsPresenceShardId(shardId)
      ? `presence-${shardId}.${DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX}`
      : presence.host;
    return url.toString().replace(/\/+$/g, '');
  } catch {
    return normalized;
  }
};

const getLoroStreamsShardOrigin = (trafficClass: string, shardId: string): string =>
  `https://${trafficClass}-${shardId}.${DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX}`;

export const getLoroStreamsShardUrls = (
  baseUrl?: string | null
): StreamsCrdtShardUrlsOptions | undefined => {
  let origin: string;
  try {
    origin = new URL(getLoroStreamsBaseUrl(baseUrl)).origin;
  } catch {
    return undefined;
  }
  if (origin !== new URL(DEFAULT_LORO_STREAMS_BASE_URL).origin) {
    return undefined;
  }
  return {
    bootstrap: LORO_STREAMS_CONTROL_SHARD_IDS.map((id) => getLoroStreamsShardOrigin('control', id)),
    catchup: LORO_STREAMS_CONTROL_SHARD_IDS.map((id) => getLoroStreamsShardOrigin('control', id)),
    largePost: LORO_STREAMS_WRITE_SHARD_IDS.map((id) => getLoroStreamsShardOrigin('write', id)),
    other: LORO_STREAMS_OTHER_SHARD_IDS.map((id) => getLoroStreamsShardOrigin('api', id)),
    largePostMinBytes: LORO_STREAMS_LARGE_POST_SHARD_MIN_BYTES,
  };
};

export const getLoroStreamsRemoteCursorUrlAliases = (streamUrl: string): string[] => {
  try {
    const url = new URL(streamUrl);
    const defaultOrigin = new URL(DEFAULT_LORO_STREAMS_BASE_URL).origin;
    const aliasOrigins = [
      defaultOrigin,
      ...LORO_STREAMS_REMOTE_CURSOR_HISTORICAL_ALIAS_BASE_URLS.map(
        (baseUrl) => new URL(baseUrl).origin
      ),
    ];
    if (!aliasOrigins.includes(url.origin)) {
      return [];
    }

    return aliasOrigins
      .filter((origin) => origin !== url.origin)
      .map((origin) => {
        const alias = new URL(url);
        const aliasOrigin = new URL(origin);
        alias.protocol = aliasOrigin.protocol;
        alias.host = aliasOrigin.host;
        return alias.toString();
      });
  } catch {
    return [];
  }
};

export const SUPPORTED_CLI_TYPES: CliType[] = ['kimi', 'grok', 'claude', 'codex'];
export type SupportedLanguage = 'en' | 'zh_CN';
export const AGENT_CONFIG_DOC_PREFIX = 'agent-';
export const SESSION_DOC_PREFIX = 'session-';
// Compatibility tombstone: session comment docs were removed in 2026, but their
// persisted room ids still share the session prefix and must never be projected
// as sessions.
const LEGACY_SESSION_COMMENT_DOC_PREFIX = 'session-comment-';
export const MACHINE_DOC_PREFIX = 'machine-';
export const getAgentConfigRoomId = (agentConfigId: AgentConfigId) =>
  `${AGENT_CONFIG_DOC_PREFIX}${agentConfigId}`;
export const getSessionRoomId = (sessionId: SessionId) => `${SESSION_DOC_PREFIX}${sessionId}`;
export const getMachineRoomId = (id: MachineId) => `${MACHINE_DOC_PREFIX}${id}`;
export const getLoroMetaStreamId = (workspaceId: WorkspaceId) =>
  `${workspaceId}:${LORO_META_STREAM_SUFFIX}`;
export const getLoroSessionStreamId = (workspaceId: WorkspaceId, sessionId: SessionId) =>
  `${workspaceId}:${LORO_SESSION_STREAM_SEGMENT}:${sessionId}`;
export const getCodeCollabFileIndexFlockDocId = (
  workspaceId: WorkspaceId,
  masterSessionId: SessionId
) => `${workspaceId}:${LORO_CODE_COLLAB_FILE_INDEX_STREAM_SEGMENT}:${masterSessionId}`;
export const isCodeCollabFileIndexFlockDocId = (value: string): boolean => {
  const parts = value.split(':');
  return parts.length === 3 && parts[1] === LORO_CODE_COLLAB_FILE_INDEX_STREAM_SEGMENT;
};
export const getCodeCollabFileIndexSignalFlockDocId = (
  workspaceId: WorkspaceId,
  masterSessionId: SessionId
) => `${workspaceId}:${LORO_CODE_COLLAB_FILE_INDEX_SIGNAL_STREAM_SEGMENT}:${masterSessionId}`;
export const isCodeCollabFileIndexSignalFlockDocId = (value: string): boolean => {
  const parts = value.split(':');
  return parts.length === 3 && parts[1] === LORO_CODE_COLLAB_FILE_INDEX_SIGNAL_STREAM_SEGMENT;
};
export const getLoroStreamIdForDocId = (workspaceId: WorkspaceId, docId: string): string => {
  if (docId.startsWith(PREVIEW_COMMENT_DOC_PREFIX)) {
    return getLoroPreviewCommentStreamId(
      workspaceId,
      docId.slice(PREVIEW_COMMENT_DOC_PREFIX.length) as SessionId
    );
  }
  if (docId.startsWith(LEGACY_SESSION_COMMENT_DOC_PREFIX)) {
    return docId;
  }
  if (docId.startsWith(SESSION_DOC_PREFIX)) {
    return getLoroSessionStreamId(workspaceId, docId.slice(SESSION_DOC_PREFIX.length) as SessionId);
  }
  if (docId.startsWith(TASK_DOC_PREFIX)) {
    return getLoroTaskStreamId(workspaceId, docId.slice(TASK_DOC_PREFIX.length) as TaskId);
  }
  return docId;
};
export const isAgentConfigDocRoomId = (roomId: string) =>
  roomId.startsWith(AGENT_CONFIG_DOC_PREFIX);
export const isSessionDocRoomId = (roomId: string) =>
  roomId.startsWith(SESSION_DOC_PREFIX) &&
  !roomId.startsWith(LEGACY_SESSION_COMMENT_DOC_PREFIX) &&
  roomId.length > SESSION_DOC_PREFIX.length;
export const getSessionIdFromRoomId = (roomId: string): SessionId | null =>
  isSessionDocRoomId(roomId) ? (roomId.slice(SESSION_DOC_PREFIX.length) as SessionId) : null;
export const isMachineDocRoomId = (roomId: string) => roomId.startsWith(MACHINE_DOC_PREFIX);

export type FileTreeItem = {
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeItem[];
  modified?: boolean;
  lazyDirectoryId?: string;
};

export interface GeneralSettings {
  language: SupportedLanguage;
}

export interface Organization {
  id: WorkspaceId;
  name: string;
  slug: string;
  createdAt: Date;
  logo?: string;
}

// User Types
export type User = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  image?: string;
};

export type OrganizationMember = Pick<User, 'id' | 'email' | 'image' | 'name'>;

// Attachment Types
export interface Attachment {
  id: string;
  name: string;
  url: string;
  type: string;
  size: number;
  uploadedAt: Date;
  uploadedBy: User;
}
