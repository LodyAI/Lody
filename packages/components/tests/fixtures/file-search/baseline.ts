// Frozen search implementation from ea225601e92138ad37521fc6d873f1973d4d2268.
import { scoreMentionMatch } from '../../../src/components/mentions/mention-rank';

export const MAX_SUGGESTIONS = 120;
export const MAX_DEFAULT_SUGGESTIONS = 60;

export type PathSuggestion = {
  kind: 'dir' | 'file';
  path: string;
  token: string;
};

export function buildPathSuggestions(filePaths: string[]) {
  const fileSet = new Set<string>();
  const dirSet = new Set<string>();

  for (const filePath of filePaths) {
    const normalized = filePath.replace(/^\/+/, '');
    if (!normalized) continue;
    fileSet.add(normalized);

    const parts = normalized.split('/');
    if (parts.length <= 1) continue;
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      dirSet.add(current);
    }
  }

  const dirs = Array.from(dirSet)
    .sort((a, b) => a.localeCompare(b))
    .map<PathSuggestion>((path) => ({
      kind: 'dir',
      path,
      token: `${path}/`,
    }));

  const files = Array.from(fileSet)
    .sort((a, b) => a.localeCompare(b))
    .map<PathSuggestion>((path) => ({
      kind: 'file',
      path,
      token: path,
    }));

  const allSuggestions = [...dirs, ...files];
  return {
    dirs,
    files,
    allSuggestions,
    allTokens: new Set([...dirs.map((d) => d.token), ...files.map((f) => f.token)]),
  };
}

export function isTopLevelToken(token: string) {
  const normalized = token.replace(/\/+$/, '');
  return !normalized.includes('/');
}

export function getTokenDepth(token: string) {
  const normalized = token.replace(/\/+$/, '');
  if (!normalized) return 0;
  return normalized.split('/').filter(Boolean).length;
}

export function getSegments(token: string) {
  const normalized = token.replace(/\/+$/, '');
  if (!normalized) return [];
  return normalized.split('/').filter(Boolean);
}

export function getSegmentMatchInfo(token: string, term: string) {
  const segments = getSegments(token);
  const termLower = term.toLowerCase();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]?.toLowerCase() ?? '';
    const idx = seg.indexOf(termLower);
    if (idx === -1) continue;
    return {
      segmentIndex: i,
      segmentMatchIndex: idx,
      segmentPrefix: idx === 0,
      depth: segments.length,
    };
  }

  return null;
}

export function getCommonPrefixLen(a: string[], b: string[]) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  for (; i < max; i++) {
    if (a[i] !== b[i]) break;
  }
  return i;
}

export function getSuggestions(
  suggestions: {
    dirs: PathSuggestion[];
    files: PathSuggestion[];
    allSuggestions: PathSuggestion[];
  },
  term: string
) {
  const query = term.trim();
  const trimmed = query.toLowerCase();

  if (!trimmed) {
    const topDirs = suggestions.dirs.filter((s) => isTopLevelToken(s.token));
    const topFiles = suggestions.files.filter((s) => isTopLevelToken(s.token));
    return [...topDirs, ...topFiles].slice(0, MAX_DEFAULT_SUGGESTIONS);
  }

  type Candidate = {
    item: PathSuggestion;
    /** Higher is better, following VS Code's fuzzy scorer. */
    fuzzyScore: number;
  };

  const candidates: Candidate[] = [];
  for (const item of suggestions.allSuggestions) {
    const fuzzyScore = scoreMentionMatch(query, item.token);
    if (fuzzyScore === null) continue;
    candidates.push({ item, fuzzyScore });
  }

  const compareMatchQuality = (a: Candidate, b: Candidate) => {
    return b.fuzzyScore - a.fuzzyScore;
  };

  // If user is typing a path (contains `/`), prioritize matches by path prefix depth.
  if (trimmed.includes('/')) {
    const termSegments = trimmed.replace(/\/+$/, '').split('/').filter(Boolean);

    const sorted = candidates.sort((a, b) => {
      const aSegs = getSegments(a.item.token).map((x) => x.toLowerCase());
      const bSegs = getSegments(b.item.token).map((x) => x.toLowerCase());
      const aPrefix = getCommonPrefixLen(aSegs, termSegments);
      const bPrefix = getCommonPrefixLen(bSegs, termSegments);
      if (aPrefix !== bPrefix) return bPrefix - aPrefix;

      const aDepth = aSegs.length;
      const bDepth = bSegs.length;
      if (aDepth !== bDepth) return aDepth - bDepth;

      const matchQuality = compareMatchQuality(a, b);
      if (matchQuality !== 0) return matchQuality;

      // Prefer directories only when match quality is otherwise identical.
      if (a.item.kind !== b.item.kind) return a.item.kind === 'dir' ? -1 : 1;

      return a.item.token.localeCompare(b.item.token);
    });

    return sorted.slice(0, MAX_SUGGESTIONS).map((c) => c.item);
  }

  // Otherwise, prioritize shallower (top-level) directory matches first.
  const sorted = candidates.sort((a, b) => {
    const aMatch = getSegmentMatchInfo(a.item.token, trimmed);
    const bMatch = getSegmentMatchInfo(b.item.token, trimmed);

    // Both should match because we filtered by includes, but be defensive.
    if (!aMatch && bMatch) return 1;
    if (aMatch && !bMatch) return -1;
    if (!aMatch || !bMatch) {
      const aDepth = getTokenDepth(a.item.token);
      const bDepth = getTokenDepth(b.item.token);
      if (aDepth !== bDepth) return aDepth - bDepth;
      const matchQuality = compareMatchQuality(a, b);
      if (matchQuality !== 0) return matchQuality;
      return a.item.token.localeCompare(b.item.token);
    }

    // Prefer matching in higher-level segments (top-level dir first).
    if (aMatch.segmentIndex !== bMatch.segmentIndex) {
      return aMatch.segmentIndex - bMatch.segmentIndex;
    }
    // Prefer prefix matches within the segment (e.g. "comp" -> "components" before "my-components").
    if (aMatch.segmentPrefix !== bMatch.segmentPrefix) {
      return aMatch.segmentPrefix ? -1 : 1;
    }
    // Earlier match inside segment wins.
    if (aMatch.segmentMatchIndex !== bMatch.segmentMatchIndex) {
      return aMatch.segmentMatchIndex - bMatch.segmentMatchIndex;
    }
    // Shallower path wins (e.g. "components/" before "src/components/").
    if (aMatch.depth !== bMatch.depth) {
      return aMatch.depth - bMatch.depth;
    }

    const matchQuality = compareMatchQuality(a, b);
    if (matchQuality !== 0) return matchQuality;

    // Prefer directories only when match quality is otherwise identical.
    if (a.item.kind !== b.item.kind) return a.item.kind === 'dir' ? -1 : 1;

    return a.item.token.localeCompare(b.item.token);
  });

  return sorted.slice(0, MAX_SUGGESTIONS).map((c) => c.item);
}
