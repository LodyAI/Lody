import { describe, expect, it } from 'vitest';
import {
  resolveSessionInfoBarGitHubActionIds,
  shouldDisableSessionInfoBarGitHubActionForHydration,
} from '../src/components/sessions/session-info-action-state';

const BASE_INPUT = {
  canShowGitHubActions: true,
  hasExistingPr: false,
  workspaceDirty: false,
  hasChanges: false,
  isAgentBusy: false,
};

describe('resolveSessionInfoBarGitHubActionIds', () => {
  it('offers Create PR and Commit & Push for a dirty GitHub-capable workspace without a PR', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        workspaceDirty: true,
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

  it('offers Ready for review instead of merge or repair actions for a draft PR', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        hasExistingPr: true,
        workspaceDirty: true,
        prStatus: 'draft',
        prMergeState: 'd',
        prCiState: 'f',
        prReadiness: 'y',
      })
    ).toEqual(['ready-for-review']);
  });

  it('prioritizes conflict repair, CI repair, and direct merge over workspaceDirty', () => {
    const existingPr = {
      ...BASE_INPUT,
      hasExistingPr: true,
      workspaceDirty: true,
      prStatus: 'open' as const,
    };

    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...existingPr,
        prMergeState: 'd',
        prCiState: 'f',
        prReadiness: 'n',
      })
    ).toEqual(['resolve-conflicts']);
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

  it('offers no PR action after the PR is terminal', () => {
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        hasExistingPr: true,
        workspaceDirty: true,
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
        isAgentBusy: true,
      })
    ).toEqual([]);
    expect(
      resolveSessionInfoBarGitHubActionIds({
        ...BASE_INPUT,
        workspaceDirty: true,
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
