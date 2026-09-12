import type {
  SessionPullRequestCiState,
  SessionPullRequestMergeState,
  SessionPullRequestReadiness,
  PrStatus,
} from '@lody/shared';

export type SessionInfoBarGitHubActionId =
  | 'create-pr'
  | 'create-draft-pr'
  | 'commit-and-push'
  | 'fix-ci-errors'
  | 'resolve-conflicts'
  | 'ready-for-review'
  | 'merge';

const SESSION_TURN_GITHUB_ACTION_IDS = new Set<SessionInfoBarGitHubActionId>([
  'create-pr',
  'create-draft-pr',
  'commit-and-push',
  'fix-ci-errors',
  'resolve-conflicts',
]);

/** Agent-driven GitHub actions need a hydrated Session Turn configuration. */
export function shouldDisableSessionInfoBarGitHubActionForHydration(
  actionId: SessionInfoBarGitHubActionId,
  sessionDocReady: boolean
): boolean {
  return !sessionDocReady && SESSION_TURN_GITHUB_ACTION_IDS.has(actionId);
}

export function resolveSessionInfoBarGitHubActionIds({
  canShowGitHubActions,
  hasExistingPr,
  workspaceDirty,
  hasChanges,
  isAgentBusy,
  prCiState,
  prMergeState,
  prReadiness,
  prStatus,
}: {
  canShowGitHubActions: boolean;
  hasExistingPr: boolean;
  workspaceDirty: boolean;
  /**
   * Whether there is anything to base a PR on — committed OR uncommitted. Gates
   * "Create PR"; see `getSessionGitHubState`. Distinct from `workspaceDirty`,
   * which is uncommitted-only and gates "Commit & Push".
   */
  hasChanges: boolean;
  isAgentBusy: boolean;
  prCiState?: SessionPullRequestCiState | null;
  prMergeState?: SessionPullRequestMergeState | null;
  prReadiness?: SessionPullRequestReadiness | null;
  prStatus?: PrStatus | null;
}): SessionInfoBarGitHubActionId[] {
  if (!canShowGitHubActions || isAgentBusy) return [];

  if (hasExistingPr) {
    if (prStatus === 'merged' || prStatus === 'closed') return [];

    // Priority order, highest first. The caller renders index 0 as the single
    // text button and hangs the rest off its chevron, so this array is the
    // whole ranking — every applicable action stays reachable.
    //
    // `commit-and-push` outranks conflict/CI repair and merge because it is the
    // only one that protects work the user can still lose. Turn finalization no
    // longer auto-commits on the session's behalf (that surprised users who had
    // not asked for a commit), so a dirty tree here means the PR head is NOT the
    // author's latest work. Offering "Merge" first on that state invites merging
    // a PR that is missing the changes still sitting in the worktree.
    const actions: SessionInfoBarGitHubActionId[] = [];
    if (workspaceDirty) {
      actions.push('commit-and-push');
    }
    if (prStatus === 'draft') {
      // A draft PR has no merge gate to clear; readiness is the user's call.
      actions.push('ready-for-review');
      return actions;
    }
    if (prMergeState === 'd') {
      actions.push('resolve-conflicts');
    }
    if (prCiState === 'f' || prCiState === 'e') {
      actions.push('fix-ci-errors');
    }
    if (prReadiness === 'y') {
      actions.push('merge');
    }
    return actions;
  }

  // No PR yet. "Create PR" is gated on whether the GitHub-capable workspace has
  // ANY changes to base a PR on (committed or uncommitted), not on the
  // working-tree-dirty flag alone — the latter vanished the moment the agent
  // committed (clean tree, real commits, still no PR), hiding the action.
  // "Commit & Push" still requires uncommitted changes; a clean tree has nothing
  // to commit.
  const actions: SessionInfoBarGitHubActionId[] = [];
  if (hasChanges) {
    // Create PR is the primary action; Create Draft PR rides its dropdown.
    actions.push('create-pr', 'create-draft-pr');
  }
  if (workspaceDirty) {
    actions.push('commit-and-push');
  }
  return actions;
}
