import {
  getAppOriginForUrlParsing,
  getAppShareOrigin,
  getAppShareUrl,
} from '@/lib/app-location';

/**
 * Session page path: `/{workspaceSlug}/sessions/{sessionId}` plus optional
 * search/hash. Anything else is not a Lody conversation URL.
 */
const SESSION_PATH_PATTERN = /^\/([^/]+)\/sessions\/([^/]+)\/?$/;

export type ParsedAppSessionUrl = {
  /** Absolute URL the user pasted, normalized without a trailing slash on the path. */
  url: string;
  workspaceSlug: string;
  sessionId: string;
};

/** Origins that count as "this app" when recognizing a pasted conversation link. */
export function getAppSessionUrlOrigins(
  now: {
    pageOrigin?: string;
    shareOrigin?: string;
  } = {}
): string[] {
  const pageOrigin = now.pageOrigin ?? getAppOriginForUrlParsing();
  const shareOrigin = now.shareOrigin ?? getAppShareOrigin();
  const origins = new Set<string>();
  for (const origin of [pageOrigin, shareOrigin]) {
    const trimmed = origin.trim();
    if (trimmed) origins.add(trimmed.replace(/\/$/, ''));
  }
  return [...origins];
}

/**
 * Modifier keys carried on a paste gesture. DOM/React `ClipboardEvent` types omit
 * them, but browsers still populate the chord that triggered the paste.
 */
export type PasteModifierKeys = {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
};

function readPasteModifierKeys(event: unknown): PasteModifierKeys {
  if (!event || typeof event !== 'object') return {};
  const record = event as PasteModifierKeys & { nativeEvent?: unknown };
  const native =
    record.nativeEvent && typeof record.nativeEvent === 'object'
      ? (record.nativeEvent as PasteModifierKeys)
      : undefined;
  const chord = native ?? record;
  return {
    shiftKey: Boolean(chord.shiftKey),
    metaKey: Boolean(chord.metaKey),
    ctrlKey: Boolean(chord.ctrlKey),
  };
}

/**
 * True for Cmd/Ctrl+Shift+V — paste-as-plain, so a session URL stays a URL.
 *
 * Accepts a React/DOM paste event or a plain chord object (tests). Modifier
 * state is read from the event that triggered the paste when the browser
 * exposes it.
 */
export function isPlainLinkPasteShortcut(event: unknown): boolean {
  const chord = readPasteModifierKeys(event);
  return Boolean(chord.shiftKey && (chord.metaKey || chord.ctrlKey));
}

/**
 * Parse a clipboard string as a single Lody session URL.
 *
 * Only accepts an absolute URL whose origin is one of the app bases (current
 * page and configured share origin). Relative paths and foreign hosts are
 * ignored so an arbitrary `/…/sessions/…` link elsewhere does not become a
 * mention.
 */
export function parseAppSessionUrl(
  raw: string,
  options: {
    allowedOrigins?: readonly string[];
  } = {}
): ParsedAppSessionUrl | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/u.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const allowed = new Set(
    (options.allowedOrigins ?? getAppSessionUrlOrigins()).map((origin) => origin.replace(/\/$/, ''))
  );
  if (!allowed.has(parsed.origin)) return null;

  const match = SESSION_PATH_PATTERN.exec(parsed.pathname);
  if (!match) return null;

  const workspaceSlug = match[1] ?? '';
  const sessionId = match[2] ?? '';
  if (!workspaceSlug || !sessionId) return null;

  const path = `/${workspaceSlug}/sessions/${sessionId}`;
  const url = `${parsed.origin}${path}${parsed.search}${parsed.hash}`;
  return { url, workspaceSlug, sessionId };
}

/** Canonical share URL for a session in the given workspace. */
export function buildAppSessionUrl(workspaceSlug: string, sessionId: string): string {
  const slug = workspaceSlug.trim().replace(/^\/+|\/+$/g, '');
  const id = sessionId.trim();
  if (!slug || !id) return '';
  return getAppShareUrl(`/${slug}/sessions/${id}`);
}
