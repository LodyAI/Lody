/**
 * Loro Streams routing: bucket, shard and stream-URL helpers plus the room/stream
 * ids of every workspace document. Lives outside the package barrel so a bundle
 * can import these helpers without reaching every module the barrel re-exports.
 *
 * Every workspace-owned stream ID must start with `{workspaceId}:` (before any
 * feature discriminator) so Loro Streams attributes it to `space_id = workspaceId`
 * across buckets. See `.agents/docs/loro-streams-user-space.md`.
 */
import {
  LORO_CODE_COLLAB_FILE_INDEX_STREAM_SEGMENT,
  LORO_CODE_COLLAB_FILE_INDEX_SIGNAL_STREAM_SEGMENT,
} from './code-collab-rooms';
import { CliType } from './ai';
import type { AgentConfigId, MachineId, SessionId, TaskId, WorkspaceId } from './ids';
import { PREVIEW_COMMENT_DOC_PREFIX, getLoroPreviewCommentStreamId } from './preview-comment-types';
import { TASK_DOC_PREFIX, getLoroTaskStreamId } from './task-types';
import { getLoroTodayStreamId, parseTodayDocId } from './today-types';
import { SCHEDULE_DOC_PREFIX, getLoroScheduleStreamId } from './schedule-registry';
import type { StreamsCrdtShardUrlsOptions } from '@loro-dev/streams-crdt';

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
export {
  LORO_CODE_COLLAB_FILE_INDEX_STREAM_SEGMENT,
  LORO_CODE_COLLAB_FILE_INDEX_SIGNAL_STREAM_SEGMENT,
} from './code-collab-rooms';
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

// A bare DNS name: dot-separated labels, no scheme/port/path. Anything else is
// rejected so a hostile or malformed token response can never steer sharded
// traffic to a stray origin.
const LORO_STREAMS_SHARD_HOST_SUFFIX_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Validate a runtime-injected shard host suffix (the hosted deployment's
 * topology, e.g. delivered in the token-mint response). Returns the normalized
 * suffix, or `undefined` when absent/invalid — callers then fall back to
 * unsharded traffic on the gateway origin.
 */
export const normalizeLoroStreamsShardHostSuffix = (value?: string | null): string | undefined => {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return LORO_STREAMS_SHARD_HOST_SUFFIX_PATTERN.test(trimmed) ? trimmed : undefined;
};

