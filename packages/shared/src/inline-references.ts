import { removePreviewQueryParamFromSearch } from './preview';

export const INLINE_REFERENCE_KINDS = ['url', 'github_repo', 'browser_page'] as const;
export type InlineReferenceKind = (typeof INLINE_REFERENCE_KINDS)[number];

export type BrowserPageReference = {
  version: 1;
  machineId: string;
  sessionId: string;
  url: string;
  title?: string;
};

export function isInlineReferenceKind(kind: string | undefined): kind is InlineReferenceKind {
  return kind === 'url' || kind === 'github_repo' || kind === 'browser_page';
}

export function parseReferenceUrl(value: string): URL | null {
  if (!/^https?:\/\//i.test(value) || /\s/u.test(value)) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function getUrlReferenceKind(value: string): 'url' | 'github_repo' | null {
  const url = parseReferenceUrl(value);
  if (!url) return null;
  const owner = url.pathname.split('/')[1]?.toLowerCase();
  const reserved = new Set([
    'settings',
    'orgs',
    'users',
    'search',
    'login',
    'logout',
    'signup',
    'features',
    'topics',
    'collections',
    'marketplace',
    'enterprise',
    'organizations',
    'account',
    'apps',
    'codespaces',
    'sponsors',
    'notifications',
    'new',
    'explore',
    'about',
    'contact',
    'security',
    'pricing',
    'site',
    'customer-stories',
    'readme',
    'solutions',
  ]);
  return url.hostname === 'github.com' &&
    !reserved.has(owner ?? '') &&
    !url.port &&
    !url.search &&
    !url.hash &&
    /^\/[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]+\/?$/i.test(url.pathname)
    ? 'github_repo'
    : 'url';
}

function normalizeBrowserPageReference(value: unknown): BrowserPageReference | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (
    !('version' in value) ||
    value.version !== 1 ||
    !('machineId' in value) ||
    typeof value.machineId !== 'string' ||
    !value.machineId.trim() ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId.trim() ||
    !('url' in value) ||
    typeof value.url !== 'string'
  )
    return null;
  const url = parseReferenceUrl(value.url);
  if (!url) return null;
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('__lody_preview_') || key.startsWith('__lody_local_preview_')) {
      url.search = removePreviewQueryParamFromSearch(url.search, key);
    }
  }
  const title =
    'title' in value && typeof value.title === 'string'
      ? value.title.trim().slice(0, 512)
      : undefined;
  return {
    version: 1,
    machineId: value.machineId,
    sessionId: value.sessionId,
    url: url.href,
    ...(title ? { title } : {}),
  };
}

export function encodeBrowserPageReference(value: BrowserPageReference): string | null {
  const reference = normalizeBrowserPageReference(value);
  return reference ? JSON.stringify(reference) : null;
}

export function parseBrowserPageReference(value: string): BrowserPageReference | null {
  try {
    return normalizeBrowserPageReference(JSON.parse(value));
  } catch {
    return null;
  }
}

export function getInlineReferenceUrl(kind: string | undefined, target: string): string | null {
  if (kind === 'browser_page') return parseBrowserPageReference(target)?.url ?? null;
  return isInlineReferenceKind(kind) ? (parseReferenceUrl(target)?.href ?? null) : null;
}
