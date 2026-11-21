/**
 * Provider-neutral pull/merge request identity. Every provider that Lody can
 * link registers a parser here; a URL no parser accepts is "not supported yet".
 * Only GitHub is registered today.
 */
export type PullRequestProvider = 'github';

export type PullRequestUrlParts = {
  provider: PullRequestProvider;
  host: string;
  /** `owner/repo` as written in the URL (case preserved). */
  repoFullName: string;
  number: number;
  /** The URL without suffixes, query or fragment, case preserved. */
  canonicalUrl: string;
  /** Case-folded canonical URL: the identity used for every comparison and record key. */
  key: string;
};

type ProviderParser = (url: URL) => PullRequestUrlParts | null;

const parseGitHub: ProviderParser = (parsed) => {
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  const owner = match?.[1]?.trim();
  const repo = match?.[2]?.trim();
  const number = Number(match?.[3]);
  if (!owner || !repo || !Number.isSafeInteger(number) || number <= 0) return null;
  const canonicalUrl = `https://github.com/${owner}/${repo}/pull/${number}`;
  return {
    provider: 'github',
    host: 'github.com',
    repoFullName: `${owner}/${repo}`,
    number,
    canonicalUrl,
    key: canonicalUrl.toLowerCase(),
  };
};

const PROVIDERS: readonly ProviderParser[] = [parseGitHub];

export function parsePullRequestUrl(url: string): PullRequestUrlParts | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  for (const parse of PROVIDERS) {
    const result = parse(parsed);
    if (result) return result;
  }
  return null;
}

/** Comparison key of a supported URL; null when no provider accepts it. */
export function pullRequestUrlKey(url: string): string | null {
  return parsePullRequestUrl(url)?.key ?? null;
}
