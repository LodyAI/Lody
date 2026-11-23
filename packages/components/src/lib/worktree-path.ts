const WORKTREES_SEGMENT = '/worktrees/';
const WORKTREE_ID_LENGTH = 36;
const WORKTREE_ID_CHAR_PATTERN = /[0-9a-fA-F-]/;
const TOKEN_BOUNDARY_PATTERN = /[\s'"`]/;
const WORKTREE_ROOT_PREFIX_PATTERN = /^[^\s'"`]*\/worktrees\/[0-9a-fA-F-]{36}\/?/;
const WORKTREE_ROOT_ONLY_PATTERN = /^[^\s'"`]*\/worktrees\/[0-9a-fA-F-]{36}\/?$/;
const TEXT_BOUNDARY_PATTERN = /[\s'"`),\]}:;]/;

function hasRelativeTail(input: string, matchStart: number, matchLength: number): boolean {
  const nextChar = input[matchStart + matchLength] ?? '';
  return nextChar.length > 0 && !TEXT_BOUNDARY_PATTERN.test(nextChar);
}

export function normalizeWorktreePath(value: string): string {
  if (!WORKTREE_ROOT_PREFIX_PATTERN.test(value)) {
    return value;
  }

  if (WORKTREE_ROOT_ONLY_PATTERN.test(value)) {
    return '.';
  }

  return value.replace(WORKTREE_ROOT_PREFIX_PATTERN, '');
}

function hasWorktreeIdAt(input: string, segmentStart: number): boolean {
  const idStart = segmentStart + WORKTREES_SEGMENT.length;
  if (idStart + WORKTREE_ID_LENGTH > input.length) return false;
  for (let index = idStart; index < idStart + WORKTREE_ID_LENGTH; index += 1) {
    if (!WORKTREE_ID_CHAR_PATTERN.test(input[index]!)) return false;
  }
  return true;
}

/**
 * Same result as replacing `/[^\s'"`]*\/worktrees\/[0-9a-fA-F-]{36}\/?/g`, in
 * linear time. That regex has no anchor, so on a long token without a match
 * (an inline base64 image in a command) every start position rescans to the
 * token's end: quadratic, minutes of renderer time for a few hundred KB.
 *
 * Each match runs from the token start (or the previous match's end) to the
 * LAST worktree root in the token, as the greedy prefix does. Every character
 * is walked a bounded number of times because the scan position only moves
 * forward past each token it inspects.
 */
export function normalizeWorktreePathsInText(value: string): string {
  let result = '';
  let copied = 0;
  let position = 0;
  while (position < value.length) {
    const segment = value.indexOf(WORKTREES_SEGMENT, position);
    if (segment < 0) break;
    let tokenStart = segment;
    while (tokenStart > position && !TOKEN_BOUNDARY_PATTERN.test(value[tokenStart - 1]!)) {
      tokenStart -= 1;
    }
    let tokenEnd = segment;
    while (tokenEnd < value.length && !TOKEN_BOUNDARY_PATTERN.test(value[tokenEnd]!)) {
      tokenEnd += 1;
    }
    let lastRoot = -1;
    for (
      let candidate = segment;
      candidate >= 0 && candidate < tokenEnd;
      candidate = value.indexOf(WORKTREES_SEGMENT, candidate + 1)
    ) {
      if (hasWorktreeIdAt(value, candidate)) lastRoot = candidate;
    }
    if (lastRoot < 0) {
      position = tokenEnd;
      continue;
    }
    let matchEnd = lastRoot + WORKTREES_SEGMENT.length + WORKTREE_ID_LENGTH;
    if (value[matchEnd] === '/') matchEnd += 1;
    result += value.slice(copied, tokenStart);
    result += hasRelativeTail(value, tokenStart, matchEnd - tokenStart) ? '' : '.';
    copied = matchEnd;
    position = matchEnd;
  }
  return copied === 0 ? value : result + value.slice(copied);
}

export function normalizeWorktreeTitle(title: string): string {
  return normalizeWorktreePathsInText(title);
}
