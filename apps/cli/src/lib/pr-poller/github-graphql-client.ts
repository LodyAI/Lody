import { Effect, Semaphore, Result, Schema } from 'effect';
import {
  getServerNow,
  type PrStatus,
  type SessionPullRequestCiState,
  type SessionPullRequestMergeState,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import type { PrPollBatchQuery } from './graphql-batch-builder';

/**
 * GitHub GraphQL transport + pure provider projection (spec
 * `specs/pr-status-reconciler.md` — Provider 投影).
 *
 * The exported mapping/parsing functions are pure; the client class is a thin
 * fetch adapter. Deliberately `fetch`-based rather than a `gh` subprocess:
 * headers are directly readable (rate-limit signals), there is no process
 * management, and full error bodies are available for the error taxonomy.
 */

/** One PR observation: lifecycle + head CI rollup + mergeability, from one response. */
export type PrObservation = {
  number: number;
  url: string;
  status: PrStatus;
  headRefName: string;
  updatedAt: string;
  /** Rollup CI state of the head commit; null when the commit has no checks. */
  ciState: SessionPullRequestCiState | null;
  /** Merge/conflict state; null while GitHub is still computing it (or for drafts). */
  mergeState: SessionPullRequestMergeState | null;
};

export type ParsedPrPollBatch = {
  /**
   * One entry per requested status alias. `ok: true, pr: null` is a CONFIRMED
   * GitHub null (deleted/moved PR); `ok: false` is a malformed/missing alias —
   * a target-local failure that must not count as a successful refresh.
   */
  pullRequests: Array<{ prNumber: number; pr: PrObservation | null; ok: boolean }>;
  /**
   * One entry per discovered branch; newest open first, then newest
   * merged/closed. `ok: false` means one of the branch's aliases was
   * missing/malformed — candidates are discarded and the branch must not be
   * treated as a confirmed empty discovery.
   */
  discoveries: Array<{ branch: string; prs: PrObservation[]; ok: boolean }>;
  rateLimit: { cost: number; remaining: number; limit: number; resetAtMs: number | null } | null;
};

/**
 * Error taxonomy. No "dead until restart" outcome exists:
 * - `rate-limited`: freeze the scope until `resetAtMs` (null → caller's default freeze).
 * - `repo-not-found-or-forbidden`: cooldown 15 min → exponential backoff, cap 2 h, reset on success.
 * - `token-invalid`: invalidate the cached token, re-fetch, retry once; then same cooldown schedule.
 * - `network-error`: retry next cycle (also covers timeouts and malformed bodies).
 */
export type PrPollQueryOutcome =
  | { kind: 'success'; batch: ParsedPrPollBatch }
  | { kind: 'rate-limited'; resetAtMs: number | null; message: string }
  | { kind: 'repo-not-found-or-forbidden'; message: string }
  | { kind: 'token-invalid'; message: string }
  | { kind: 'network-error'; message: string };

export type PrPollErrorKind = Exclude<PrPollQueryOutcome['kind'], 'success'>;

/** Identical mapping to `pr-detector.ts`: MERGED→merged, CLOSED→closed, isDraft→draft, else open. */
export function mapPullRequestStatus(state: string, isDraft: boolean): PrStatus | null {
  switch (state) {
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    case 'OPEN':
      return isDraft ? 'draft' : 'open';
    default:
      return null;
  }
}

/** statusCheckRollup.state → compact CI code; unknown/absent → null (no CI record). */
export function mapStatusCheckRollupState(
  state: string | null | undefined
): SessionPullRequestCiState | null {
  switch (state) {
    case 'SUCCESS':
      return 's';
    case 'FAILURE':
      return 'f';
    case 'PENDING':
      return 'p';
    case 'ERROR':
      return 'e';
    case 'EXPECTED':
      return 'x';
    default:
      return null;
  }
}

/**
 * mergeStateStatus (+ lazily-computed `mergeable` fallback) → compact merge
 * code. A known `mergeStateStatus` always wins; only when the detailed state
 * is UNKNOWN/absent does `mergeable=CONFLICTING` map to `d`. DRAFT and the
 * remaining unknowns → null ("no merge record", refreshed next poll).
 */
export function mapMergeState(args: {
  mergeStateStatus: string | null | undefined;
  mergeable: string | null | undefined;
}): SessionPullRequestMergeState | null {
  switch (args.mergeStateStatus) {
    case 'CLEAN':
      return 'c';
    case 'BLOCKED':
      return 'b';
    case 'DIRTY':
      return 'd';
    case 'BEHIND':
      return 'h';
    case 'UNSTABLE':
    case 'HAS_HOOKS':
      return 'u';
    case 'DRAFT':
      return null;
    default:
      return args.mergeable === 'CONFLICTING' ? 'd' : null;
  }
}

const RateLimitSchema = Schema.Struct({
  cost: Schema.Number,
  remaining: Schema.Number,
  limit: Schema.Number,
  resetAt: Schema.String,
});

const PullRequestNodeSchema = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  updatedAt: Schema.String,
  headRefName: Schema.String,
  mergeable: Schema.NullOr(Schema.String),
  mergeStateStatus: Schema.NullOr(Schema.String),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
        }),
      })
    ),
  }),
});

