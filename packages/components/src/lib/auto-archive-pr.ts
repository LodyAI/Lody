import type { PrStatus, SessionPullRequestMeta } from '@lody/shared';
import { pickLatestSessionArchivePr as pickLatestPr } from '@lody/shared';
export { pickLatestPr };

export type AutoArchivePrSnapshot = {
  url: string;
  status: PrStatus | null;
};

export type AutoArchivePrDecision = {
  shouldArchive: boolean;
  status: PrStatus | null;
};

export function getAutoArchivePrSnapshot(
  prs: SessionPullRequestMeta[] | undefined
): AutoArchivePrSnapshot | null {
  const latest = pickLatestPr(prs);
  if (!latest) return null;
  return {
    url: latest.url,
    status: latest.status ?? null,
  };
}

export function getAutoArchivePrDecision(args: {
  previous: AutoArchivePrSnapshot | undefined;
  current: AutoArchivePrSnapshot | null;
  archiveOnMerged: boolean;
  archiveOnClosed: boolean;
}): AutoArchivePrDecision {
  const status = args.current?.status ?? null;
  if (!args.current || (status !== 'merged' && status !== 'closed')) {
    return { shouldArchive: false, status };
  }

  if (status === 'merged' && !args.archiveOnMerged) {
    return { shouldArchive: false, status };
  }
  if (status === 'closed' && !args.archiveOnClosed) {
    return { shouldArchive: false, status };
  }

  const previous = args.previous;
  if (!previous || previous.url !== args.current.url || previous.status === status) {
    return { shouldArchive: false, status };
  }

  return { shouldArchive: true, status };
}
