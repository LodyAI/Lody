'use client';

import { createContext, useContext, useMemo } from 'react';

export interface PrLinkTarget {
  repoFullName: string;
  prNumber: number;
}

export interface PrLinkContextValue {
  /** Callback to invoke when the user clicks any valid GitHub pull request link. */
  onOpenPrTab: (target: PrLinkTarget) => void;
}

const PrLinkContext = createContext<PrLinkContextValue | null>(null);

const GITHUB_PR_SEGMENT_PATTERN = /^[\w.-]+$/;

/**
 * Parse a GitHub pull request URL (`https://github.com/<owner>/<repo>/pull/<number>`,
 * optionally `http:`, `www.github.com`, sub-pages like `/files` or `/commits`,
 * query parameters, or fragments). Non-PR GitHub pages, other hosts, traversal
 * segments (`.` / `..`), and malformed numbers return `null`.
 */
export function parseGitHubPrLinkTarget(href: string | undefined): PrLinkTarget | null {
  if (!href) return null;
  let parsed: URL;
  try {
    parsed = new URL(href.trim());
  } catch {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 4) return null;
  const [owner, repo, section, rawNumber] = segments;
  if (
    !owner ||
    !repo ||
    owner === '.' ||
    owner === '..' ||
    repo === '.' ||
    repo === '..' ||
    !GITHUB_PR_SEGMENT_PATTERN.test(owner) ||
    !GITHUB_PR_SEGMENT_PATTERN.test(repo)
  ) {
    return null;
  }
  if (section?.toLowerCase() !== 'pull') return null;
  if (!rawNumber || !/^\d+$/.test(rawNumber)) return null;
  const prNumber = Number(rawNumber);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;

  return {
    repoFullName: `${owner}/${repo}`,
    prNumber,
  };
}

export function PrLinkProvider({
  onOpenPrTab,
  children,
}: {
  onOpenPrTab?: (target: PrLinkTarget) => void;
  children: React.ReactNode;
}) {
  const value = useMemo<PrLinkContextValue | null>(() => {
    if (!onOpenPrTab) return null;
    return { onOpenPrTab };
  }, [onOpenPrTab]);
  return <PrLinkContext.Provider value={value}>{children}</PrLinkContext.Provider>;
}

/**
 * Returns a handler for the supplied href when it points at a valid GitHub
 * pull request URL and an enclosing `PrLinkProvider` can open the in-app PR
 * panel; otherwise returns `null`. Consumers call the handler from a primary
 * unmodified link click, preventing the default external navigation.
 */
export function usePrLinkInterceptor(href: string | undefined): (() => void) | null {
  const ctx = useContext(PrLinkContext);
  const target = parseGitHubPrLinkTarget(href);
  const repoFullName = target?.repoFullName;
  const prNumber = target?.prNumber;
  return useMemo(() => {
    if (!ctx || !repoFullName || prNumber == null) return null;
    return () => ctx.onOpenPrTab({ repoFullName, prNumber });
  }, [ctx, prNumber, repoFullName]);
}
