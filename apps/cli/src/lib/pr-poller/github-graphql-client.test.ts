import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import { buildPrPollBatchQuery, type PrPollBatchQuery } from './graphql-batch-builder';
import {
  classifyGraphQlHttpError,
  GitHubGraphQlClient,
  mapMergeState,
  mapPullRequestStatus,
  mapStatusCheckRollupState,
  parsePrPollBatchResponse,
} from './github-graphql-client';

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
  it('parses status + CI + merged discovery buckets and rateLimit from a success body', () => {
    const outcome = parsePrPollBatchResponse(successFixtureBody(), makeBatch());

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;

    expect(outcome.batch.pullRequests).toEqual([
      {
        prNumber: 101,
        ok: true,
        pr: {
          number: 101,
          url: 'https://github.com/owner/repo/pull/101',
          status: 'open',
          headRefName: 'feat/x',
          updatedAt: '2026-07-17T08:00:00Z',
          ciState: 's',
          mergeState: 'c',
        },
      },
      {
        prNumber: 102,
        ok: true,
        pr: {
          number: 102,
          url: 'https://github.com/owner/repo/pull/102',
          status: 'draft',
          headRefName: 'feat/x',
          updatedAt: '2026-07-17T07:00:00Z',
          ciState: null,
          mergeState: null,
        },
      },
    ]);
    // The open and terminal buckets merge into one per-branch candidate list.
    expect(outcome.batch.discoveries).toEqual([
      {
        branch: 'feat/x',
        ok: true,
        prs: [
          {
            number: 99,
            url: 'https://github.com/owner/repo/pull/99',
            status: 'merged',
            headRefName: 'feat/x',
            updatedAt: '2026-07-16T10:00:00Z',
            ciState: 's',
            mergeState: 'c',
          },
        ],
      },
    ]);
    expect(outcome.batch.rateLimit).toEqual({
      cost: 2,
      remaining: 4998,
      limit: 5000,
      resetAtMs: Date.parse('2026-07-17T09:00:00Z'),
    });
  });

  it('maps MERGED/CLOSED states through the pr-detector mapping', () => {
    const body = successFixtureBody();
    const repo = body.data.repository as FixtureRepository;
    repo.p0 = prNode(101, { state: 'MERGED' }) as FixtureRepository['p0'];
    repo.p1 = prNode(102, { state: 'CLOSED' }) as FixtureRepository['p1'];

    const outcome = parsePrPollBatchResponse(body, makeBatch());
    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.batch.pullRequests[0]?.pr?.status).toBe('merged');
    expect(outcome.batch.pullRequests[1]?.pr?.status).toBe('closed');
  });

  it('HTTP 200 with errors[].type === RATE_LIMITED is rate-limited (errors inspected, not status)', () => {
    const outcome = parsePrPollBatchResponse(
      {
        data: {
          repository: null,
          rateLimit: { cost: 1, remaining: 0, limit: 5000, resetAt: '2026-07-17T10:00:00Z' },
        },
        errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
      },
      makeBatch()
    );

    expect(outcome).toEqual({
      kind: 'rate-limited',
      resetAtMs: Date.parse('2026-07-17T10:00:00Z'),
      message: 'API rate limit exceeded',
    });
  });

  it('rate-limited without rateLimit data yields a null resetAtMs (caller default freeze)', () => {
    const outcome = parsePrPollBatchResponse(
      { data: null, errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] },
      makeBatch()
    );

    expect(outcome.kind).toBe('rate-limited');
    if (outcome.kind !== 'rate-limited') return;
    expect(outcome.resetAtMs).toBeNull();
  });

  it('NOT_FOUND with a null repository is repo-not-found-or-forbidden', () => {
    const outcome = parsePrPollBatchResponse(
      {
        data: { repository: null, rateLimit: null },
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }],
      },
      makeBatch()
    );

    expect(outcome).toEqual({
      kind: 'repo-not-found-or-forbidden',
      message: 'Could not resolve to a Repository',
    });
  });

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

  it('BAD_CREDENTIALS in a 200 body is token-invalid', () => {
    const outcome = parsePrPollBatchResponse(
      { data: null, errors: [{ type: 'BAD_CREDENTIALS', message: 'Bad credentials' }] },
      makeBatch()
    );
    expect(outcome.kind).toBe('token-invalid');
  });

  it('FORBIDDEN in a 200 body is repo-not-found-or-forbidden', () => {
    const outcome = parsePrPollBatchResponse(
      { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] },
      makeBatch()
    );
    expect(outcome.kind).toBe('repo-not-found-or-forbidden');
  });

  it('a structurally malformed body is a network-error (retry next cycle)', () => {
    expect(parsePrPollBatchResponse('garbage', makeBatch()).kind).toBe('network-error');
    expect(parsePrPollBatchResponse({ data: { repository: 42 } }, makeBatch()).kind).toBe(
      'network-error'
    );
  });
});

