export type GitHubPullRequestUrlParts = {
  repoFullName: string;
  prNumber: number;
};

export function parseGitHubPullRequestUrl(url: string): GitHubPullRequestUrlParts | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com') {
      return null;
    }
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    if (!match) {
      return null;
    }
    const owner = match[1]?.trim();
    const repo = match[2]?.trim();
    const number = Number(match[3]);
    if (!owner || !repo || !Number.isSafeInteger(number) || number <= 0) {
      return null;
    }
    return {
      repoFullName: `${owner}/${repo}`,
      prNumber: number,
    };
  } catch {
    return null;
  }
}

export function parseGitHubPrNumber(url: string): number | null {
  return parseGitHubPullRequestUrl(url)?.prNumber ?? null;
}