// Hosted adapters may route ephemeral traffic to a separate host. Browsers cap simultaneous connections per
// host (Firefox defaults to ~6), so opening Lody in several tabs can exhaust that
// budget and stall presence connections. Spreading presence across sibling
// subdomains gives each tab its own per-host budget. These inert suffixes preserve
// the protocol helper contract without publishing a hosted deployment topology;
// hosted deployments deliver their real suffix at runtime in the token-mint
// response (`shardHostSuffix`), which the URL helpers below accept explicitly.
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
  shardId?: LoroStreamsPresenceShardId | string | null,
  shardHostSuffix?: string | null
): string => {
  const normalized = getLoroStreamsBaseUrl(baseUrl);
  try {
    const url = new URL(normalized);
    // A runtime-injected topology (hosted deployments deliver it with the
    // Streams token) wins over the inert compile-time sentinel: presence gets
    // its own host (and per-tab shard) regardless of the gateway origin.
    const injectedSuffix = normalizeLoroStreamsShardHostSuffix(shardHostSuffix);
    if (injectedSuffix) {
      url.protocol = 'https:';
      url.host = isLoroStreamsPresenceShardId(shardId)
        ? `presence-${shardId}.${injectedSuffix}`
        : `presence.${injectedSuffix}`;
      // The host setter keeps a pre-existing port; hosted topology is always
      // on the default https port.
      url.port = '';
      return url.toString().replace(/\/+$/g, '');
    }
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

const getLoroStreamsShardOrigin = (
  trafficClass: string,
  shardId: string,
  hostSuffix: string
): string => `https://${trafficClass}-${shardId}.${hostSuffix}`;

export const getLoroStreamsShardUrls = (
  baseUrl?: string | null,
  shardHostSuffix?: string | null
): StreamsCrdtShardUrlsOptions | undefined => {
  let origin: string;
  try {
    origin = new URL(getLoroStreamsBaseUrl(baseUrl)).origin;
  } catch {
    return undefined;
  }
  const suffix =
    normalizeLoroStreamsShardHostSuffix(shardHostSuffix) ??
    (origin === new URL(DEFAULT_LORO_STREAMS_BASE_URL).origin
      ? DEFAULT_LORO_STREAMS_PROXY_HOST_SUFFIX
      : undefined);
  if (!suffix) {
    return undefined;
  }
  return {
    bootstrap: LORO_STREAMS_CONTROL_SHARD_IDS.map((id) =>
      getLoroStreamsShardOrigin('control', id, suffix)
    ),
    catchup: LORO_STREAMS_CONTROL_SHARD_IDS.map((id) =>
      getLoroStreamsShardOrigin('control', id, suffix)
    ),
    largePost: LORO_STREAMS_WRITE_SHARD_IDS.map((id) =>
      getLoroStreamsShardOrigin('write', id, suffix)
    ),
    other: LORO_STREAMS_OTHER_SHARD_IDS.map((id) => getLoroStreamsShardOrigin('api', id, suffix)),
    largePostMinBytes: LORO_STREAMS_LARGE_POST_SHARD_MIN_BYTES,
  };
};

const MAX_LORO_STREAMS_RESOURCE_ID_BYTES = 512;
const loroStreamsResourceIdEncoder = new TextEncoder();

// Durable Streams path-segment rules (formerly enforced by the removed
// `createStreamUrl` in @loro-dev/streams-crdt <=0.14): non-empty UTF-8,
// bounded, and no "/", NUL, or ".." so a segment cannot escape its path slot.
const isValidLoroStreamsResourceId = (id: string): boolean =>
  id.length > 0 &&
  loroStreamsResourceIdEncoder.encode(id).byteLength <= MAX_LORO_STREAMS_RESOURCE_ID_BYTES &&
  !id.includes('/') &&
  !id.includes('\0') &&
  !id.includes('..');

/**
 * Builds a Durable Streams HTTP URL for one `(bucketId, streamId)` pair.
 *
 * Workspace-owned `streamId` values must start with `{workspaceId}:` (never a
 * leading feature tag) so Loro Streams maps every workspace resource to
 * `space_id = workspaceId`; see `.agents/docs/loro-streams-user-space.md`.
 *
 * `@loro-dev/streams-crdt@0.15` removed its `createStreamUrl` export — URL
 * building is caller-owned there now. Unlike the removed helper, `baseUrl`
 * is required: callers must always target their configured gateway, never a
 * library default host.
 */
export const createLoroStreamUrl = (input: {
  bucketId: string;
  streamId: string;
  baseUrl: string;
}): string => {
  const baseUrl = input.baseUrl.replace(/\/+$/g, '');
  if (!isValidLoroStreamsResourceId(input.bucketId)) {
    throw new Error(`invalid Loro Streams bucketId: ${JSON.stringify(input.bucketId)}`);
  }
  if (!isValidLoroStreamsResourceId(input.streamId)) {
    throw new Error(`invalid Loro Streams streamId: ${JSON.stringify(input.streamId)}`);
  }
  return `${baseUrl}/ds/${encodeURIComponent(input.bucketId)}/${encodeURIComponent(input.streamId)}`;
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
/**
 * Workspace-scoped stream IDs must always lead with `{workspaceId}:` and place
 * feature discriminators after the first `:` (`UserSpace` contract:
 * `.agents/docs/loro-streams-user-space.md`).
 */
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
  if (docId.startsWith(SCHEDULE_DOC_PREFIX)) {
    return getLoroScheduleStreamId(workspaceId, docId.slice(SCHEDULE_DOC_PREFIX.length));
  }
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
  const todayPage = parseTodayDocId(docId);
  if (todayPage) {
    return getLoroTodayStreamId(workspaceId, todayPage.userId, todayPage.date);
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
