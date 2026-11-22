import { resolvePreferredBranch } from './branch-selection';

export type ChatLandingBranchSnapshot = {
  branches: string[];
  defaultBranch: string | null;
  /**
   * GitHub cursor for the next branch page. Set means `branches` is a partial
   * listing, so a selection outside it may still exist on the remote.
   */
  nextPageUrl?: string | null;
};

export const getGitHubBranchesCacheId = (workspaceId: string, repoFullName: string): string =>
  `${workspaceId}:${repoFullName}`;

export const normalizeChatLandingBranches = (
  branches: string[],
  defaultBranch?: string | null
): string[] => {
  const normalized = Array.from(
    new Set(branches.map((branch) => branch.trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));
  const normalizedDefaultBranch = defaultBranch?.trim() || null;
  if (normalizedDefaultBranch && !normalized.includes(normalizedDefaultBranch)) {
    normalized.push(normalizedDefaultBranch);
    normalized.sort((a, b) => a.localeCompare(b));
  }
  return normalized;
};

export const createChatLandingBranchSnapshot = (
  branches: string[],
  defaultBranch?: string | null,
  nextPageUrl: string | null = null
): ChatLandingBranchSnapshot => {
  const normalizedDefaultBranch = defaultBranch?.trim() || null;
  return {
    branches: normalizeChatLandingBranches(branches, normalizedDefaultBranch),
    defaultBranch: normalizedDefaultBranch,
    nextPageUrl,
  };
};

export const isChatLandingBranchListPartial = (snapshot: ChatLandingBranchSnapshot): boolean =>
  Boolean(snapshot.nextPageUrl);

/**
 * Adds branches found by a later page or a remote search. `nextPageUrl`
 * replaces the cursor when a page was consumed; omit it for search results.
 */
export const mergeChatLandingBranches = (
  snapshot: ChatLandingBranchSnapshot,
  branches: string[],
  nextPageUrl?: string | null
): ChatLandingBranchSnapshot => {
  const merged = createChatLandingBranchSnapshot(
    [...snapshot.branches, ...branches],
    snapshot.defaultBranch,
    nextPageUrl === undefined ? (snapshot.nextPageUrl ?? null) : nextPageUrl
  );
  return areChatLandingBranchListsEqual(merged.branches, snapshot.branches) &&
    merged.nextPageUrl === (snapshot.nextPageUrl ?? null)
    ? snapshot
    : merged;
};

export const areChatLandingBranchListsEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((branch, index) => branch === right[index]);

export const resolveChatLandingBranchSelection = (
  snapshot: ChatLandingBranchSnapshot,
  selectedBranch: string | null
): string | null => {
  if (snapshot.branches.length === 0) {
    return null;
  }

  // A partial listing cannot prove a restored or chosen branch is gone; the
  // caller verifies it against the remote before falling back.
  const trimmedSelection = selectedBranch?.trim();
  if (
    trimmedSelection &&
    isChatLandingBranchListPartial(snapshot) &&
    !snapshot.branches.includes(trimmedSelection)
  ) {
    return trimmedSelection;
  }

  return resolvePreferredBranch({
    branches: snapshot.branches,
    preferredBranch: selectedBranch,
    repoDefaultBranch: snapshot.defaultBranch,
  });
};
