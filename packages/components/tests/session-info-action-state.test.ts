import { describe, expect, it } from 'vitest';
import {
  resolveSessionInfoBarGitHubActionIds,
  shouldDisableSessionInfoBarGitHubActionForHydration,
} from '../src/components/sessions/session-info-action-state';

const BASE_INPUT = {
  canShowGitHubActions: true,
  hasExistingPr: false,
  workspaceDirty: false,
  hasUnpublishedWork: false,
  hasChanges: false,
  isAgentBusy: false,
};

describe('resolveSessionInfoBarGitHubActionIds', () => {
  it('offers Create PR and Commit & Push for a dirty GitHub-capable workspace without a PR', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        workspaceDirty: true,
        hasUnpublishedWork: true,
        hasChanges: true,
      })
    ).toEqual(['create-pr', 'create-draft-pr', 'commit-and-push']);
  });

  it('offers Create PR (but not Commit & Push) for a committed, clean GitHub-capable workspace without a PR', () => {
    // The agent committed everything: tree is clean (not dirty) but there are
    // real committed changes to open a PR from. Create PR must still show;
    // Commit & Push must not, since there is nothing uncommitted to commit.
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        workspaceDirty: false,
        hasChanges: true,
      })
    ).toEqual(['create-pr', 'create-draft-pr']);
  });

  it('does not offer Create PR before the workspace has any changes', () => {
    expect(resolveSessionInfoBarGitHubActionIds(BASE_INPUT)).toEqual([]);
  });

  it('keeps commit and push for a dirty PR workspace', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        hasExistingPr: true,
        workspaceDirty: true,
        hasUnpublishedWork: true,
      })
    ).toEqual(['commit-and-push']);
  });

  it('does not infer an action from review comments on a clean PR', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        hasExistingPr: true,
      })
    ).toEqual([]);
  });

  it('offers Commit & Push ahead of Ready for review on a dirty draft PR', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        hasExistingPr: true,
        workspaceDirty: true,
        hasUnpublishedWork: true,
        prStatus: 'draft',
        prMergeState: 'd',
        prCiState: 'f',
        prReadiness: 'y',
      })
    ).toEqual(['commit-and-push', 'ready-for-review']);
  });

  it('offers only Ready for review on a clean draft PR', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        hasExistingPr: true,
        prStatus: 'draft',
        prMergeState: 'd',
        prCiState: 'f',
        prReadiness: 'y',
      })
    ).toEqual(['ready-for-review']);
  });

  it('ranks conflict repair, CI repair, and direct merge when the worktree is clean', () => {
    const existingPr = {
      ...BASE_INPUT,
      hasExistingPr: true,
      prStatus: 'open' as const,
    };

    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...existingPr,
        prMergeState: 'd',
        prCiState: 'f',
        prReadiness: 'n',
      })
    ).toEqual(['resolve-conflicts', 'fix-ci-errors']);
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...existingPr,
        prMergeState: 'c',
        prCiState: 'f',
        prReadiness: 'n',
      })
    ).toEqual(['fix-ci-errors']);
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...existingPr,
        prMergeState: 'c',
        prCiState: 's',
        prReadiness: 'y',
      })
    ).toEqual(['merge']);
  });

  it('puts Commit & Push ahead of conflict repair, CI repair, and merge on a dirty PR', () => {
    // The machine no longer auto-commits at the end of a turn, so a dirty tree
    // means the PR head is NOT the author's latest work. Merging or "fixing" CI
    // first would act on a stale head, so the uncommitted work leads and the
    // rest stay reachable through the chevron.
    const dirtyPr = {
      ...BASE_INPUT,
      hasExistingPr: true,
      workspaceDirty: true,
      hasUnpublishedWork: true,
      prStatus: 'open' as const,
    };

    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...dirtyPr,
        prMergeState: 'd',
        prCiState: 'f',
        prReadiness: 'n',
      })
    ).toEqual(['commit-and-push', 'resolve-conflicts', 'fix-ci-errors']);
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...dirtyPr,
        prMergeState: 'c',
        prCiState: 's',
        prReadiness: 'y',
      })
    ).toEqual(['commit-and-push', 'merge']);
  });

  it('keeps Commit & Push ahead of Merge after a commit whose push did not land', () => {
    // The regression this guards: `workspaceDirty` comes from `git status`, so it
    // goes false the instant the agent commits. A commit whose push failed leaves
    // a clean tree while the PR head is still the previous commit — and with only
    // the dirty flag the bar would drop the action and offer Merge, landing a PR
    // that is missing the local commits.
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        hasExistingPr: true,
        workspaceDirty: false,
        hasUnpublishedWork: true,
        prStatus: 'open',
        prMergeState: 'c',
        prCiState: 's',
        prReadiness: 'y',
      })
    ).toEqual(['commit-and-push', 'merge']);
  });

  it('offers Merge alone once the branch is committed AND pushed', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        hasExistingPr: true,
        prStatus: 'open',
        prMergeState: 'c',
        prCiState: 's',
        prReadiness: 'y',
      })
    ).toEqual(['merge']);
  });

  it('offers no PR action after the PR is terminal', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        hasExistingPr: true,
        workspaceDirty: true,
        hasUnpublishedWork: true,
        prStatus: 'merged',
        prReadiness: 'y',
      })
    ).toEqual([]);
  });

  it('hides agent-driven actions while the agent is busy or GitHub is unavailable', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        workspaceDirty: true,
        hasUnpublishedWork: true,
        isAgentBusy: true,
      })
    ).toEqual([]);
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        workspaceDirty: true,
        hasUnpublishedWork: true,
        canShowGitHubActions: false,
      })
    ).toEqual([]);
  });
});

describe('shouldDisableSessionInfoBarGitHubActionForHydration', () => {
  it('disables only actions that dispatch a Session Turn while the document hydrates', () => {
    for (const actionId of [
      'create-pr',
      'create-draft-pr',
      'commit-and-push',
      'fix-ci-errors',
      'resolve-conflicts',
    ] as const) {
      expect(shouldDisableSessionInfoBarGitHubActionForHydration(actionId, false)).toBe(true);
      expect(shouldDisableSessionInfoBarGitHubActionForHydration(actionId, true)).toBe(false);
    }

    expect(shouldDisableSessionInfoBarGitHubActionForHydration('ready-for-review', false)).toBe(
      false
    );
    expect(shouldDisableSessionInfoBarGitHubActionForHydration('merge', false)).toBe(false);
  });
});
