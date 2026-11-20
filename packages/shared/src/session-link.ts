import { LODY_PROTOCOLS, SESSION_LINK_SCHEMES } from './session-link-schemes.mjs';
import { encodeTodayUserId, parseTodayDate } from './today-types';
export {
  LODY_PROTOCOLS,
  SESSION_LINK_SCHEMES,
  INSTALLATION_LINK_SCHEMES,
} from './session-link-schemes.mjs';

/** Public resource links are independent of the installed desktop channel. */
export type SessionLink = {
  sessionId: string;
  workspaceId?: string;
  /** Legacy read compatibility only; new links address this ID directly. */
  tabSessionId?: string;
};

const ID = /^[A-Za-z0-9_-]+$/u;
const SCHEMES = new Set(SESSION_LINK_SCHEMES.map((scheme) => `${scheme}:`));

export function buildSessionLink(target: SessionLink): string {
  for (const value of [target.sessionId, target.workspaceId, target.tabSessionId]) {
    if (value !== undefined && !ID.test(value)) throw new Error('Invalid session link identifier');
  }
  const query = new URLSearchParams();
  if (target.workspaceId) query.set('workspace', target.workspaceId);
  const sessionId = target.tabSessionId ?? target.sessionId;
  const url = `${LODY_PROTOCOLS.resource}://session/${sessionId}${query.size ? `?${query}` : ''}`;
  if (url.length > 8192) throw new Error('Session link is too long');
  return url;
}

/** Read old transcripts without ever registering the generic session scheme. */
export function parseSessionLink(raw: string): SessionLink | null {
  if (raw.length > 8192 || /[\s\\%]/u.test(raw)) return null;
  const legacy = /^session:\/\/([A-Za-z0-9_-]+)\/?$/u.exec(raw);
  if (legacy) return { sessionId: legacy[1]! };
  // Reject path normalization (e.g. /other/../id) before URL can erase it.
  if (!/^[a-zA-Z.-]+:\/\/session\/[A-Za-z0-9_-]+(?:\?[^#]*)?$/u.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    !SCHEMES.has(url.protocol) ||
    url.hostname !== 'session' ||
    url.port ||
    url.username ||
    url.password
  )
    return null;
  const sessionId = url.pathname.slice(1);
  if (!ID.test(sessionId)) return null;
  for (const key of url.searchParams.keys()) {
    if (key !== 'workspace' && key !== 'tab') return null;
    if (url.searchParams.getAll(key).length !== 1 || !ID.test(url.searchParams.get(key) ?? ''))
      return null;
  }
  return {
    sessionId,
    ...(url.searchParams.has('workspace')
      ? { workspaceId: url.searchParams.get('workspace')! }
      : {}),
    ...(url.searchParams.has('tab') ? { tabSessionId: url.searchParams.get('tab')! } : {}),
  };
}

/** MCP references cannot select a different authorized workspace. */
export function resolveSessionLinkId(raw: string, workspaceId: string): string {
  const link = parseSessionLink(raw);
  if (!link) {
    if (!ID.test(raw)) throw new Error('Invalid session reference');
    return raw;
  }
  if (link.workspaceId && link.workspaceId !== workspaceId) {
    throw new Error('Session link belongs to a different workspace');
  }
  // A bare session reference is unambiguous; tab relationships require a catalog.
  if (link.tabSessionId) throw new Error('Use the child session ID directly for MCP requests');
  return link.sessionId;
}

/** A member's Today page for one day (specs/today-outline.md). */
export type TodayLink = { userId: string; date: string; workspaceId: string };

/**
 * `lody://today/<encodeURIComponent(userId)>/<YYYY-MM-DD>?workspace=<id>`.
 * Unlike session links the user segment may hold `%XX` (local ids contain `:`),
 * but only in its canonical encoding, so one page has exactly one link.
 */
export function parseTodayLink(raw: string): TodayLink | null {
  if (raw.length > 8192 || /[\s\\]/u.test(raw)) return null;
  const match =
    /^([a-zA-Z.-]+):\/\/today\/([A-Za-z0-9_.~%-]+)\/(\d{4}-\d{2}-\d{2})\?workspace=([A-Za-z0-9_-]+)$/u.exec(
      raw
    );
  if (!match || !SCHEMES.has(`${match[1]}:`)) return null;
  const [, , encodedUser, date, workspaceId] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  let userId: string;
  try {
    userId = decodeURIComponent(encodedUser);
  } catch {
    return null;
  }
  if (!userId || /^\.+$/u.test(userId) || encodeTodayUserId(userId) !== encodedUser) return null;
  if (!parseTodayDate(date)) return null;
  return { userId, date, workspaceId };
}

/** A link the app opens itself: a conversation or a Today page. */
export function isAppResourceLink(raw: string): boolean {
  return parseSessionLink(raw) !== null || parseTodayLink(raw) !== null;
}
