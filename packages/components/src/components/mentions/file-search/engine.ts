import { createFuzzyScoreOnly } from '../vscode-fuzzy-score';

const scoreFileMatch = createFuzzyScoreOnly();

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

export function getSegments(token: string) {
  const normalized = token.replace(/\/+$/, '');
  if (!normalized) return [];
  return normalized.split('/').filter(Boolean);
}

export function getCommonPrefixLen(a: string[], b: string[]) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  for (; i < max; i++) {
    if (a[i] !== b[i]) break;
  }
  return i;
}

export type FileSuggestionIndex = {
  dirs: PathSuggestion[];
  files: PathSuggestion[];
  allSuggestions: PathSuggestion[];
};

export type MentionFileSearchEntry = {
  paths: string[];
  lazyDirectories?: ReadonlyArray<{ path: string }>;
};

export function buildMentionFileIndex(
  entry: MentionFileSearchEntry | null,
  lazyToken: (path: string) => string | null = (path) => {
    const normalized = path.replace(/^\/+|\/+$/gu, '');
    return normalized ? `${normalized}/` : null;
  }
): FileSuggestionIndex | null {
  if (!entry) return null;
  const base = buildPathSuggestions(entry.paths);
  const tokens = base.allTokens;
  for (const lazy of entry.lazyDirectories ?? []) {
    const token = lazyToken(lazy.path);
    if (!token || tokens.has(token)) continue;
    tokens.add(token);
    base.dirs.push({ kind: 'dir', path: token.replace(/\/+$/u, ''), token });
  }
  if (base.allSuggestions.length === base.dirs.length + base.files.length) return base;
  base.dirs.sort((a, b) => a.token.localeCompare(b.token));
  return { dirs: base.dirs, files: base.files, allSuggestions: [...base.dirs, ...base.files] };
}

type PreparedPath = { item: PathSuggestion; segments: string[]; lower: string; ordinal: number };
const preparedIndexes = new WeakMap<FileSuggestionIndex, PreparedPath[]>();

/** The index is immutable; path parsing is shared by all queries against it. */
function prepare(index: FileSuggestionIndex): PreparedPath[] {
  let prepared = preparedIndexes.get(index);
  if (!prepared) {
    prepared = index.allSuggestions.map((item, ordinal) => ({
      item,
      ordinal,
      lower: item.token.toLowerCase(),
      segments: getSegments(item.token).map((part) => part.toLowerCase()),
    }));
    preparedIndexes.set(index, prepared);
  }
  return prepared;
}

type RankedPath = { path: PreparedPath; keys: number[] };
function compare(a: RankedPath, b: RankedPath): number {
  for (let i = 0; i < a.keys.length; i++) {
    const difference = a.keys[i] - b.keys[i];
    if (difference) return difference;
  }
  return a.path.item.token.localeCompare(b.path.item.token) || a.path.ordinal - b.path.ordinal;
}

/** A worst-first heap retains only the rows that can reach the menu. */
function retain(heap: RankedPath[], candidate: RankedPath, limit: number) {
  if (heap.length < limit) {
    let child = heap.push(candidate) - 1;
    while (child > 0) {
      const parent = (child - 1) >>> 1;
      if (compare(heap[parent], heap[child]) >= 0) break;
      [heap[parent], heap[child]] = [heap[child], heap[parent]];
      child = parent;
    }
    return;
  }
  if (compare(candidate, heap[0]) >= 0) return;
  heap[0] = candidate;
  let parent = 0;
  while (true) {
    let child = parent * 2 + 1;
    if (child >= heap.length) break;
    if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
    if (compare(heap[parent], heap[child]) >= 0) break;
    [heap[parent], heap[child]] = [heap[child], heap[parent]];
    parent = child;
  }
}

export function getSuggestions(index: FileSuggestionIndex, term: string, limit = MAX_SUGGESTIONS) {
  const search = searchSuggestions(index, term, limit);
  let step = search.next();
  while (!step.done) step = search.next();
  return step.value;
}

/** Yields after bounded candidate batches so a worker can handle cancellation. */
export function* searchSuggestions(
  index: FileSuggestionIndex,
  term: string,
  limit = MAX_SUGGESTIONS
): Generator<void, PathSuggestion[], void> {
  const query = term.trim();
  const lower = query.toLowerCase();
  limit = Math.max(0, Math.min(MAX_SUGGESTIONS, Math.floor(limit)));
  if (!limit) return [];
  if (!query) {
    const result: PathSuggestion[] = [];
    for (const item of index.allSuggestions) {
      if (isTopLevelToken(item.token)) result.push(item);
      if (result.length >= Math.min(limit, MAX_DEFAULT_SUGGESTIONS)) break;
    }
    return result;
  }
  const pathQuery = lower.includes('/');
  const querySegments = lower.replace(/\/+$/, '').split('/').filter(Boolean);
  const heap: RankedPath[] = [];
  let processed = 0;
  for (const path of prepare(index)) {
    if (++processed % 512 === 0) yield;
    const score = scoreFileMatch(path.item.token, query, lower, path.lower);
    if (score === 0) continue;
    const { segments, item } = path;
    let keys: number[];
    if (pathQuery) {
      keys = [
        -getCommonPrefixLen(segments, querySegments),
        segments.length,
        -score,
        item.kind === 'dir' ? 0 : 1,
      ];
    } else {
      const segmentIndex = segments.findIndex((segment) => segment.includes(lower));
      if (segmentIndex < 0) {
        keys = [1, segments.length, -score];
      } else {
        const offset = segments[segmentIndex].indexOf(lower);
        keys = [
          0,
          segmentIndex,
          offset === 0 ? 0 : 1,
          offset,
          segments.length,
          -score,
          item.kind === 'dir' ? 0 : 1,
        ];
      }
    }
    retain(heap, { path, keys }, limit);
  }
  return heap.sort(compare).map(({ path }) => path.item);
}
