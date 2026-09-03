import { execFile } from 'node:child_process';
import { z } from 'zod';

/**
 * GitHub access for the review engine, over the `gh` CLI.
 *
 * `gh` is already a hard dependency of this daemon — PR discovery shells out to
 * `gh pr list`, and the token shim exists for it — so using it here adds no new
 * requirement and inherits the same managed credentials.
 */

export type GhRunner = (
  args: readonly string[],
  repoFullName: string | null
) => Promise<{ stdout: string; exitCode: number }>;

const GH_TIMEOUT_MS = 30_000;

const PR_URL_REGEX = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i;

/** Credentials are resolved per repository, so the repo has to come from the URL. */
export const parseRepoFromPrUrl = (url: string): string | null => {
  const match = url.match(PR_URL_REGEX);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
};

/**
 * Runs `gh` with a resolved token.
 *
 * The token is passed through the environment rather than the command line so
 * it never reaches a process listing. A repository with no resolvable
 * credential fails closed: no token means no merge.
 */
export const createGhRunner =
  (resolveToken: (repoFullName: string | null) => Promise<string | null>): GhRunner =>
  async (args, repoFullName) => {
    const token = await resolveToken(repoFullName);
    if (!token) {
      return { stdout: 'no GitHub credential available', exitCode: 1 };
    }
    return await new Promise((resolve) => {
      execFile(
        'gh',
        [...args],
        {
          timeout: GH_TIMEOUT_MS,
          env: { ...process.env, GH_TOKEN: token, GH_PROMPT: 'disabled' },
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ stdout: `${stdout}${stderr}`.trim(), exitCode: 1 });
            return;
          }
          resolve({ stdout, exitCode: 0 });
        }
      );
    });
  };

const PullRequestFactsSchema = z.object({
  headRefOid: z.string().optional(),
  files: z.array(z.object({ path: z.string() })).optional(),
});

const ReviewDecisionSchema = z.object({
  /** GitHub's own rollup: `CHANGES_REQUESTED`, `APPROVED`, `REVIEW_REQUIRED`, or null. */
  reviewDecision: z.string().nullish(),
});

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const MergeMethodsSchema = z.object({
  mergeCommitAllowed: z.boolean().optional(),
  squashMergeAllowed: z.boolean().optional(),
  rebaseMergeAllowed: z.boolean().optional(),
});

/**
 * Picks a merge flag the repository actually permits.
 *
 * Preference order matches GitHub's own default emphasis; the point is only that
 * the choice comes from the repository's settings rather than from us.
 */
const resolveMergeMethod = async (
  gh: GhRunner,
  repo: string | null
): Promise<'--merge' | '--squash' | '--rebase' | null> => {
  if (!repo) {
    return null;
  }
  const result = await gh(
    ['repo', 'view', repo, '--json', 'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed'],
    repo
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const parsed = MergeMethodsSchema.safeParse(parseJson(result.stdout));
  if (!parsed.success) {
    return null;
  }
  if (parsed.data.mergeCommitAllowed) {
    return '--merge';
  }
  if (parsed.data.squashMergeAllowed) {
    return '--squash';
  }
  if (parsed.data.rebaseMergeAllowed) {
    return '--rebase';
  }
  return null;
};

export const createReviewGitHubClient = (gh: GhRunner) => ({
  readPullRequestFacts: async (
    prUrl: string
  ): Promise<{ changedPaths: string[]; headSha?: string } | undefined> => {
    const result = await gh(
      ['pr', 'view', prUrl, '--json', 'headRefOid,files'],
      parseRepoFromPrUrl(prUrl)
    );
    if (result.exitCode !== 0) {
      return undefined;
    }
    const parsed = PullRequestFactsSchema.safeParse(parseJson(result.stdout));
    if (!parsed.success) {
      return undefined;
    }
    return {
      changedPaths: (parsed.data.files ?? []).map((file) => file.path),
      ...(parsed.data.headRefOid ? { headSha: parsed.data.headRefOid } : {}),
    };
  },

  /**
   * Whether a person is blocking this pull request.
   *
   * Uses GitHub's own `reviewDecision` rollup rather than counting comments.
   * Plain comments are conversation, not a block — treating every one as
   * unresolved would stop a merge on a "nice" — while `CHANGES_REQUESTED` is
   * exactly the state where a human has said no.
   *
   * Lody cannot appear here: the engine posts an issue COMMENT, never a review,
   * so it can never contribute to this decision. (That is also why the marker on
   * its comment is for humans reading the thread, not for this check.)
   */
  hasPendingHumanReview: async (prUrl: string): Promise<boolean> => {
    const result = await gh(
      ['pr', 'view', prUrl, '--json', 'reviewDecision'],
      parseRepoFromPrUrl(prUrl)
    );
    if (result.exitCode !== 0) {
      // Unknown is not "clear to merge".
      return true;
    }
    const parsed = ReviewDecisionSchema.safeParse(parseJson(result.stdout));
    if (!parsed.success) {
      return true;
    }
    return parsed.data.reviewDecision === 'CHANGES_REQUESTED';
  },

  postPullRequestComment: async (prUrl: string, body: string): Promise<void> => {
    await gh(['pr', 'comment', prUrl, '--body', body], parseRepoFromPrUrl(prUrl));
  },

  mergePullRequest: async (prUrl: string): Promise<{ merged: boolean; message?: string }> => {
    const repo = parseRepoFromPrUrl(prUrl);
    // Ask the repository which methods it allows rather than hardcoding one.
    // A squash-only or rebase-only repository rejects `--merge` outright, so a
    // fixed flag would make every automatic merge fail there.
    const method = await resolveMergeMethod(gh, repo);
    if (!method) {
      return {
        merged: false,
        message: 'Could not determine an allowed merge method for this repository',
      };
    }
    const result = await gh(['pr', 'merge', prUrl, method], repo);
    if (result.exitCode === 0) {
      return { merged: true };
    }
    return { merged: false, message: result.stdout.trim() || 'gh pr merge failed' };
  },
});
