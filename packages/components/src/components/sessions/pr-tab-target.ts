import {
  getSessionPullRequestLegacyFields,
  type SessionPullRequestMeta,
  type SessionPullRequestView,
} from '@lody/shared';

export interface ActivePrTab {
  repoFullName: string;
  prNumber: number;
  headCommitSha?: string;
  /** True when this PR is already associated with the current session. */
  isAssociated: boolean;
  /** True when this PR is the session's current primary work PR. */
  isCurrentWorkPr: boolean;
}

export interface SelectedPrTab {
  repoFullName: string;
  prNumber: number;
  headCommitSha?: string;
}

const PR_REPO_PARAM_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export function parsePrRepoSearchParam(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!PR_REPO_PARAM_PATTERN.test(trimmed)) return undefined;
  const [owner, repo] = trimmed.split('/');
  if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return undefined;
  }
  return trimmed;
}

export function matchesPrTabUrl(
  tab: Pick<ActivePrTab, 'repoFullName' | 'prNumber'>,
  urlPrNumber: number | undefined,
  urlPrRepo: string | undefined
): boolean {
  if (urlPrNumber == null || tab.prNumber !== urlPrNumber) return false;
  if (!urlPrRepo) return true;
  return tab.repoFullName.toLowerCase() === urlPrRepo.toLowerCase();
}

export function resolveActivePrTab({
  selectedPrTab,
  urlPrNumber,
  urlPrRepo,
  latestPr,
  latestPrNumber,
  latestPrRepoFullName,
  associatedPrViews,
}: {
  selectedPrTab: SelectedPrTab | null;
  urlPrNumber?: number;
  urlPrRepo?: string;
  latestPr?: SessionPullRequestMeta | null;
  latestPrNumber?: number | null;
  latestPrRepoFullName?: string | null;
  associatedPrViews: readonly SessionPullRequestView[];
}): ActivePrTab | null {
  const buildPrTab = (
    repoFullName: string,
    prNumber: number,
    headCommitSha?: string
  ): ActivePrTab => {
    const normalizedRepo = repoFullName.toLowerCase();
    const associatedMatch = associatedPrViews.find(
      (view) => view.number === prNumber && view.repoFullName?.toLowerCase() === normalizedRepo
    );
    const isCurrentWorkPr = Boolean(
      latestPr &&
      latestPrNumber === prNumber &&
      latestPrRepoFullName &&
      latestPrRepoFullName.toLowerCase() === normalizedRepo
    );
    const canonicalRepo =
      associatedMatch?.repoFullName ??
      (isCurrentWorkPr && latestPrRepoFullName ? latestPrRepoFullName : repoFullName);
    const resolvedHeadSha =
      headCommitSha ??
      (associatedMatch
        ? getSessionPullRequestLegacyFields(associatedMatch.pr).headCommitSha
        : isCurrentWorkPr && latestPr
          ? getSessionPullRequestLegacyFields(latestPr).headCommitSha
          : undefined);
    return {
      repoFullName: canonicalRepo,
      prNumber,
      headCommitSha: resolvedHeadSha,
      isAssociated: Boolean(associatedMatch || isCurrentWorkPr),
      isCurrentWorkPr,
    };
  };

  if (
    selectedPrTab &&
    (urlPrNumber == null || matchesPrTabUrl(selectedPrTab, urlPrNumber, urlPrRepo))
  ) {
    return buildPrTab(
      selectedPrTab.repoFullName,
      selectedPrTab.prNumber,
      selectedPrTab.headCommitSha
    );
  }

  if (urlPrNumber != null) {
    if (urlPrRepo) {
      return buildPrTab(urlPrRepo, urlPrNumber);
    }
    if (latestPr && latestPrNumber === urlPrNumber && latestPrRepoFullName) {
      return buildPrTab(
        latestPrRepoFullName,
        latestPrNumber,
        getSessionPullRequestLegacyFields(latestPr).headCommitSha
      );
    }
    const byNumber = associatedPrViews.find(
      (view) => view.number === urlPrNumber && view.repoFullName
    );
    if (byNumber && byNumber.repoFullName && byNumber.number != null) {
      return buildPrTab(
        byNumber.repoFullName,
        byNumber.number,
        getSessionPullRequestLegacyFields(byNumber.pr).headCommitSha
      );
    }
  }

  if (selectedPrTab) {
    return buildPrTab(
      selectedPrTab.repoFullName,
      selectedPrTab.prNumber,
      selectedPrTab.headCommitSha
    );
  }

  if (latestPr && latestPrRepoFullName && latestPrNumber != null) {
    return buildPrTab(
      latestPrRepoFullName,
      latestPrNumber,
      getSessionPullRequestLegacyFields(latestPr).headCommitSha
    );
  }

  const fallback = associatedPrViews.find((view) => view.repoFullName && view.number != null);
  if (fallback && fallback.repoFullName && fallback.number != null) {
    return buildPrTab(
      fallback.repoFullName,
      fallback.number,
      getSessionPullRequestLegacyFields(fallback.pr).headCommitSha
    );
  }

  return null;
}
