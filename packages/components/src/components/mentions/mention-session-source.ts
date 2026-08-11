import * as React from 'react';
import type { SessionId, SessionMeta } from '@lody/shared';
import { getEffectiveLatestMessageAt } from '@/components/sessions/session-list-rows';
import { useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';

/**
 * `@session:` mention — the one type whose displayed text is not what the agent
 * receives.
 *
 * The composer is a textarea with a character-aligned highlight overlay, so it
 * cannot render a chip whose width differs from its text. Showing a title while
 * sending an id therefore has to happen the way `$skill` already does it: the
 * text carries a human-readable token, the real payload rides on the mention
 * range, and the token is rewritten on the way out.
 *
 * Unlike the other namespaces, `@session:` stays in the committed text. It is
 * the anchor `expandSessionMentionsInText` matches on.
 */

export const SESSION_MENTION_NAMESPACE = 'session';
export const SESSION_MENTION_PREFIX = `@${SESSION_MENTION_NAMESPACE}:`;

/** Slugs stay short enough to read inline without dominating the composer. */
const MAX_SLUG_LENGTH = 40;
/** Enough of the id to separate same-titled sessions without becoming noise. */
const DISAMBIGUATOR_LENGTH = 4;

export type SessionMentionItem = {
  /** The text written after `@session:`. Whitespace-free by construction. */
  slug: string;
  sessionId: SessionId;
  /** Full title as shown in the detail panel; empty when the session has none. */
  title: string;
  /** Recency key used for ordering. */
  activityAt: number;
  projectLabel?: string;
};

function normalizeTitle(title: string | undefined): string {
  return (title ?? '').trim();
}

/**
 * Slugify a session title into a whitespace-free token.
 *
 * Only whitespace is replaced: the trigger scan ends at the first space, so
 * everything else — including CJK — is safe to keep, and keeping it means a
 * Chinese title stays readable in the composer.
 */
export function buildSessionMentionSlug(title: string | undefined, sessionId: string): string {
  const normalized = normalizeTitle(title)
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (!normalized) {
    // Untitled sessions (a brand-new one, before the agent titles it) still need
    // a stable, unique token.
    return sessionId.slice(0, DISAMBIGUATOR_LENGTH);
  }
  return Array.from(normalized).slice(0, MAX_SLUG_LENGTH).join('');
}

/** Repo the session belongs to, or nothing — `project.kind` is not a label. */
function getProjectLabel(session: SessionMeta): string | undefined {
  const project = session.project;
  if (project?.kind === 'local') {
    return project.githubRepoFullName ?? session.repoFullName ?? undefined;
  }
  return session.repoFullName ?? undefined;
}

/**
 * Mentionable sessions, most recently active first.
 *
 * `currentSessionId` is dropped: a session referring to its own history is
 * never what the user means, and the agent already has it.
 *
 * Slug collisions are broken by appending a short id. Only the later (less
 * recent) session is disambiguated, so the most recent holder of a title keeps
 * the clean slug — re-typing the same prompt tomorrow stays stable.
 */
export function buildSessionMentionItems(
  sessions: readonly SessionMeta[],
  currentSessionId?: string | null
): SessionMentionItem[] {
  const ordered = sessions
    .filter((session) => session.id !== currentSessionId && !session.isArchived)
    .map((session) => ({ session, activityAt: getEffectiveLatestMessageAt(session) }))
    .sort((left, right) => right.activityAt - left.activityAt);

  const takenSlugs = new Set<string>();
  const items: SessionMentionItem[] = [];
  for (const { session, activityAt } of ordered) {
    const base = buildSessionMentionSlug(session.title, session.id);
    let slug = base;
    if (takenSlugs.has(slug)) {
      slug = `${base}~${session.id.slice(0, DISAMBIGUATOR_LENGTH)}`;
      // Still colliding means two sessions share a title and an id prefix; fall
      // back to the full id, which is unique by definition.
      if (takenSlugs.has(slug)) slug = `${base}~${session.id}`;
    }
    takenSlugs.add(slug);
    items.push({
      slug,
      sessionId: session.id,
      title: normalizeTitle(session.title),
      activityAt,
      projectLabel: getProjectLabel(session),
    });
  }
  return items;
}

/**
 * Cap matching the other categories': the list is recency-ordered, so a
 * workspace with hundreds of sessions must not render a row — and register a
 * collection item the arrow keys then walk — for every one of them.
 */
const MAX_SESSION_SUGGESTIONS = 50;

export function selectSessionMentionCandidates(
  items: readonly SessionMentionItem[],
  term: string,
  limit = MAX_SESSION_SUGGESTIONS
): SessionMentionItem[] {
  const query = term.trim().toLowerCase();
  if (!query) return items.slice(0, limit);
  return items
    .map((item) => {
      const slug = item.slug.toLowerCase();
      const title = item.title.toLowerCase();
      let score = -1;
      if (slug.startsWith(query) || title.startsWith(query)) score = 0;
      else if (slug.includes(query) || title.includes(query)) score = 1;
      return { item, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || b.item.activityAt - a.item.activityAt)
    .slice(0, limit)
    .map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// Slug -> id resolution
// ---------------------------------------------------------------------------

/**
 * Persistent slug -> id map.
 *
 * Needed because internal mention ranges are not persisted with a draft: after a
 * reload only the text survives, so `@session:<slug>` has to be resolvable
 * again. It also survives a rename, where the live session list no longer
 * produces the slug the draft was written with.
 *
 * Deliberately `localStorage` rather than IndexedDB: expansion runs
 * synchronously on the send path, and an async store would force that whole
 * path to become async for a map of a few hundred bytes.
 */
const SLUG_CACHE_KEY = 'lody:session-mention-slugs';
const SLUG_CACHE_LIMIT = 200;

type SlugCache = Record<string, string>;

function parseSlugCache(raw: string | null): SlugCache {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SlugCache = {};
    for (const [slug, id] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === 'string') out[slug] = id;
    }
    return out;
  } catch {
    return {};
  }
}

function readSlugCache(): SlugCache {
  if (typeof localStorage === 'undefined') return {};
  try {
    return parseSlugCache(localStorage.getItem(SLUG_CACHE_KEY));
  } catch {
    return {};
  }
}

export function rememberSessionMentionSlugs(items: readonly SessionMentionItem[]): void {
  if (typeof localStorage === 'undefined' || items.length === 0) return;
  try {
    const raw = localStorage.getItem(SLUG_CACHE_KEY);
    const merged: SlugCache = { ...parseSlugCache(raw) };
    for (const item of items) merged[item.slug] = item.sessionId;
    const entries = Object.entries(merged);
    // Oldest insertions fall off first; re-inserting a slug refreshes its place.
    const trimmed = entries.slice(Math.max(0, entries.length - SLUG_CACHE_LIMIT));
    const serialized = JSON.stringify(Object.fromEntries(trimmed));
    // The session list ticks several times a second while an agent streams and
    // almost every tick leaves this map identical. `setItem` is synchronous, so
    // re-writing the same bytes would block the main thread for nothing.
    if (serialized === raw) return;
    localStorage.setItem(SLUG_CACHE_KEY, serialized);
  } catch {
    // A full or unavailable store only costs us stale-draft resolution.
  }
}

/**
 * The mentionable sessions for a composer, plus the slug -> id cache write.
 *
 * One owner on purpose: the composer's menu and `useMentionPromptExpansion` both
 * need the same items, and deriving them separately meant re-slugging every
 * visible session twice on each session-list tick.
 */
export function useSessionMentionItems(currentSessionId?: string | null): SessionMentionItem[] {
  const { sessions } = useVisibleSessionMetas();
  const items = React.useMemo(
    () => buildSessionMentionItems(sessions, currentSessionId),
    [currentSessionId, sessions]
  );
  // Keep the slug -> id map durable so a draft reloaded tomorrow, or one whose
  // session has since been renamed, still resolves.
  React.useEffect(() => {
    rememberSessionMentionSlugs(items);
  }, [items]);
  return items;
}

/** Live items win; the cache covers reloaded drafts and renamed sessions. */
export function resolveSessionMentionIds(
  items: readonly SessionMentionItem[]
): ReadonlyMap<string, string> {
  const resolved = new Map<string, string>(Object.entries(readSlugCache()));
  for (const item of items) resolved.set(item.slug, item.sessionId);
  return resolved;
}

// ---------------------------------------------------------------------------
// Text: hydration and before-send expansion
// ---------------------------------------------------------------------------

/** Walk every `@session:<slug>` span; slugs run to the next whitespace. */
function forEachSessionMentionSpan(
  text: string,
  visit: (span: { slug: string; start: number; end: number }) => boolean
): void {
  let index = text.indexOf(SESSION_MENTION_PREFIX);
  while (index !== -1) {
    let end = index + SESSION_MENTION_PREFIX.length;
    while (end < text.length) {
      const char = text[end];
      if (!char || char === ' ' || char === '\n' || char === '\t') break;
      end += 1;
    }
    const slug = text.slice(index + SESSION_MENTION_PREFIX.length, end);
    const consumed = visit({ slug, start: index, end });
    index = text.indexOf(SESSION_MENTION_PREFIX, consumed ? end : index + 1);
  }
}

export function buildSessionMentionPrompt(sessionId: string): string {
  return `use lody mcp to query session[id: ${sessionId}] history`;
}

/**
 * Rewrite `@session:<slug>` into the MCP instruction carrying the real id.
 *
 * Idempotent by construction: expansion consumes the `@session:` anchor, so a
 * re-sent prompt has nothing left to match. An unresolvable slug (a rename we
 * never cached) is left exactly as-is — a stale token the agent can ignore is
 * far better than a confidently wrong session id.
 */
export function expandSessionMentionsInText(
  text: string,
  slugToId: ReadonlyMap<string, string>
): string {
  if (!text.includes(SESSION_MENTION_PREFIX) || slugToId.size === 0) return text;

  let result = '';
  let copiedTo = 0;
  forEachSessionMentionSpan(text, ({ slug, start, end }) => {
    const sessionId = slug ? slugToId.get(slug) : undefined;
    if (!sessionId) return false;
    result += text.slice(copiedTo, start) + buildSessionMentionPrompt(sessionId);
    copiedTo = end;
    return true;
  });
  return result + text.slice(copiedTo);
}

export function hydrateSessionMentionsFromText(
  text: string,
  slugToId: ReadonlyMap<string, string>
): { mentions: Array<{ value: string; start: number; end: number }>; values: string[] } {
  const mentions: Array<{ value: string; start: number; end: number }> = [];
  const values = new Set<string>();
  forEachSessionMentionSpan(text, ({ slug, start, end }) => {
    const sessionId = slug ? slugToId.get(slug) : undefined;
    if (!sessionId) return false;
    mentions.push({ value: sessionId, start, end });
    values.add(sessionId);
    return true;
  });
  return { mentions, values: Array.from(values) };
}
