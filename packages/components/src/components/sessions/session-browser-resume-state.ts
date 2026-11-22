import type {
  BrowserAddress,
  PreviewConnection,
  SessionId,
  SessionPreviewEndpoint,
} from '@lody/shared';

import { LRUCache } from '@/lib/lru-cache';
import { hasUsableManagedPreviewUrl } from '@/lib/managed-preview-connection';

export type SessionBrowserNavigationHistory = {
  entries: string[];
  index: number;
};

export type CachedRemotePreviewLink = {
  connection: PreviewConnection;
  /** Epoch milliseconds when this cached link expires. */
  expiresAt: number;
};

export type SessionBrowserResumeState = {
  currentAddress?: BrowserAddress;
  history: SessionBrowserNavigationHistory;
  machinePlane?: 'local' | 'cloud';
  localEndpoint?: SessionPreviewEndpoint;
  remotePreview?: CachedRemotePreviewLink;
};

const MAX_RESUMABLE_BROWSER_SESSIONS = 50;
export const DEFAULT_REMOTE_PREVIEW_LINK_TTL_MS = 60 * 60 * 1000;

const resumeStateBySessionId = new LRUCache<SessionId, SessionBrowserResumeState>(
  MAX_RESUMABLE_BROWSER_SESSIONS
);

const cloneAddress = (address: BrowserAddress): BrowserAddress => ({
  ...address,
  ...(address.target ? { target: { ...address.target } } : {}),
});

const cloneConnection = (connection: PreviewConnection): PreviewConnection => ({
  ...connection,
  ...(connection.target ? { target: { ...connection.target } } : {}),
  ...(connection.error ? { error: { ...connection.error } } : {}),
});

const cloneLocalEndpoint = (endpoint: SessionPreviewEndpoint): SessionPreviewEndpoint => ({
  ...endpoint,
  target: { ...endpoint.target },
  capabilities: { ...endpoint.capabilities },
});

const cloneResumeState = (state: SessionBrowserResumeState): SessionBrowserResumeState => ({
  ...(state.currentAddress ? { currentAddress: cloneAddress(state.currentAddress) } : {}),
  history: {
    entries: [...state.history.entries],
    index: state.history.index,
  },
  ...(state.machinePlane ? { machinePlane: state.machinePlane } : {}),
  ...(state.localEndpoint ? { localEndpoint: cloneLocalEndpoint(state.localEndpoint) } : {}),
  ...(state.remotePreview
    ? {
        remotePreview: {
          connection: cloneConnection(state.remotePreview.connection),
          expiresAt: state.remotePreview.expiresAt,
        },
      }
    : {}),
});

export const resolveRemotePreviewExpiresAt = (
  connection: PreviewConnection,
  expiresAt?: number,
  now = Date.now()
): number => {
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt;
  }
  const idleTimeoutMs =
    typeof connection.idleTimeoutMs === 'number' &&
    Number.isFinite(connection.idleTimeoutMs) &&
    connection.idleTimeoutMs > 0
      ? connection.idleTimeoutMs
      : DEFAULT_REMOTE_PREVIEW_LINK_TTL_MS;
  return now + idleTimeoutMs;
};

export const isCachedRemotePreviewValid = (
  cached: CachedRemotePreviewLink | undefined,
  now = Date.now()
): cached is CachedRemotePreviewLink & {
  connection: PreviewConnection & { status: 'active'; publicUrl: string };
} => Boolean(cached && hasUsableManagedPreviewUrl(cached.connection) && cached.expiresAt > now);

export const readSessionBrowserResumeState = (
  sessionId: SessionId
): SessionBrowserResumeState | null => {
  const state = resumeStateBySessionId.get(sessionId);
  return state ? cloneResumeState(state) : null;
};

export const rememberSessionBrowserResumeState = (
  sessionId: SessionId,
  patch: Partial<SessionBrowserResumeState>
): void => {
  const existing = resumeStateBySessionId.get(sessionId);
  const next: SessionBrowserResumeState = {
    history: existing?.history ?? { entries: [], index: -1 },
    ...(existing?.currentAddress ? { currentAddress: existing.currentAddress } : {}),
    ...(existing?.machinePlane ? { machinePlane: existing.machinePlane } : {}),
    ...(existing?.localEndpoint ? { localEndpoint: existing.localEndpoint } : {}),
    ...(existing?.remotePreview ? { remotePreview: existing.remotePreview } : {}),
    ...patch,
  };
  if ('localEndpoint' in patch && patch.localEndpoint === undefined) {
    delete next.localEndpoint;
  }
  if ('remotePreview' in patch && patch.remotePreview === undefined) {
    delete next.remotePreview;
  }
  resumeStateBySessionId.set(sessionId, cloneResumeState(next));
};

export const rememberSessionRemotePreview = (
  sessionId: SessionId,
  connection: PreviewConnection | undefined,
  expiresAt?: number,
  now = Date.now()
): CachedRemotePreviewLink | undefined => {
  if (!hasUsableManagedPreviewUrl(connection)) {
    rememberSessionBrowserResumeState(sessionId, { remotePreview: undefined });
    return undefined;
  }
  const cached: CachedRemotePreviewLink = {
    connection,
    expiresAt: resolveRemotePreviewExpiresAt(connection, expiresAt, now),
  };
  rememberSessionBrowserResumeState(sessionId, { remotePreview: cached });
  return cached;
};

export const clearSessionBrowserResumeState = (sessionId: SessionId): void => {
  resumeStateBySessionId.delete(sessionId);
};

export const clearAllSessionBrowserResumeStates = (): void => {
  resumeStateBySessionId.clear();
};