describe('classifyGraphQlHttpError', () => {
  const headersOf = (entries: Record<string, string>) => new Headers(entries);

  it('401 → token-invalid', () => {
    expect(
      classifyGraphQlHttpError({
        status: 401,
        headers: headersOf({}),
        bodyText: 'bad creds',
        nowMs: 0,
      }).kind
    ).toBe('token-invalid');
  });

  it('403 with x-ratelimit-remaining: 0 → rate-limited until x-ratelimit-reset', () => {
    const outcome = classifyGraphQlHttpError({
      status: 403,
      headers: headersOf({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1720000000' }),
      bodyText: 'API rate limit exceeded',
      nowMs: 0,
    });

    expect(outcome).toEqual({
      kind: 'rate-limited',
      resetAtMs: 1_720_000_000_000,
      message: expect.stringContaining('rate limit'),
    });
  });

  it('403 with Retry-After → rate-limited relative to now', () => {
    const outcome = classifyGraphQlHttpError({
      status: 403,
      headers: headersOf({ 'retry-after': '60' }),
      bodyText: 'secondary rate limit',
      nowMs: 100_000,
    });

    expect(outcome.kind).toBe('rate-limited');
    if (outcome.kind !== 'rate-limited') return;
    expect(outcome.resetAtMs).toBe(160_000);
  });

  it('403 with a rate-limit body but no headers → rate-limited with null reset', () => {
    const outcome = classifyGraphQlHttpError({
      status: 403,
      headers: headersOf({}),
      bodyText: 'You have exceeded a secondary rate limit',
      nowMs: 0,
    });
    expect(outcome.kind).toBe('rate-limited');
  });

  it('403 without rate-limit signals → repo-not-found-or-forbidden', () => {
    const outcome = classifyGraphQlHttpError({
      status: 403,
      headers: headersOf({}),
      bodyText: 'Resource not accessible by integration',
      nowMs: 0,
    });
    expect(outcome.kind).toBe('repo-not-found-or-forbidden');
  });

  it('404 → repo-not-found-or-forbidden', () => {
    expect(
      classifyGraphQlHttpError({
        status: 404,
        headers: headersOf({}),
        bodyText: 'not found',
        nowMs: 0,
      }).kind
    ).toBe('repo-not-found-or-forbidden');
  });

  it('5xx and other statuses → network-error', () => {
    expect(
      classifyGraphQlHttpError({
        status: 502,
        headers: headersOf({}),
        bodyText: 'bad gateway',
        nowMs: 0,
      }).kind
    ).toBe('network-error');
  });
});

describe('mapPullRequestStatus / mapStatusCheckRollupState', () => {
  it('maps GraphQL PR states identically to pr-detector', () => {
    expect(mapPullRequestStatus('MERGED', false)).toBe('merged');
    expect(mapPullRequestStatus('MERGED', true)).toBe('merged');
    expect(mapPullRequestStatus('CLOSED', false)).toBe('closed');
    expect(mapPullRequestStatus('OPEN', true)).toBe('draft');
    expect(mapPullRequestStatus('OPEN', false)).toBe('open');
    expect(mapPullRequestStatus('SOMETHING_NEW', false)).toBeNull();
  });

  it('maps rollup states to compact CI codes; unknown/absent → null', () => {
    expect(mapStatusCheckRollupState('SUCCESS')).toBe('s');
    expect(mapStatusCheckRollupState('FAILURE')).toBe('f');
    expect(mapStatusCheckRollupState('PENDING')).toBe('p');
    expect(mapStatusCheckRollupState('ERROR')).toBe('e');
    expect(mapStatusCheckRollupState('EXPECTED')).toBe('x');
    expect(mapStatusCheckRollupState('SKIPPED')).toBeNull();
    expect(mapStatusCheckRollupState(null)).toBeNull();
    expect(mapStatusCheckRollupState(undefined)).toBeNull();
  });
});

describe('mapMergeState', () => {
  const map = (mergeStateStatus: string | null | undefined, mergeable: string | null | undefined) =>
    mapMergeState({ mergeStateStatus, mergeable });

  it('maps mergeStateStatus to compact merge codes', () => {
    expect(map('CLEAN', 'MERGEABLE')).toBe('c');
    expect(map('BLOCKED', 'MERGEABLE')).toBe('b');
    expect(map('DIRTY', 'CONFLICTING')).toBe('d');
    expect(map('BEHIND', 'MERGEABLE')).toBe('h');
    expect(map('UNSTABLE', 'MERGEABLE')).toBe('u');
    expect(map('HAS_HOOKS', 'MERGEABLE')).toBe('u');
  });

  it('returns null for drafts (draft is already the PR status)', () => {
    expect(map('DRAFT', null)).toBeNull();
  });

  it('a known mergeStateStatus always wins over the mergeable fallback', () => {
    expect(map('CLEAN', 'CONFLICTING')).toBe('c');
  });

  it('falls back to mergeable=CONFLICTING only when mergeStateStatus is unknown/absent', () => {
    expect(map('UNKNOWN', 'CONFLICTING')).toBe('d');
    expect(map(null, 'CONFLICTING')).toBe('d');
    // GitHub still computing → treated as "no merge record" for now.
    expect(map('UNKNOWN', 'UNKNOWN')).toBeNull();
    expect(map('UNKNOWN', null)).toBeNull();
    expect(map(null, null)).toBeNull();
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

  it('posts the batch query with the bearer token and parses the success response', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(successFixtureBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const client = makeClient(fetchFn);

    const outcome = await client.executeBatch(makeBatch(), 'secret-token');

    expect(outcome.kind).toBe('success');
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/graphql');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('bearer secret-token');
    const payload = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
    expect(payload.query).toContain('query PrPollBatch');
    expect(payload.variables).toEqual({ owner: 'owner', name: 'repo', b0: 'feat/x' });
  });

  it('classifies non-2xx responses via the HTTP taxonomy', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response('bad credentials', { status: 401 })
    );
    const outcome = await makeClient(fetchFn).executeBatch(makeBatch(), 't');
    expect(outcome.kind).toBe('token-invalid');
  });

  it('a 200 body with invalid JSON is a network-error', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{oops', { status: 200 }));
    const outcome = await makeClient(fetchFn).executeBatch(makeBatch(), 't');
    expect(outcome.kind).toBe('network-error');
  });

  it('a thrown fetch is a network-error', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error('ECONNREFUSED');
    });
    const outcome = await makeClient(fetchFn).executeBatch(makeBatch(), 't');
    expect(outcome).toEqual({ kind: 'network-error', message: 'ECONNREFUSED' });
  });

  it('times out hung requests and reports them as network-error', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError'))
          );
        })
    );
    const outcome = await makeClient(fetchFn, { timeoutMs: 20 }).executeBatch(makeBatch(), 't');

    expect(outcome.kind).toBe('network-error');
    if (outcome.kind !== 'network-error') return;
    expect(outcome.message).toContain('timed out');
  });

  it('limits concurrency via the semaphore', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return new Response(JSON.stringify(successFixtureBody()), { status: 200 });
    });
    const client = makeClient(fetchFn, { concurrency: 2 });

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => client.executeBatch(makeBatch(), 't'))
    );

    expect(outcomes.every((outcome) => outcome.kind === 'success')).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
