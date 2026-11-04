import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import { buildPrPollBatchQuery, type PrPollBatchQuery } from './graphql-batch-builder';
import { GitHubGraphQlClient, parsePrPollBatchResponse } from './github-graphql-client';

function createTestLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => {}),
  };
  return logger;
}

function makeBatch(): PrPollBatchQuery {
  const batch = buildPrPollBatchQuery({
    repoFullName: 'owner/repo',
    statusTargets: [{ prNumber: 101 }, { prNumber: 102 }],
    discoveryTargets: [{ branch: 'feat/x' }],
  });
  if (!batch) {
    throw new Error('failed to build test batch');
  }
  return batch;
}

function prNode(
  number: number,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: '2026-07-17T08:00:00Z',
    headRefName: 'feat/x',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...overrides,
  };
}

/** Recorded-shape success fixture: 2 status aliases + open/terminal discovery aliases + rateLimit. */
function successFixtureBody() {
  return {
    data: {
      repository: {
        p0: prNode(101),
        p1: prNode(102, {
          isDraft: true,
          updatedAt: '2026-07-17T07:00:00Z',
          mergeable: null,
          mergeStateStatus: 'DRAFT',
          commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        }),
        d0o: { nodes: [] },
        d0t: {
          nodes: [
            prNode(99, {
              state: 'MERGED',
              updatedAt: '2026-07-16T10:00:00Z',
            }),
          ],
        },
      },
      rateLimit: { cost: 2, remaining: 4998, limit: 5000, resetAt: '2026-07-17T09:00:00Z' },
    },
  };
}

type FixtureRepository = ReturnType<typeof successFixtureBody>['data']['repository'];

describe('parsePrPollBatchResponse', () => {
  it('a per-alias null (deleted/moved PR) is a CONFIRMED missing PR (ok: true)', () => {
    const body = successFixtureBody();
    (body.data.repository as Record<string, unknown>).p1 = null;

    const outcome = parsePrPollBatchResponse(body, makeBatch());
    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.batch.pullRequests[1]).toEqual({ prNumber: 102, pr: null, ok: true });
  });

  it('a malformed status alias fails only its own target (ok: false); others still apply', () => {
    const body = successFixtureBody();
    (body.data.repository as Record<string, unknown>).p0 = { nope: true };

    const outcome = parsePrPollBatchResponse(body, makeBatch());
    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.batch.pullRequests[0]).toEqual({ prNumber: 101, pr: null, ok: false });
    expect(outcome.batch.pullRequests[1]?.pr?.number).toBe(102);
    expect(outcome.batch.discoveries[0]?.prs).toHaveLength(1);
  });

  it('rejects an unversioned observation without suppressing independent PR results', () => {
    const body = successFixtureBody();
    (body.data.repository as Record<string, unknown>).p0 = prNode(101, { updatedAt: 'invalid' });
    const outcome = parsePrPollBatchResponse(body, makeBatch());
    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.batch.pullRequests[0]).toEqual({ prNumber: 101, pr: null, ok: false });
    expect(outcome.batch.pullRequests[1]?.pr?.number).toBe(102);
  });

  it('a malformed/missing discovery alias is NOT a confirmed empty result', () => {
    const missingBucket = successFixtureBody();
    delete (missingBucket.data.repository as Record<string, unknown>).d0o;
    const outcome = parsePrPollBatchResponse(missingBucket, makeBatch());
    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    // Candidates from the surviving bucket are discarded too: acting on only
    // one bucket could crown the wrong current PR.
    expect(outcome.batch.discoveries[0]).toEqual({ branch: 'feat/x', prs: [], ok: false });

    const malformedBucket = successFixtureBody();
    (malformedBucket.data.repository as Record<string, unknown>).d0t = { nope: true };
    const second = parsePrPollBatchResponse(malformedBucket, makeBatch());
    if (second.kind !== 'success') throw new Error('expected success');
    expect(second.batch.discoveries[0]?.ok).toBe(false);
  });
});

describe('GitHubGraphQlClient', () => {
  function makeClient(
    fetchFn: typeof fetch,
    options: { timeoutMs?: number; concurrency?: number } = {}
  ) {
    return new GitHubGraphQlClient({
      logger: createTestLogger(),
      fetchFn,
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency,
      nowMs: () => 1_720_000_000_000,
    });
  }

  it('reads workflow attempts for the requested HEAD, retains coverage gaps and rejects another repository', async () => {
    const sha = 'a'.repeat(40);
    let repository = 'owner/repo';
    let count = 1;
    const client = makeClient(async (input, options) => {
      expect(String(input)).toBe(
        `https://api.github.com/repos/owner/repo/actions/runs?per_page=100&head_sha=${sha}`
      );
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer synthetic-token');
      return new Response(
        JSON.stringify({
          total_count: count,
          workflow_runs: [
            {
              id: 7,
              run_attempt: 2,
              workflow_id: 3,
              head_sha: sha,
              head_branch: 'feature',
              status: 'completed',
              conclusion: 'failure',
              updated_at: '2026-10-25T00:00:00Z',
              html_url: 'https://github.com/owner/repo/actions/runs/7',
              repository: { full_name: repository },
              head_repository: { full_name: 'owner/repo' },
              pull_requests: [{ number: 11 }],
            },
          ],
        }),
        { headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000' } }
      );
    });
    expect(await client.executeWorkflows('owner/repo', sha, 'synthetic-token')).toMatchObject({
      kind: 'success',
      batch: {
        workflowGap: false,
        workflowRuns: [
          { runId: 7, attempt: 2, headSha: sha, repository: 'owner/repo', prNumbers: [11] },
        ],
      },
    });
    count = 101;
    expect(await client.executeWorkflows('owner/repo', sha, 'synthetic-token')).toMatchObject({
      kind: 'success',
      batch: { workflowGap: true },
    });
    repository = 'someone/else';
    expect(await client.executeWorkflows('owner/repo', sha, 'synthetic-token')).toMatchObject({
      kind: 'network-error',
    });
  });
});
