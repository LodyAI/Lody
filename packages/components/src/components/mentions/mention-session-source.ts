import * as React from 'react';
import {
  hydrateSlugMentionsFromText,
  type HydratedMentions,
} from '@/components/mentions/mention-hydration';
import { rankMentionCandidates } from '@/components/mentions/mention-rank';
import type { MentionInsertRequest } from '@/ui/mention/index';
import type { TextRewrite } from '@lody/shared';
import type { SessionId, SessionMeta } from '@lody/shared';
import { getEffectiveLatestMessageAt } from '@/components/sessions/session-list-rows';
import { useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';
import { resolveSessionRepoFullName } from '@/lib/session-repo';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';

/**
 * Session mention — the one type whose displayed text is not what the agent
 * receives.
 *
 * The composer is a textarea with a character-aligned highlight overlay, so it
 * cannot render a chip whose width differs from its text. Showing a title while
 * sending an id therefore has to happen the way `$skill` already does it: the
 * text carries a human-readable token, the real payload rides on the mention
 * range, and the token is rewritten on the way out.
 *
 * There is no `session:` marker in the committed text. It only ever existed as
 * an anchor for a text-matching rewrite, and the user had to read it; the
 * committed range carries the real session id, so `buildSessionMentionRewrites`
 * rewrites THE RANGE and the composer writes a plain `@<slug>`.
 */

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
  /** Internal identity used only to derive the menu's current-project candidates. */
  projectKey: SessionMentionProjectKey;
};

export type SessionMentionProjectKey = `local:${string}:${string}` | `github:${string}` | 'chat';
export type SessionMentionProjectScope = 'current' | 'all';

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

function githubProjectKey(repoFullName: string | undefined): SessionMentionProjectKey {
  const normalized = repoFullName?.trim().toLowerCase();
  return normalized ? `github:${normalized}` : 'chat';
}

/** Stable project identity for grouping session candidates. */
export function getSessionMentionProjectKey(
  session: Pick<SessionMeta, 'machineId' | 'project' | 'repoFullName'>
): SessionMentionProjectKey {
  if (session.project?.kind === 'local') {
    return `local:${session.machineId}:${session.project.localProjectId}`;
  }
  return githubProjectKey(resolveSessionRepoFullName(session));
}

/** Project identity of the composer, including landing composers without a Session yet. */
export function getMentionSourceProjectKey(
  source: MentionProjectSource | undefined
): SessionMentionProjectKey {
  if (source?.kind === 'local') {
    return `local:${source.machineId}:${source.localProjectId}`;
  }
  if (source?.kind === 'github') return githubProjectKey(source.repoFullName);
  if (source?.kind === 'provider') {
    return source.localProject
      ? `local:${source.localProject.machineId}:${source.localProject.localProjectId}`
      : githubProjectKey(source.githubRepoFullName);
  }
  return 'chat';
}

/** Filter only the menu candidates; callers retain the complete item list for addressing. */
export function filterSessionMentionItemsByProject(
  items: readonly SessionMentionItem[],
  currentProjectKey: SessionMentionProjectKey,
  scope: SessionMentionProjectScope
): SessionMentionItem[] {
  return scope === 'all'
    ? [...items]
    : items.filter((item) => item.projectKey === currentProjectKey);
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
      projectKey: getSessionMentionProjectKey(session),
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
  return rankMentionCandidates(items, term, {
    limit,
    fields: (item) => [item.slug, item.title],
    tieBreak: (left, right) => right.activityAt - left.activityAt,
  });
}

// ---------------------------------------------------------------------------
// Insertion from outside the menu (drag and drop)
// ---------------------------------------------------------------------------

