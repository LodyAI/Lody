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
    if (prStatus === 'draft') return ['ready-for-review'];
    if (prMergeState === 'd') return ['resolve-conflicts'];
    if (prCiState === 'f' || prCiState === 'e') return ['fix-ci-errors'];
    if (prReadiness === 'y') return ['merge'];
    return workspaceDirty ? ['commit-and-push'] : [];
  }

  // No PR yet. "Create PR" is gated on whether the GitHub-capable workspace has
  // ANY changes to base a PR on (committed or uncommitted), not on the
  // working-tree-dirty flag alone — the latter vanished the moment the agent
  // auto-committed (clean tree, real commits, still no PR), hiding the action.
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
