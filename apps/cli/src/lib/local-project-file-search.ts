/**
 * Host-side ranking for `local-project/search-files`. The client re-ranks the
 * returned slice with its own fuzzy scorer, so this only has to make sure the
 * paths a person is likely looking for land inside the requested limit.
 */

const BASENAME_EXACT = 10_000;
const BASENAME_PREFIX = 8_000;
const BASENAME_CONTAINS = 6_000;
const PATH_PREFIX = 5_000;
const PATH_CONTAINS = 4_000;
const SUBSEQUENCE = 1_000;

function basenameOf(pathValue: string): string {
  const slash = pathValue.lastIndexOf('/');
  return slash === -1 ? pathValue : pathValue.slice(slash + 1);
}

/** Characters of `query` appear in order; rewards runs and segment starts. */
function scoreSubsequence(pathValue: string, query: string): number | null {
  let score = 0;
  let queryIndex = 0;
  let previousMatch = -2;
  for (let index = 0; index < pathValue.length && queryIndex < query.length; index += 1) {
    if (pathValue[index] !== query[queryIndex]) continue;
    const previousChar = index === 0 ? '/' : pathValue[index - 1];
    if (index === previousMatch + 1) score += 5;
    if (
      previousChar === '/' ||
      previousChar === '-' ||
      previousChar === '_' ||
      previousChar === '.'
    )
      score += 3;
    score += 1;
    previousMatch = index;
    queryIndex += 1;
  }
  return queryIndex === query.length ? score : null;
}

export function scoreLocalProjectFilePath(pathValue: string, query: string): number | null {
  const lowerPath = pathValue.toLowerCase();
  const basename = basenameOf(lowerPath);
  if (basename === query) return BASENAME_EXACT;
  if (basename.startsWith(query)) return BASENAME_PREFIX - basename.length;
  const basenameIndex = basename.indexOf(query);
  if (basenameIndex !== -1) return BASENAME_CONTAINS - basenameIndex - basename.length;
  if (lowerPath.startsWith(query)) return PATH_PREFIX - lowerPath.length / 100;
  const pathIndex = lowerPath.indexOf(query);
  if (pathIndex !== -1) return PATH_CONTAINS - pathIndex / 10 - lowerPath.length / 100;
  const subsequence = scoreSubsequence(lowerPath, query);
  return subsequence === null ? null : SUBSEQUENCE + subsequence - lowerPath.length / 100;
}

/**
 * The best `limit` paths for `query`. An empty query returns the shallowest
 * paths, which is what a menu shows before anything is typed.
 */
export function searchLocalProjectFilePaths(
  paths: readonly string[],
  query: string,
  limit: number
): string[] {
  const normalized = query.trim().replace(/^@+/u, '').toLowerCase();
  if (!normalized) {
    return [...paths]
      .sort((left, right) => {
        const depth = left.split('/').length - right.split('/').length;
        return depth === 0 ? left.localeCompare(right) : depth;
      })
      .slice(0, limit);
  }
  const scored: Array<{ path: string; score: number }> = [];
  for (const pathValue of paths) {
    const score = scoreLocalProjectFilePath(pathValue, normalized);
    if (score !== null) scored.push({ path: pathValue, score });
  }
  scored.sort((left, right) =>
    right.score === left.score ? left.path.localeCompare(right.path) : right.score - left.score
  );
  return scored.slice(0, limit).map((entry) => entry.path);
}