/**
 * The edit that adds a session mention to a draft nobody is typing in.
 *
 * Returns null when the session is already mentioned: a second range would send
 * the same history query twice, and the gesture that produces this — dropping a
 * sidebar row — is easy to repeat by accident.
 *
 * Appends rather than inserting at the caret. A drop moves no caret, and an
 * unfocused textarea reports whatever offset it was last left at (0 on one that
 * was never focused), so "at the caret" would mean "at the start of the draft"
 * for the common case.
 *
 * It is a real range, not just text: a session token with no committed range is
 * sent verbatim, so an insert that only appended `@<slug>` would look right in
 * the composer and quietly reach the agent as a word.
 */
export function buildSessionMentionInsertion(
  mentions: readonly { value: string; kind?: string }[],
  item: Pick<SessionMentionItem, 'slug' | 'sessionId'>
): MentionInsertRequest | null {
  const alreadyMentioned = mentions.some(
    (mention) => mention.kind === 'session' && mention.value === item.sessionId
  );
  if (alreadyMentioned) return null;

  return {
    text: `@${item.slug}`,
    value: item.sessionId,
    kind: 'session',
    // Appended, so the separator and the trailing space keep the token
    // whitespace-delimited — which is what the hydrator that recovers it from a
    // reloaded draft scans for.
    separate: true,
    suffix: ' ',
  };
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
 *
 * Reads the child-inclusive projection on purpose: mentioning is an addressing
 * surface (the agent is pointed at that session's history), and child sessions —
 * review runs, task sessions — are exactly what gets referenced. `sessions` is
 * the sidebar-row projection, which deliberately hides child tabs.
 */
export function useSessionMentionItems(currentSessionId?: string | null): SessionMentionItem[] {
  const { allActiveSessions } = useVisibleSessionMetas();
  const items = React.useMemo(
    () => buildSessionMentionItems(allActiveSessions, currentSessionId),
    [currentSessionId, allActiveSessions]
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

export function buildSessionMentionPrompt(sessionId: string): string {
  return `use lody mcp to query session[id: ${sessionId}] history`;
}

/**
 * The session -> MCP-instruction rewrites these ranges imply.
 *
 * Driven by the committed ranges, not by scanning the text. The composer used
 * to write `@session:<slug>` and this used to match on that prefix, which is
 * why the prefix had to survive into the sent text at all. It carried no
 * meaning for the user — it was an anchor for this function. Ranges carry the
 * session id directly, so the anchor is gone and the composer writes a plain
 * `@<slug>`.
 *
 * The span keeps the slug as its label, so the transcript shows the session the
 * user picked rather than the id-bearing instruction the agent needs.
 */
export function buildSessionMentionRewrites(
  text: string,
  mentions: readonly { start: number; end: number; kind?: string; value: string }[]
): TextRewrite[] {
  const rewrites: TextRewrite[] = [];
  for (const mention of mentions) {
    if (mention.kind !== 'session' || !mention.value) continue;
    const label = text.slice(mention.start, mention.end).replace(/^@/, '');
    if (!label) continue;
    rewrites.push({
      start: mention.start,
      end: mention.end,
      replacement: buildSessionMentionPrompt(mention.value),
      span: { kind: 'session', label, target: mention.value },
    });
  }
  return rewrites;
}

/**
 * Recover session ranges from a reloaded draft's text.
 *
 * Ranges are not persisted with a draft, so after a reload the only evidence
 * that `@crdt-metadata-cleanup` was a session is that the slug is one we know.
 * That is weaker than the old `@session:` prefix, which said so outright, and
 * it is the price of not showing that prefix to the user.
 *
 * `knownFileTokens` is what keeps the weaker signal safe: a token that is also
 * a real path is left for the file hydrator. Paths are the overwhelmingly
 * common case, and mistaking one for a session would silently turn a file
 * reference into a history query, whereas the reverse merely leaves a session
 * token unexpanded — visible to the user as a missing chip.
 */
export function hydrateSessionMentionsFromText(
  text: string,
  slugToId: ReadonlyMap<string, string>,
  knownFileTokens?: ReadonlySet<string>
): HydratedMentions {
  return hydrateSlugMentionsFromText({ text, slugToValue: slugToId, kind: 'session', knownFileTokens });
}
