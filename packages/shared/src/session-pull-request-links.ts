import { parsePullRequestUrl } from './pull-request-url';
import type {
  SessionPullRequestLink,
  SessionPullRequestLinkCheck,
  SessionPullRequestLinkFields,
} from './session-pull-request-meta';

/**
 * Explicit pull-request link records (intent, not association). Each record is
 * its own top-level metadata key, so a user's unlink and a machine's link of
 * different PRs never overwrite each other. Writers: the renderer for user
 * actions, the daemon for shim/agent reports. Only the reconciler turns a
 * `linked` record into a `pullRequests` association after the provider
 * confirms it; an `unlinked` record suppresses that URL in every reader and in
 * branch discovery until a later `linked` record wins.
 */
export const MAX_SESSION_PULL_REQUEST_LINKS = 32;
const LINK_PREFIX = 'prLink:';
const CHECK_PREFIX = 'prLinkCheck:';

export type SessionPullRequestLinkSource = 'shim' | 'user' | 'agent';
const SOURCE_CODE: Record<SessionPullRequestLinkSource, SessionPullRequestLink['o']> = {
  shim: 's',
  user: 'u',
  agent: 'a',
};
const SOURCE_NAME: Record<SessionPullRequestLink['o'], SessionPullRequestLinkSource> = {
  s: 'shim',
  u: 'user',
  a: 'agent',
};

export type SessionPullRequestLinkRecord = {
  /** Record key: the case-folded canonical URL (any provider, supported or not). */
  key: string;
  /** Canonical URL when a provider supports it, else the stored key. */
  url: string;
  supported: boolean;
  state: 'linked' | 'unlinked';
  source: SessionPullRequestLinkSource;
  at: number;
  /** Time the reconciler last found this linked URL unreadable, for this link generation. */
  unreadableAt: number | null;
};

type LinkMeta = Partial<SessionPullRequestLinkFields> | Record<string, unknown> | null | undefined;

export const pullRequestLinkField = (key: string): `prLink:${string}` => `${LINK_PREFIX}${key}`;
export const pullRequestLinkCheckField = (key: string): `prLinkCheck:${string}` =>
  `${CHECK_PREFIX}${key}`;

function parseLink(value: unknown): SessionPullRequestLink | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<SessionPullRequestLink>;
  return (record.k === 'l' || record.k === 'u') &&
    (record.o === 's' || record.o === 'u' || record.o === 'a') &&
    typeof record.t === 'number' &&
    Number.isFinite(record.t)
    ? { k: record.k, o: record.o, t: record.t }
    : null;
}

function parseCheck(value: unknown): SessionPullRequestLinkCheck | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<SessionPullRequestLinkCheck>;
  return record.r === 'u' && typeof record.t === 'number' && Number.isFinite(record.t)
    ? { r: 'u', t: record.t }
    : null;
}

const entries = (meta: LinkMeta) => Object.entries((meta ?? {}) as Record<string, unknown>);

/** Every valid link record, oldest write first (ties by key). */
export function readSessionPullRequestLinks(meta: LinkMeta): SessionPullRequestLinkRecord[] {
  const records: SessionPullRequestLinkRecord[] = [];
  for (const [field, value] of entries(meta)) {
    if (!field.startsWith(LINK_PREFIX)) continue;
    const link = parseLink(value);
    const key = field.slice(LINK_PREFIX.length);
    if (!link || !key) continue;
    const parts = parsePullRequestUrl(key);
    const check = parseCheck((meta as Record<string, unknown>)[pullRequestLinkCheckField(key)]);
    records.push({
      key,
      url: parts?.canonicalUrl ?? key,
      supported: !!parts,
      state: link.k === 'l' ? 'linked' : 'unlinked',
      source: SOURCE_NAME[link.o],
      at: link.t,
      unreadableAt: link.k === 'l' && check && check.t >= link.t ? check.t : null,
    });
  }
  return records.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

function readRecord(meta: LinkMeta, url: string) {
  const key = parsePullRequestUrl(url)?.key;
  return key
    ? parseLink((meta as Record<string, unknown> | undefined)?.[pullRequestLinkField(key)])
    : null;
}

/** True when the newest record for this URL is an unlink: readers and discovery skip it. */
export function isPullRequestUnlinked(meta: LinkMeta, url: string): boolean {
  return readRecord(meta, url)?.k === 'u';
}

/** True when the Session explicitly holds this PR (shim, user or agent link). */
export function isPullRequestExplicitlyLinked(meta: LinkMeta, url: string): boolean {
  return readRecord(meta, url)?.k === 'l';
}

export type SessionPullRequestLinkWritePlan =
  | {
      ok: true;
      field: `prLink:${string}`;
      value: SessionPullRequestLink;
      /** Canonical URL of the linked PR. */
      url: string;
    }
  | { ok: false; reason: 'unsupported' | 'limit' };

function planRecord(
  meta: LinkMeta,
  url: string,
  k: SessionPullRequestLink['k'],
  source: SessionPullRequestLinkSource,
  nowMs: number
): SessionPullRequestLinkWritePlan {
  const parts = parsePullRequestUrl(url);
  if (!parts) return { ok: false, reason: 'unsupported' };
  const field = pullRequestLinkField(parts.key);
  const existing = entries(meta).filter(
    ([name, value]) => name.startsWith(LINK_PREFIX) && parseLink(value)
  );
  if (
    !existing.some(([name]) => name === field) &&
    existing.length >= MAX_SESSION_PULL_REQUEST_LINKS
  )
    return { ok: false, reason: 'limit' };
  const previous = parseLink((meta as Record<string, unknown> | undefined)?.[field]);
  // Clock skew between writers must not let a new intent lose to an older record.
  const t = Math.max(Math.floor(nowMs), (previous?.t ?? 0) + 1);
  return { ok: true, field, value: { k, o: SOURCE_CODE[source], t }, url: parts.canonicalUrl };
}

export function planSessionPullRequestLink(
  meta: LinkMeta,
  url: string,
  source: SessionPullRequestLinkSource,
  nowMs: number
): SessionPullRequestLinkWritePlan {
  return planRecord(meta, url, 'l', source, nowMs);
}

/** Unlink is global for the Session; any member may link it again later. */
export function planSessionPullRequestUnlink(
  meta: LinkMeta,
  url: string,
  nowMs: number,
  source: SessionPullRequestLinkSource = 'user'
): SessionPullRequestLinkWritePlan {
  return planRecord(meta, url, 'u', source, nowMs);
}

/**
 * Record that the reconciler could not read a linked PR. Null when the URL is
 * not linked or this link generation already carries a check (no rewrite churn).
 */
export function planPullRequestLinkCheck(
  meta: LinkMeta,
  url: string,
  nowMs: number
): { field: `prLinkCheck:${string}`; value: SessionPullRequestLinkCheck } | null {
  const parts = parsePullRequestUrl(url);
  const link = readRecord(meta, url);
  if (!parts || link?.k !== 'l') return null;
  const field = pullRequestLinkCheckField(parts.key);
  const check = parseCheck((meta as Record<string, unknown> | undefined)?.[field]);
  if (check && check.t >= link.t) return null;
  return { field, value: { r: 'u', t: Math.max(Math.floor(nowMs), link.t) } };
}
