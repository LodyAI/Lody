import { resolveSessionPullRequests, parseGitHubPullRequestUrl } from '@lody/shared';
import { z } from 'zod';

const repo = z.object({ full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/) });
const run = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  workflow_id: z.number().int().positive(),
  head_sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  head_branch: z.string().nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
  updated_at: z.string(),
  html_url: z.string().url(),
  repository: repo,
  head_repository: repo.nullable(),
  pull_requests: z.array(z.object({ number: z.number().int().positive() })),
});
export type WorkflowRunObservation = {
  runId: number;
  attempt: number;
  workflowId: number;
  headSha: string;
  branch: string | null;
  status: string;
  conclusion: string | null;
  updatedAt: number;
  url: string;
  repository: string;
  headRepository: string | null;
  prNumbers: number[];
};

export function parseWorkflowRuns(
  input: unknown,
  repository: string
): { runs: WorkflowRunObservation[]; gap: boolean } {
  const parsed = z
    .object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(run).max(100) })
    .parse(input);
  const runs = parsed.workflow_runs.map((value) => {
    if (
      value.repository.full_name.toLowerCase() !== repository.toLowerCase() ||
      !Number.isFinite(Date.parse(value.updated_at))
    )
      throw new Error('WORKFLOW_SOURCE_IDENTITY_INVALID');
    return {
      runId: value.id,
      attempt: value.run_attempt,
      workflowId: value.workflow_id,
      headSha: value.head_sha,
      branch: value.head_branch,
      status: value.status,
      conclusion: value.conclusion,
      updatedAt: Date.parse(value.updated_at),
      url: value.html_url,
      repository: repository.toLowerCase(),
      headRepository: value.head_repository?.full_name.toLowerCase() ?? null,
      prNumbers: value.pull_requests.map((pr) => pr.number),
    };
  });
  return { runs, gap: parsed.total_count > runs.length };
}

/** Select only the currently associated PR in this repository, using this round's trusted HEAD. */
export function selectWorkflowHead(
  meta: import('@lody/shared').SessionMeta,
  repository: string,
  observations: readonly import('./github-graphql-client').PrObservation[]
): string | undefined {
  const pr = resolveSessionPullRequests(meta)
    .filter(
      (item) =>
        parseGitHubPullRequestUrl(item.url)?.repoFullName.toLowerCase() === repository.toLowerCase()
    )
    .at(-1);
  const current = pr && observations.find((item) => item.url === pr.url);
  return current?.headRepository === repository.toLowerCase() &&
    /^[a-f0-9]{40,64}$/i.test(current.headSha ?? '')
    ? current.headSha
    : undefined;
}
