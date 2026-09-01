import type { TFunction } from 'i18next';
import type {
  GitHubCheckRun,
  GitHubCheckRunsSummary,
  GitHubPullRequestDetails,
} from '@lody/shared';

const MAX_FAILED_RUNS = 12;
const MAX_PROMPT_LENGTH = 6_000;

const FAILED_CONCLUSIONS = new Set<GitHubCheckRun['conclusion']>([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
]);

export function isFailedPrCheckRun(run: GitHubCheckRun): boolean {
  return run.status === 'completed' && FAILED_CONCLUSIONS.has(run.conclusion);
}

export function buildFixCiErrorsPrompt(
  args: {
    repoFullName: string;
    pullRequest: GitHubPullRequestDetails;
    checkRuns: GitHubCheckRunsSummary;
  },
  t: TFunction
): string | null {
  const failedRuns = args.checkRuns.runs.filter(isFailedPrCheckRun).slice(0, MAX_FAILED_RUNS);
  if (failedRuns.length === 0) return null;

  const failedCheckLines = failedRuns.map((run) => {
    const app = run.appName ? ` · ${run.appName}` : '';
    const url = run.htmlUrl ? ` · ${run.htmlUrl}` : '';
    return `- ${run.name}${app} · ${run.conclusion ?? run.status}${url}`;
  });

  const omitted = args.checkRuns.runs.filter(isFailedPrCheckRun).length - failedRuns.length;
  if (omitted > 0) {
    failedCheckLines.push(
      t('sessions.prompts.fixCiErrors.moreFailures', {
        count: omitted,
      })
    );
  }
  return t('sessions.prompts.fixCiErrors', {
    repoFullName: args.repoFullName,
    prNumber: args.pullRequest.number,
    prUrl: args.pullRequest.htmlUrl,
    baseRef: args.pullRequest.baseRef,
    headRef: args.pullRequest.headRef,
    headSha: args.pullRequest.headSha,
    failedChecks: failedCheckLines.join('\n'),
  }).slice(0, MAX_PROMPT_LENGTH);
}

export function buildResolvePrConflictsPrompt(
  args: {
    repoFullName: string;
    prNumber: number | null;
    prUrl: string;
  },
  t: TFunction
): string {
  const prLabel = args.prNumber ? `#${args.prNumber}` : args.prUrl;
  return t('sessions.prompts.resolveConflicts', {
    repoFullName: args.repoFullName,
    prLabel,
    prUrl: args.prUrl,
  });
}