const DiscoveryAliasSchema = Schema.Struct({
  nodes: Schema.Array(PullRequestNodeSchema),
});

const GraphQlErrorSchema = Schema.Struct({
  message: Schema.String,
  type: Schema.optional(Schema.String),
});

const BatchResponseSchema = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      // Alias keys are dynamic (`p0`, `d0o`, ...), validated per alias below.
      repository: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
      rateLimit: Schema.NullOr(RateLimitSchema),
    })
  ),
  errors: Schema.optional(Schema.Array(GraphQlErrorSchema)),
});

const BODY_LOG_LIMIT = 200;

function truncateBody(bodyText: string): string {
  return bodyText.length > BODY_LOG_LIMIT ? `${bodyText.slice(0, BODY_LOG_LIMIT)}…` : bodyText;
}

function parseResetAtMs(resetAt: string): number | null {
  const parsed = Date.parse(resetAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function projectPullRequestNode(
  node: Schema.Schema.Type<typeof PullRequestNodeSchema>
): PrObservation | null {
  const status = mapPullRequestStatus(node.state, node.isDraft);
  if (!status) {
    return null;
  }
  const rollupState = node.commits.nodes[0]?.commit.statusCheckRollup?.state;
  return {
    number: node.number,
    url: node.url,
    status,
    headRefName: node.headRefName,
    updatedAt: node.updatedAt,
    ciState: mapStatusCheckRollupState(rollupState),
    mergeState: mapMergeState({
      mergeStateStatus: node.mergeStateStatus,
      mergeable: node.mergeable,
    }),
  };
}

/**
 * Classify a non-2xx HTTP response into the error taxonomy. 403 is
 * overloaded by GitHub: it carries primary/secondary rate limits (remaining
 * 0, Retry-After, or a rate-limit message) as well as genuine permission
 * denials — inspect headers and body before deciding.
 */
export function classifyGraphQlHttpError(args: {
  status: number;
  headers: { get(name: string): string | null };
  bodyText: string;
  nowMs: number;
}): Exclude<PrPollQueryOutcome, { kind: 'success' }> {
  const { status, headers, bodyText, nowMs } = args;
  const body = truncateBody(bodyText);

  if (status === 401) {
    return { kind: 'token-invalid', message: `HTTP 401: ${body}` };
  }

  if (status === 403) {
    const retryAfterSec = Number.parseInt(headers.get('retry-after') ?? '', 10);
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      return {
        kind: 'rate-limited',
        resetAtMs: nowMs + retryAfterSec * 1000,
        message: `HTTP 403 with Retry-After ${retryAfterSec}s: ${body}`,
      };
    }
    if (headers.get('x-ratelimit-remaining') === '0') {
      const resetEpochSec = Number.parseInt(headers.get('x-ratelimit-reset') ?? '', 10);
      return {
        kind: 'rate-limited',
        resetAtMs: Number.isFinite(resetEpochSec) ? resetEpochSec * 1000 : null,
        message: `HTTP 403 with rate limit exhausted: ${body}`,
      };
    }
    if (/rate limit|abuse/i.test(bodyText)) {
      return {
        kind: 'rate-limited',
        resetAtMs: null,
        message: `HTTP 403 secondary limit: ${body}`,
      };
    }
    return { kind: 'repo-not-found-or-forbidden', message: `HTTP 403: ${body}` };
  }

  if (status === 404) {
    return { kind: 'repo-not-found-or-forbidden', message: `HTTP 404: ${body}` };
  }

  return { kind: 'network-error', message: `HTTP ${status}: ${body}` };
}

/**
 * Parse a 200 GraphQL response body. GraphQL can return 200 WITH an errors
 * array — notably `errors[].type === 'RATE_LIMITED'` — so the errors array
 * is inspected before any data is trusted. Per-alias `NOT_FOUND` errors
 * with a non-null repository are tolerated (that alias decodes to null).
 * A malformed alias fails only its own target; other aliases still apply.
 */
export function parsePrPollBatchResponse(
  body: unknown,
  batch: Pick<PrPollBatchQuery, 'statusAliases' | 'discoveryAliases'>
): PrPollQueryOutcome {
  const decoded = Schema.decodeUnknownResult(BatchResponseSchema)(body);
  if (Result.isFailure(decoded)) {
    return { kind: 'network-error', message: 'Malformed GraphQL response body' };
  }
  const response = decoded.success;
  const errors = response.errors ?? [];

  const rateLimited = errors.find((error) => error.type === 'RATE_LIMITED');
  if (rateLimited) {
    return {
      kind: 'rate-limited',
      resetAtMs: response.data?.rateLimit ? parseResetAtMs(response.data.rateLimit.resetAt) : null,
      message: rateLimited.message,
    };
  }

  const authError = errors.find(
    (error) => error.type === 'BAD_CREDENTIALS' || error.type === 'UNAUTHENTICATED'
  );
  if (authError) {
    return { kind: 'token-invalid', message: authError.message };
  }

  const forbidden = errors.find((error) => error.type === 'FORBIDDEN');
  if (forbidden) {
    return { kind: 'repo-not-found-or-forbidden', message: forbidden.message };
  }

  const repository = response.data?.repository;
  if (!repository) {
    const notFound = errors.find((error) => error.type === 'NOT_FOUND');
    return {
      kind: 'repo-not-found-or-forbidden',
      message: notFound?.message ?? 'GraphQL response has no repository data',
    };
  }

  const pullRequests: ParsedPrPollBatch['pullRequests'] = [];
  for (const { alias, prNumber } of batch.statusAliases) {
    const value = repository[alias];
    if (value === null || value === undefined) {
      // GitHub-null = confirmed missing; absent key = malformed response.
      pullRequests.push({ prNumber, pr: null, ok: value === null });
      continue;
    }
    const node = Schema.decodeUnknownResult(PullRequestNodeSchema)(value);
    const pr = Result.isSuccess(node) ? projectPullRequestNode(node.success) : null;
    pullRequests.push({ prNumber, pr, ok: pr !== null });
  }

  const discoveriesByBranch = new Map<string, { prs: PrObservation[]; ok: boolean }>();
  for (const { alias, branch } of batch.discoveryAliases) {
    let entry = discoveriesByBranch.get(branch);
    if (!entry) {
      entry = { prs: [], ok: true };
      discoveriesByBranch.set(branch, entry);
    }
    const value = repository[alias];
    if (value === null || value === undefined) {
      entry.ok = false;
      continue;
    }
    const list = Schema.decodeUnknownResult(DiscoveryAliasSchema)(value);
    if (Result.isFailure(list)) {
      entry.ok = false;
      continue;
    }
    for (const node of list.success.nodes) {
      const pr = projectPullRequestNode(node);
      if (pr) {
        entry.prs.push(pr);
      } else {
        entry.ok = false;
      }
    }
  }
  const discoveries: ParsedPrPollBatch['discoveries'] = Array.from(
    discoveriesByBranch.entries()
    // A partially-failed branch keeps no candidates: acting on only one of
    // the two buckets could crown the wrong current PR.
  ).map(([branch, { prs, ok }]) => ({ branch, prs: ok ? prs : [], ok }));

  const rateLimit = response.data?.rateLimit;
  return {
    kind: 'success',
    batch: {
      pullRequests,
      discoveries,
      rateLimit: rateLimit
        ? {
            cost: rateLimit.cost,
            remaining: rateLimit.remaining,
            limit: rateLimit.limit,
            resetAtMs: parseResetAtMs(rateLimit.resetAt),
          }
        : null,
    },
  };
}

export const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

export type GitHubGraphQlClientOptions = {
  logger: Logger;
  timeoutMs?: number;
  concurrency?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  endpoint?: string;
  /** Injectable clock (rate-limit reset math); defaults to server time. */
  nowMs?: () => number;
};

export class GitHubGraphQlClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly endpoint: string;
  private readonly nowMs: () => number;
  private readonly semaphore: Semaphore.Semaphore;

  constructor(private readonly options: GitHubGraphQlClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.endpoint = options.endpoint ?? GITHUB_GRAPHQL_ENDPOINT;
    this.nowMs = options.nowMs ?? getServerNow;
    this.semaphore = Effect.runSync(Semaphore.make(options.concurrency ?? 2));
  }

  async executeBatch(batch: PrPollBatchQuery, token: string): Promise<PrPollQueryOutcome> {
    return await Effect.runPromise(
      Semaphore.withPermits(this.semaphore, 1)(Effect.promise(() => this.doFetch(batch, token)))
    );
  }

  private async doFetch(batch: PrPollBatchQuery, token: string): Promise<PrPollQueryOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/vnd.github+json',
          'user-agent': 'lody-cli-pr-poller',
        },
        body: JSON.stringify({ query: batch.query, variables: batch.variables }),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        return classifyGraphQlHttpError({
          status: response.status,
          headers: response.headers,
          bodyText,
          nowMs: this.nowMs(),
        });
      }
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        return { kind: 'network-error', message: 'GraphQL response is not valid JSON' };
      }
      return parsePrPollBatchResponse(body, batch);
    } catch (error) {
      if (controller.signal.aborted) {
        return { kind: 'network-error', message: `Request timed out after ${this.timeoutMs}ms` };
      }
      return { kind: 'network-error', message: formatErrorMessage(error) };
    } finally {
      clearTimeout(timeout);
    }
  }
}
