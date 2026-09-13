/**
 * Pure builder for the reconciler's batched GraphQL query (spec
 * `specs/pr-status-reconciler.md` — GitHub 请求契约): one query per
 * `(workspace, repository)` batch carrying `pullRequest(number:)` aliases for
 * known non-merged PRs and two bounded `pullRequests(headRefName:)` aliases
 * per branch-discovery target (newest open + newest merged/closed), plus a
 * top-level `rateLimit` block whose `cost`/`remaining` drive the quota
 * bucket. No review decision / review threads / check-run details — those
 * are product-level fields the background reconciler must not fetch.
 */

export type PrPollBatchStatusTarget = {
  prNumber: number;
};

export type PrPollBatchDiscoveryTarget = {
  branch: string;
};

export type PrPollDiscoveryBucket = 'open' | 'terminal';

export type PrPollBatchQuery = {
  query: string;
  /** `owner`/`name` always present; `b0..bN` branch variables for discovery aliases. */
  variables: Record<string, string>;
  statusAliases: Array<{ alias: string; prNumber: number }>;
  /** Two aliases per discovered branch: newest open + newest merged/closed. */
  discoveryAliases: Array<{ alias: string; branch: string; bucket: PrPollDiscoveryBucket }>;
  /** Targets dropped because the alias budget ran out (they stay due for the next batch). */
  truncatedStatusCount: number;
  truncatedDiscoveryCount: number;
};

export const DEFAULT_MAX_ALIASES = 20;

/** Shared PR observation fields: lifecycle + head CI rollup + mergeability. */
const PR_FIELDS = `      number
      url
      state
      isDraft
      updatedAt
      headRefName
      mergeable
      mergeStateStatus
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
            }
          }
        }
      }`;

function splitRepoFullName(repoFullName: string): { owner: string; name: string } | null {
  const match = repoFullName.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  return { owner: match[1], name: match[2] };
}

/**
 * Build the batch query. Returns null for a malformed `repoFullName`
 * (programmer error upstream — targets come from parsed PR URLs / resolved
 * project repos). PR numbers are inlined (safe integers only); branch names
 * go through variables so arbitrary branch strings can never break the query.
 * A discovery target consumes two aliases and is never split across the
 * budget boundary.
 */
export function buildPrPollBatchQuery(options: {
  repoFullName: string;
  statusTargets: readonly PrPollBatchStatusTarget[];
  discoveryTargets: readonly PrPollBatchDiscoveryTarget[];
  maxAliases?: number;
}): PrPollBatchQuery | null {
  const repo = splitRepoFullName(options.repoFullName);
  if (!repo) {
    return null;
  }
  const maxAliases = options.maxAliases ?? DEFAULT_MAX_ALIASES;

  const seenPrNumbers = new Set<number>();
  const prNumbers: number[] = [];
  for (const target of options.statusTargets) {
    if (!Number.isSafeInteger(target.prNumber) || target.prNumber <= 0) {
      continue;
    }
    if (seenPrNumbers.has(target.prNumber)) {
      continue;
    }
    seenPrNumbers.add(target.prNumber);
    prNumbers.push(target.prNumber);
  }

  const seenBranches = new Set<string>();
  const branches: string[] = [];
  for (const target of options.discoveryTargets) {
    const branch = target.branch.trim();
    if (!branch || seenBranches.has(branch)) {
      continue;
    }
    seenBranches.add(branch);
    branches.push(branch);
  }

  const statusCount = Math.min(prNumbers.length, maxAliases);
  const discoveryCount = Math.min(branches.length, Math.floor((maxAliases - statusCount) / 2));

  const statusAliases = prNumbers.slice(0, statusCount).map((prNumber, index) => ({
    alias: `p${index}`,
    prNumber,
  }));
  const discoveryAliases: PrPollBatchQuery['discoveryAliases'] = [];
  branches.slice(0, discoveryCount).forEach((branch, index) => {
    discoveryAliases.push({ alias: `d${index}o`, branch, bucket: 'open' });
    discoveryAliases.push({ alias: `d${index}t`, branch, bucket: 'terminal' });
  });

  const variableDefs = ['$owner: String!', '$name: String!'];
  for (let index = 0; index < discoveryCount; index += 1) {
    variableDefs.push(`$b${index}: String!`);
  }

  const lines: string[] = [];
  lines.push(`query PrPollBatch(${variableDefs.join(', ')}) {`);
  lines.push('  repository(owner: $owner, name: $name) {');
  for (const { alias, prNumber } of statusAliases) {
    lines.push(`    ${alias}: pullRequest(number: ${prNumber}) {`);
    lines.push(PR_FIELDS);
    lines.push('    }');
  }
  for (const { alias, bucket } of discoveryAliases) {
    const states = bucket === 'open' ? '[OPEN]' : '[MERGED, CLOSED]';
    const branchVar = `$b${alias.slice(1, -1)}`;
    lines.push(
      `    ${alias}: pullRequests(first: 1, states: ${states}, headRefName: ${branchVar}, ` +
        'orderBy: {field: UPDATED_AT, direction: DESC}) {'
    );
    lines.push('      nodes {');
    lines.push(PR_FIELDS);
    lines.push('      }');
    lines.push('    }');
  }
  lines.push('  }');
  lines.push('  rateLimit {');
  lines.push('    cost');
  lines.push('    remaining');
  lines.push('    limit');
  lines.push('    resetAt');
  lines.push('  }');
  lines.push('}');

  const variables: Record<string, string> = { owner: repo.owner, name: repo.name };
  branches.slice(0, discoveryCount).forEach((branch, index) => {
    variables[`b${index}`] = branch;
  });

  return {
    query: lines.join('\n'),
    variables,
    statusAliases,
    discoveryAliases,
    truncatedStatusCount: prNumbers.length - statusCount,
    truncatedDiscoveryCount: branches.length - discoveryCount,
  };
}
