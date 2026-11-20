import { z } from 'zod';
import { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import type { ISession } from '@/session/session-manager';
import { resolveGitBranch } from '@/lib/git/resolve-git-branch-name';

/**
 * Result of a PR detection for the current branch.
 */
export type DetectedPullRequest = {
  repoFullName: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  baseBranch: string;
  status: 'open' | 'closed' | 'merged' | 'draft';
};

const PR_URL_REGEX = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i;

function parseRepoFromPrUrl(url: string): string | null {
  const match = url.match(PR_URL_REGEX);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

const GhPrListItemSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  isCrossRepository: z.boolean(),
});

const GhPrListSchema = z.array(GhPrListItemSchema);
const GhRepoSchema = z.object({
  defaultBranchRef: z.object({ name: z.string().min(1) }).nullable(),
});

async function resolveBranchName(
  session: ISession,
  workdir: string,
  logger: Logger
): Promise<string | null> {
  const resolution = await resolveGitBranch(session.exec.bind(session), workdir);
  if (resolution.kind === 'branch') {
    return resolution.branch;
  }
  if (resolution.kind === 'detached') {
    logger.debug('[pr-detector] Not on a named branch (detached HEAD)');
    return null;
  }
  // Not "no PR" — we could not ask git. Say so, otherwise this is
  // indistinguishable from a branch that genuinely has no PR.
  logger.warn('[pr-detector] Could not resolve the current branch; skipping PR detection');
  return null;
}

/**
 * Detect if the current branch has an associated PR using the `gh` CLI.
 *
 * Runs `gh pr list --head <branch> --json number,url,state,headRefName,baseRefName --limit 5`
 * and parses the output.
 *
 * Returns the first open PR found, or null if none.
 */
export async function detectPullRequestForBranch(options: {
  session: ISession;
  workdir: string;
  repoFullName: string;
  branchName?: string;
  logger: Logger;
}): Promise<DetectedPullRequest | null> {
  const { session, workdir, repoFullName, logger } = options;

  // Resolve current branch name (reuse if already provided)
  const branchName = options.branchName ?? (await resolveBranchName(session, workdir, logger));

  if (!branchName) {
    return null;
  }

  try {
    const repoOutput = await session.exec(
      'gh',
      ['repo', 'view', repoFullName, '--json', 'defaultBranchRef'],
      workdir,
      false
    );
    const repo = GhRepoSchema.safeParse(JSON.parse(repoOutput.trim()));
    if (repo.success && repo.data.defaultBranchRef?.name === branchName) return null;
  } catch (error) {
    logger.debug(`[pr-detector] Could not resolve default branch: ${formatErrorMessage(error)}`);
  }

  // Use gh pr list to find PRs for this branch
  try {
    const output = await session.exec(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repoFullName,
        '--head',
        branchName,
        '--json',
        'number,url,state,isDraft,headRefName,baseRefName,isCrossRepository',
        '--limit',
        '5',
      ],
      workdir,
      false
    );

    const parsed = GhPrListSchema.safeParse(JSON.parse(output.trim()));
    if (!parsed.success) {
      logger.debug(`[pr-detector] Failed to parse gh pr list output: ${parsed.error.message}`);
      return null;
    }

    if (parsed.data.length === 0) {
      logger.debug(`[pr-detector] No PRs found for branch ${branchName}`);
      return null;
    }

    // Prefer open PRs, fall back to first result
    const candidates = parsed.data.filter((pr) => !pr.isCrossRepository);
    const openPr = candidates.find((pr) => pr.state === 'OPEN');
    const pr = openPr ?? candidates[0];
    if (!pr) {
      return null;
    }

    // A draft PR is still `OPEN` in the GraphQL state; `isDraft` is the separate
    // flag GitHub uses to distinguish it, so check it before falling back to open.
    const status =
      pr.state === 'MERGED'
        ? 'merged'
        : pr.state === 'CLOSED'
          ? 'closed'
          : pr.isDraft
            ? 'draft'
            : 'open';

    // Derive repo from the PR URL to handle fork/upstream workflows correctly.
    // URL format: https://github.com/owner/repo/pull/123
    const derivedRepo = parseRepoFromPrUrl(pr.url);

    logger.debug(`[pr-detector] Found PR #${pr.number} (${status}) for branch ${branchName}`);

    return {
      repoFullName: derivedRepo ?? repoFullName,
      prNumber: pr.number,
      prUrl: pr.url,
      branch: branchName,
      baseBranch: pr.baseRefName,
      status,
    };
  } catch (error) {
    logger.debug(
      `[pr-detector] Failed to detect PR for branch ${branchName}: ${formatErrorMessage(error)}`
    );
    return null;
  }
}
