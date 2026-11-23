import type { GitHubPullRequestCommit, GitHubPullRequestFile } from '@lody/shared';

export type PrCommitSelection =
  | { type: 'all' }
  | { type: 'commit'; sha: string }
  | { type: 'range'; startSha: string; endSha: string };

export interface PrCompareRange {
  from: string;
  to: string;
  historical: boolean;
}

/** Resolve the immutable refs used for a PR Changes selection. */
export function resolvePrCompareRange(input: {
  baseRef: string;
  baseSha?: string;
  headSha: string;
  commits: readonly GitHubPullRequestCommit[];
  selection: PrCommitSelection;
}): PrCompareRange {
  const fallback = {
    from: input.baseSha || input.baseRef,
    to: input.headSha,
    historical: false,
  };
  if (input.selection.type === 'all') return fallback;

  const findCommit = (sha: string) => input.commits.find((commit) => commit.sha === sha);
  if (input.selection.type === 'commit') {
    const commit = findCommit(input.selection.sha);
    if (!commit) return fallback;
    return {
      from: commit.parentSha || input.baseSha || input.baseRef,
      to: commit.sha,
      historical: true,
    };
  }

  const start = findCommit(input.selection.startSha);
  const end = findCommit(input.selection.endSha);
  if (!start || !end) return fallback;
  const startIndex = input.commits.indexOf(start);
  const endIndex = input.commits.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) return fallback;
  return {
    from: start.parentSha || input.baseSha || input.baseRef,
    to: end.sha,
    historical: true,
  };
}

export function sumPrFileStats(files: readonly GitHubPullRequestFile[]) {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 }
  );
}
