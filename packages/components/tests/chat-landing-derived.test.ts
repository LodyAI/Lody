import { describe, expect, it } from 'vitest';

import {
  buildChatLandingPreSelectionKey,
  buildChatLandingProjectSelectionNavigation,
  compareChatLandingLocalProjectByRecency,
  compareChatLandingRepositoryByRecency,
  getChatLandingBranchSelectorState,
  getChatLandingHasAnyOnlineMachine,
  getChatLandingHintType,
  getChatLandingInitialDataLoading,
  getChatLandingLocalProjectAvailability,
  getChatLandingProjectRecency,
  getChatLandingSelectedMachineProjectStatus,
  getChatLandingSubmitDisabled,
  getChatLandingVisibleComposerStatus,
  getSharingReviewActionTarget,
  getSharingReviewSourceRevision,
  getSharingReviewSourcesReady,
  getSharingReviewTeamHasNoVisibleLocalResources,
  getSharingReviewTeamLooksEmpty,
  getSelectedLocalProjectKey,
  isChatLandingMachineReachable,
  parseChatLandingSearch,
  shouldRetrySharingReviewConflict,
  createChatLandingProjectSelectionKey,
} from '../src/components/chat/chat-landing-derived';

const onlineMachineIds = new Set(['github-runner']);
const isMachineOnline = (machineId: string) => onlineMachineIds.has(machineId);

describe('sharing review readiness and action', () => {
  const readySources = {
    docMetaCacheReady: true,
    visibleMachinesLoading: false,
    visibleLocalProjectsLoading: false,
    repositoriesReady: true,
    isMetaRoomFirstSyncPending: false,
  };

  it('waits for the first remote metadata sync before reconciling', () => {
    expect(getSharingReviewSourcesReady(readySources)).toBe(true);
    expect(
      getSharingReviewSourcesReady({ ...readySources, isMetaRoomFirstSyncPending: true })
    ).toBe(false);
  });

  it('routes machine privacy to Machines and leaves observer-only notices informational', () => {
    expect(getSharingReviewActionTarget({ privateMachineCount: 1, privateProjectCount: 1 })).toBe(
      'machines'
    );
    expect(getSharingReviewActionTarget({ privateMachineCount: 0, privateProjectCount: 1 })).toBe(
      'projects'
    );
    expect(
      getSharingReviewActionTarget({ privateMachineCount: 0, privateProjectCount: 0 })
    ).toBeNull();
  });

  it('retries only a latest conflict against an older attempt from this writer', () => {
    expect(
      shouldRetrySharingReviewConflict({
        writerId: 'writer-a',
        attempt: 2,
        serverWriterId: 'writer-a',
        serverAttempt: 1,
        isLatestAttempt: true,
      })
    ).toBe(true);
    expect(
      shouldRetrySharingReviewConflict({
        writerId: 'writer-a',
        attempt: 2,
        serverWriterId: 'writer-b',
        serverAttempt: 3,
        isLatestAttempt: true,
      })
    ).toBe(false);
    expect(
      shouldRetrySharingReviewConflict({
        writerId: 'writer-a',
        attempt: 2,
        serverWriterId: 'writer-a',
        serverAttempt: 1,
        isLatestAttempt: false,
      })
    ).toBe(false);
    expect(
      shouldRetrySharingReviewConflict({
        writerId: 'writer-a',
        attempt: 2,
        serverWriterId: 'writer-a',
        serverAttempt: 2,
        isLatestAttempt: true,
      })
    ).toBe(false);
  });
});

describe('getSharingReviewSourceRevision', () => {
  it('returns a fixed-length deterministic revision that includes tail changes', () => {
    const manyProjects = Array.from({ length: 300 }, (_, index) => `project-${index}`).join(',');
    const first = getSharingReviewSourceRevision(['members:a,b', `projects:${manyProjects}:a`]);
    const repeated = getSharingReviewSourceRevision(['members:a,b', `projects:${manyProjects}:a`]);
    const tailChanged = getSharingReviewSourceRevision([
      'members:a,b',
      `projects:${manyProjects}:b`,
    ]);

    expect(first).toHaveLength(19);
    expect(repeated).toBe(first);
    expect(tailChanged).not.toBe(first);
  });
});

describe('getSharingReviewTeamLooksEmpty', () => {
  const emptyState = {
    sourcesReady: true,
    machineCount: 0,
    localProjectCount: 0,
    activeSessionCount: 0,
    archivedSessionCount: 0,
    githubRepositoryCount: 0,
  };

  it('waits for all sources before reporting an empty team workspace', () => {
    expect(getSharingReviewTeamLooksEmpty({ ...emptyState, sourcesReady: false })).toBe(false);
    expect(getSharingReviewTeamLooksEmpty(emptyState)).toBe(true);
  });

  it('counts GitHub repositories and archived sessions as visible content', () => {
    expect(getSharingReviewTeamLooksEmpty({ ...emptyState, githubRepositoryCount: 1 })).toBe(false);
    expect(getSharingReviewTeamLooksEmpty({ ...emptyState, archivedSessionCount: 1 })).toBe(false);
  });
});

describe('getSharingReviewTeamHasNoVisibleLocalResources', () => {
  it('reports missing team-local resources after their sources are ready', () => {
    expect(
      getSharingReviewTeamHasNoVisibleLocalResources({
        sourcesReady: false,
        machineCount: 0,
        localProjectCount: 0,
      })
    ).toBe(false);
    expect(
      getSharingReviewTeamHasNoVisibleLocalResources({
        sourcesReady: true,
        machineCount: 0,
        localProjectCount: 0,
      })
    ).toBe(true);
  });

  it('still reports missing local resources when GitHub content makes the workspace non-empty', () => {
    expect(
      getSharingReviewTeamLooksEmpty({
        sourcesReady: true,
        machineCount: 0,
        localProjectCount: 0,
        activeSessionCount: 0,
        archivedSessionCount: 0,
        githubRepositoryCount: 1,
      })
    ).toBe(false);
    expect(
      getSharingReviewTeamHasNoVisibleLocalResources({
        sourcesReady: true,
        machineCount: 0,
        localProjectCount: 0,
      })
    ).toBe(true);
  });

  it('stops reporting once a machine or local project is visible', () => {
    expect(
      getSharingReviewTeamHasNoVisibleLocalResources({
        sourcesReady: true,
        machineCount: 1,
        localProjectCount: 0,
      })
    ).toBe(false);
    expect(
      getSharingReviewTeamHasNoVisibleLocalResources({
        sourcesReady: true,
        machineCount: 0,
        localProjectCount: 1,
      })
    ).toBe(false);
  });
});

describe('getChatLandingProjectRecency', () => {
  it('aggregates latest lastMessageAt by GitHub repo and local project key', () => {
    const recency = getChatLandingProjectRecency([
      {
        machineId: 'machine-1',
        project: { kind: 'github', repoFullName: 'owner/beta' },
        lastMessageAt: 200,
      },
      {
        machineId: 'machine-1',
        project: { kind: 'github', repoFullName: 'owner/beta' },
        lastMessageAt: 250,
      },
      {
        machineId: 'machine-1',
        project: { kind: 'local', localProjectId: 'project-1' },
        lastMessageAt: 100,
      },
      {
        machineId: 'machine-2',
        project: { kind: 'local', localProjectId: 'project-1' },
        lastMessageAt: 300,
      },
      {
        machineId: 'machine-1',
        repoFullName: 'owner/legacy',
        lastMessageAt: 150,
      },
    ]);

    expect(recency.byRepo.get('owner/beta')).toBe(250);
    expect(recency.byRepo.get('owner/legacy')).toBe(150);
    expect(recency.byProject.get('machine-1:project-1')).toBe(100);
    expect(recency.byProject.get('machine-2:project-1')).toBe(300);
  });

  it('ignores missing and non-finite lastMessageAt values', () => {
    const recency = getChatLandingProjectRecency([
      {
        machineId: 'machine-1',
        project: { kind: 'github', repoFullName: 'owner/alpha' },
      },
      {
        machineId: 'machine-1',
        project: { kind: 'local', localProjectId: 'project-1' },
        lastMessageAt: Number.NaN,
      },
    ]);

    expect(recency.byRepo.has('owner/alpha')).toBe(false);
    expect(recency.byProject.has('machine-1:project-1')).toBe(false);
  });
});

describe('compareChatLandingRepositoryByRecency', () => {
  it('sorts repos by newest lastMessageAt and falls back to full name', () => {
    const latest = new Map([
      ['owner/beta', 200],
      ['owner/alpha', 300],
    ]);
    const repos = [
      { fullName: 'owner/gamma' },
      { fullName: 'owner/beta' },
      { fullName: 'owner/alpha' },
      { fullName: 'owner/delta' },
    ];

    expect(
      repos.sort((left, right) => compareChatLandingRepositoryByRecency(left, right, latest))
    ).toEqual([
      { fullName: 'owner/alpha' },
      { fullName: 'owner/beta' },
      { fullName: 'owner/delta' },
      { fullName: 'owner/gamma' },
    ]);
  });

  it('sorts equal timestamps alphabetically', () => {
    const latest = new Map([
      ['owner/beta', 200],
      ['owner/alpha', 200],
    ]);
    const repos = [{ fullName: 'owner/beta' }, { fullName: 'owner/alpha' }];

    expect(
      repos.sort((left, right) => compareChatLandingRepositoryByRecency(left, right, latest))
    ).toEqual([{ fullName: 'owner/alpha' }, { fullName: 'owner/beta' }]);
  });
});

describe('compareChatLandingLocalProjectByRecency', () => {
  const project = (
    key: string,
    name: string,
    meta: { lastOpenedAtMs?: number; createdAtMs?: number } = {}
  ) => ({ key, project: { name, ...meta } });

  it('sorts local projects by newest lastMessageAt and falls back to project name', () => {
    const latest = new Map([
      ['machine-1:project-beta', 200],
      ['machine-1:project-alpha', 300],
    ]);
    const projects = [
      project('machine-1:project-gamma', 'Gamma'),
      project('machine-1:project-beta', 'Beta'),
      project('machine-1:project-alpha', 'Alpha'),
      project('machine-1:project-delta', 'Delta'),
    ];

    expect(
      projects.sort((left, right) => compareChatLandingLocalProjectByRecency(left, right, latest))
    ).toEqual([
      project('machine-1:project-alpha', 'Alpha'),
      project('machine-1:project-beta', 'Beta'),
      project('machine-1:project-delta', 'Delta'),
      project('machine-1:project-gamma', 'Gamma'),
    ]);
  });

  it('falls back to project activity before project name', () => {
    const latest = new Map<string, number>();
    const projects = [
      project('machine-1:project-alpha', 'Alpha', { createdAtMs: 100 }),
      project('machine-1:project-beta', 'Beta', { lastOpenedAtMs: 300, createdAtMs: 50 }),
      project('machine-1:project-gamma', 'Gamma', { createdAtMs: 200 }),
      project('machine-1:project-delta', 'Delta'),
    ];

    expect(
      projects.sort((left, right) => compareChatLandingLocalProjectByRecency(left, right, latest))
    ).toEqual([
      project('machine-1:project-beta', 'Beta', { lastOpenedAtMs: 300, createdAtMs: 50 }),
      project('machine-1:project-gamma', 'Gamma', { createdAtMs: 200 }),
      project('machine-1:project-alpha', 'Alpha', { createdAtMs: 100 }),
      project('machine-1:project-delta', 'Delta'),
    ]);
  });

  it('uses the stable key when names and timestamps are equal', () => {
    const latest = new Map([
      ['machine-2:project-1', 200],
      ['machine-1:project-1', 200],
    ]);
    const projects = [
      project('machine-2:project-1', 'Same'),
      project('machine-1:project-1', 'Same'),
    ];

    expect(
      projects.sort((left, right) => compareChatLandingLocalProjectByRecency(left, right, latest))
    ).toEqual([project('machine-1:project-1', 'Same'), project('machine-2:project-1', 'Same')]);
  });
});

describe('getChatLandingHintType', () => {
  it('prefers no-machine over no-agent-config', () => {
    expect(
      getChatLandingHintType({
        hasNoMachine: true,
        hasNoAgentConfig: true,
        isInitialDataLoading: false,
      })
    ).toBe('no-machine');
  });

  it('returns no-agent-config when machines exist but configs do not', () => {
    expect(
      getChatLandingHintType({
        hasNoMachine: false,
        hasNoAgentConfig: true,
        isInitialDataLoading: false,
      })
    ).toBe('no-agent-config');
  });

  it('returns null when both dependencies are available', () => {
    expect(
      getChatLandingHintType({
        hasNoMachine: false,
        hasNoAgentConfig: false,
        isInitialDataLoading: false,
      })
    ).toBeNull();
  });

  it('suppresses the no-machine hint while initial data is still loading', () => {
    expect(
      getChatLandingHintType({
        hasNoMachine: true,
        hasNoAgentConfig: false,
        isInitialDataLoading: true,
      })
    ).toBeNull();
  });

  it('suppresses the no-agent-config hint while initial data is still loading', () => {
    expect(
      getChatLandingHintType({
        hasNoMachine: false,
        hasNoAgentConfig: true,
        isInitialDataLoading: true,
      })
    ).toBeNull();
  });
});

describe('getChatLandingInitialDataLoading', () => {
  it('waits for local runtime and doc metadata prerequisites', () => {
    expect(
      getChatLandingInitialDataLoading({
        isRuntimeInitializing: true,
        isVisibleMachinesLoading: false,
        isDocMetaCacheReady: true,
        localMachineStateAttempted: true,
        hasSelectableMachine: true,
      })
    ).toBe(true);

    expect(
      getChatLandingInitialDataLoading({
        isRuntimeInitializing: false,
        isVisibleMachinesLoading: false,
        isDocMetaCacheReady: false,
        localMachineStateAttempted: true,
        hasSelectableMachine: true,
      })
    ).toBe(true);

    expect(
      getChatLandingInitialDataLoading({
        isRuntimeInitializing: false,
        isVisibleMachinesLoading: false,
        isDocMetaCacheReady: true,
        localMachineStateAttempted: false,
        hasSelectableMachine: true,
      })
    ).toBe(true);
  });

  it('continues initial loading while machine visibility is pending and no local option exists', () => {
    expect(
      getChatLandingInitialDataLoading({
        isRuntimeInitializing: false,
        isVisibleMachinesLoading: true,
        isDocMetaCacheReady: true,
        localMachineStateAttempted: true,
        hasSelectableMachine: false,
      })
    ).toBe(true);
  });

  it('does not mask locally selectable machines behind a stalled visibility query', () => {
    expect(
      getChatLandingInitialDataLoading({
        isRuntimeInitializing: false,
        isVisibleMachinesLoading: true,
        isDocMetaCacheReady: true,
        localMachineStateAttempted: true,
        hasSelectableMachine: true,
      })
    ).toBe(false);
  });
});

describe('getChatLandingLocalProjectAvailability', () => {
  it('waits for machine visibility to finish loading before rejecting a preselected project', () => {
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: null,
        machineOwnerUserId: null,
        isVisibleMachinesLoading: true,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: true,
      })
    ).toBe('pending');
  });

  it('waits for doc meta cache to settle before rejecting a preselected project', () => {
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: {
          ownerUserId: 'user-1',
          localProjects: {},
        },
        machineOwnerUserId: 'user-1',
        isVisibleMachinesLoading: false,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: false,
      })
    ).toBe('pending');
  });

  it('accepts a visible project owned by the current user', () => {
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: {
          ownerUserId: 'user-1',
          localProjects: {
            'project-1': { id: 'project-1' },
          },
        },
        machineOwnerUserId: null,
        isVisibleMachinesLoading: false,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: true,
      })
    ).toBe('available');
  });

  it('rejects a selected project after loading when the project metadata is still missing', () => {
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: {
          ownerUserId: 'user-1',
          localProjects: {},
        },
        machineOwnerUserId: 'user-1',
        isVisibleMachinesLoading: false,
        isMachineFlockRemoteSynced: true,
        isDocMetaCacheReady: true,
      })
    ).toBe('unavailable');
  });

  it('holds pending for an absent machine until the meta-room first sync completes', () => {
    // Cold start: the local IndexedDB scan finished (isDocMetaCacheReady) and the
    // Convex queries resolved, but machine identity only arrives with the durable
    // meta-room remote first sync. A URL-preselected/restored project must not be
    // toasted "unavailable" in that window.
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: null,
        machineOwnerUserId: null,
        isVisibleMachinesLoading: false,
        isVisibleLocalProjectsLoading: false,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: true,
        isMetaRoomFirstSyncPending: true,
      })
    ).toBe('pending');
  });

  it('rejects an absent machine once the meta-room first sync has completed', () => {
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: null,
        machineOwnerUserId: null,
        isVisibleMachinesLoading: false,
        isVisibleLocalProjectsLoading: false,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: true,
        isMetaRoomFirstSyncPending: false,
      })
    ).toBe('unavailable');
  });

  it('waits for Machine Flock remote sync before rejecting a missing project', () => {
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: {
          ownerUserId: 'user-1',
          localProjects: {},
        },
        machineOwnerUserId: 'user-1',
        isVisibleMachinesLoading: false,
        isVisibleLocalProjectsLoading: false,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: true,
        isMetaRoomFirstSyncPending: true,
      })
    ).toBe('pending');
  });

  it('rejects a missing project after Machine Flock remote sync completes', () => {
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: {
          ownerUserId: 'user-1',
          localProjects: {},
        },
        machineOwnerUserId: 'user-1',
        isVisibleMachinesLoading: false,
        isVisibleLocalProjectsLoading: false,
        isMachineFlockRemoteSynced: true,
        isDocMetaCacheReady: true,
        isMetaRoomFirstSyncPending: false,
      })
    ).toBe('unavailable');
  });

  it('rejects projects owned by a different user when nothing is shared', () => {
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: {
          ownerUserId: 'user-2',
          localProjects: {
            'project-1': { id: 'project-1' },
          },
        },
        machineOwnerUserId: 'user-2',
        isVisibleMachinesLoading: false,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: true,
      })
    ).toBe('unavailable');
  });

  it('rejects a teammate project when only the machine is shared', () => {
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: {
          ownerUserId: 'user-2',
          localProjects: {
            'project-1': { id: 'project-1' },
          },
        },
        machineOwnerUserId: 'user-2',
        isMachineSharedWithTeam: true,
        isProjectShared: false,
        isVisibleMachinesLoading: false,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: true,
      })
    ).toBe('unavailable');
  });

  it('rejects a teammate project when only the project (not the machine) is shared', () => {
    // The CLI's machine-level dispatch authorization would reject this anyway,
    // so the UI must not pretend the project is reachable.
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: {
          ownerUserId: 'user-2',
          localProjects: {
            'project-1': { id: 'project-1' },
          },
        },
        machineOwnerUserId: 'user-2',
        isMachineSharedWithTeam: false,
        isProjectShared: true,
        isVisibleMachinesLoading: false,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: true,
      })
    ).toBe('unavailable');
  });

  it('returns pending while the shared-project query is still loading', () => {
    // Without this gate, a non-owner restoring a saved shared project would be
    // toasted as "not available" before the Convex share rows arrive.
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: {
          ownerUserId: 'user-2',
          localProjects: {
            'project-1': { id: 'project-1' },
          },
        },
        machineOwnerUserId: 'user-2',
        isMachineSharedWithTeam: true,
        isProjectShared: false,
        isVisibleMachinesLoading: false,
        isVisibleLocalProjectsLoading: true,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: true,
      })
    ).toBe('pending');
  });

  it('accepts a teammate project when both the machine and the project are shared', () => {
    expect(
      getChatLandingLocalProjectAvailability({
        currentUserId: 'user-1',
        selectedLocalProjectId: 'project-1',
        machine: {
          ownerUserId: 'user-2',
          localProjects: {
            'project-1': { id: 'project-1' },
          },
        },
        machineOwnerUserId: 'user-2',
        isMachineSharedWithTeam: true,
        isProjectShared: true,
        isVisibleMachinesLoading: false,
        isMachineFlockRemoteSynced: false,
        isDocMetaCacheReady: true,
      })
    ).toBe('available');
  });
});

describe('getChatLandingBranchSelectorState', () => {
  it('shows the branch selector for github context', () => {
    expect(
      getChatLandingBranchSelectorState({
        contextType: 'github',
        selectedRepo: 'loro-dev/lody',
        repoBranchesCount: 3,
        hasRepoDefaultBranch: true,
        hasSelectedLocalProject: false,
        selectedLocalProjectId: null,
        isRuntimeInitializing: false,
        isLoadingLocalGitState: false,
        hasLocalGit: false,
        branchOptionsCount: 0,
      }).showBranchSelector
    ).toBe(true);
  });

  it('hides the local branch selector when no project is selected', () => {
    expect(
      getChatLandingBranchSelectorState({
        contextType: 'local',
        workdirMode: 'worktree',
        selectedRepo: undefined,
        repoBranchesCount: 0,
        hasRepoDefaultBranch: false,
        hasSelectedLocalProject: false,
        selectedLocalProjectId: null,
        isRuntimeInitializing: false,
        isLoadingLocalGitState: false,
        hasLocalGit: true,
        branchOptionsCount: 3,
      }).showBranchSelector
    ).toBe(false);
  });

  it('hides the local branch selector while git state is loading', () => {
    expect(
      getChatLandingBranchSelectorState({
        contextType: 'local',
        workdirMode: 'worktree',
        selectedRepo: undefined,
        repoBranchesCount: 0,
        hasRepoDefaultBranch: false,
        hasSelectedLocalProject: true,
        selectedLocalProjectId: 'project-1',
        isRuntimeInitializing: false,
        isLoadingLocalGitState: true,
        hasLocalGit: false,
        branchOptionsCount: 0,
      }).showBranchSelector
    ).toBe(false);
  });

  it('hides branch selection for a direct local project', () => {
    expect(
      getChatLandingBranchSelectorState({
        contextType: 'local',
        workdirMode: 'local',
        selectedRepo: undefined,
        repoBranchesCount: 0,
        hasRepoDefaultBranch: false,
        hasSelectedLocalProject: true,
        selectedLocalProjectId: 'project-1',
        isRuntimeInitializing: false,
        isLoadingLocalGitState: false,
        hasLocalGit: true,
        branchOptionsCount: 3,
      }).showBranchSelector
    ).toBe(false);
  });

  it('shows enabled base branch selection for explicit worktree mode', () => {
    const state = getChatLandingBranchSelectorState({
      contextType: 'local',
      workdirMode: 'worktree',
      selectedRepo: undefined,
      repoBranchesCount: 0,
      hasRepoDefaultBranch: false,
      hasSelectedLocalProject: true,
      selectedLocalProjectId: 'project-1',
      isRuntimeInitializing: false,
      isLoadingLocalGitState: false,
      hasLocalGit: true,
      branchOptionsCount: 3,
    });

    expect(state.showBranchSelector).toBe(true);
    expect(state.isBranchDisabled).toBe(false);
  });

  it('uses stable selector keys for github and local contexts', () => {
    expect(
      getChatLandingBranchSelectorState({
        contextType: 'github',
        selectedRepo: 'loro-dev/lody',
        repoBranchesCount: 1,
        hasRepoDefaultBranch: false,
        hasSelectedLocalProject: false,
        selectedLocalProjectId: null,
        isRuntimeInitializing: false,
        isLoadingLocalGitState: false,
        hasLocalGit: false,
        branchOptionsCount: 0,
      }).branchSelectorKey
    ).toBe('github:loro-dev/lody');

    expect(
      getChatLandingBranchSelectorState({
        contextType: 'local',
        workdirMode: 'worktree',
        selectedRepo: undefined,
        repoBranchesCount: 0,
        hasRepoDefaultBranch: false,
        hasSelectedLocalProject: true,
        selectedLocalProjectId: 'project-1',
        isRuntimeInitializing: false,
        isLoadingLocalGitState: false,
        hasLocalGit: true,
        branchOptionsCount: 1,
      }).branchSelectorKey
    ).toBe('local:project-1');
  });
});

describe('getChatLandingSubmitDisabled', () => {
  it('disables submit when there is nothing to send', () => {
    expect(
      getChatLandingSubmitDisabled({
        submitting: false,
        hasBlockingImages: false,
        hasSendableContent: false,
        contextType: 'github',
        hasSelectedLocalProject: false,
        isRuntimeInitializing: false,
        isLoadingLocalGitState: false,
        hasLocalGitStateError: false,
      })
    ).toBe(true);
  });

  it('disables worktree submit while local git state is still loading', () => {
    expect(
      getChatLandingSubmitDisabled({
        submitting: false,
        hasBlockingImages: false,
        hasSendableContent: true,
        contextType: 'local',
        workdirMode: 'worktree',
        hasSelectedLocalProject: true,
        isRuntimeInitializing: false,
        isLoadingLocalGitState: true,
        hasLocalGitStateError: false,
      })
    ).toBe(true);
  });

  it('keeps direct local submit enabled while git state is loading or unavailable', () => {
    expect(
      getChatLandingSubmitDisabled({
        submitting: false,
        hasBlockingImages: false,
        hasSendableContent: true,
        contextType: 'local',
        workdirMode: 'local',
        hasSelectedLocalProject: true,
        isRuntimeInitializing: false,
        isLoadingLocalGitState: true,
        hasLocalGitStateError: true,
      })
    ).toBe(false);
  });

  it('keeps submit enabled for sendable github prompts', () => {
    expect(
      getChatLandingSubmitDisabled({
        submitting: false,
        hasBlockingImages: false,
        hasSendableContent: true,
        contextType: 'github',
        hasSelectedLocalProject: false,
        isRuntimeInitializing: false,
        isLoadingLocalGitState: false,
        hasLocalGitStateError: false,
      })
    ).toBe(false);
  });
});

describe('getChatLandingSelectedMachineProjectStatus', () => {
  const baseArgs = {
    contextType: 'local' as const,
    selectedMachineId: 'machine-1',
    hasSelectedLocalProject: false,
    hasAnyVisibleLocalProject: true,
    selectedMachineHasVisibleLocalProject: false,
    isVisibleLocalProjectsLoading: false,
    isDocMetaCacheReady: true,
  };

  it('warns when a selected local machine has no visible projects', () => {
    expect(getChatLandingSelectedMachineProjectStatus(baseArgs)).toBe(
      'no-projects-on-selected-machine'
    );
  });

  it('distinguishes an entirely empty local-project workspace', () => {
    expect(
      getChatLandingSelectedMachineProjectStatus({
        ...baseArgs,
        hasAnyVisibleLocalProject: false,
      })
    ).toBe('no-local-projects');
  });

  it('does not warn while local-project visibility is still loading', () => {
    expect(
      getChatLandingSelectedMachineProjectStatus({
        ...baseArgs,
        isVisibleLocalProjectsLoading: true,
      })
    ).toBeNull();
  });

  it('does not warn once a matching project is selected or available', () => {
    expect(
      getChatLandingSelectedMachineProjectStatus({
        ...baseArgs,
        hasSelectedLocalProject: true,
      })
    ).toBeNull();

    expect(
      getChatLandingSelectedMachineProjectStatus({
        ...baseArgs,
        selectedMachineHasVisibleLocalProject: true,
      })
    ).toBeNull();
  });
});

describe('getChatLandingVisibleComposerStatus', () => {
  it('does not surface infrastructure errors in the landing composer', () => {
    expect(
      getChatLandingVisibleComposerStatus({
        contextType: 'chat',
        composerStatus: null,
        localGitStateError: 'Failed to append to stream: connect timeout',
      })
    ).toBeNull();

    expect(
      getChatLandingVisibleComposerStatus({
        contextType: 'local',
        composerStatus: null,
        localGitStateError: 'Failed to append to stream: connect timeout',
      })
    ).toBeNull();
  });

  it('surfaces explicit actionable composer status', () => {
    expect(
      getChatLandingVisibleComposerStatus({
        contextType: 'local',
        composerStatus: { message: 'Ready', tone: 'info' },
        localGitStateError: 'Failed to append to stream: connect timeout',
      })
    ).toEqual({ message: 'Ready', tone: 'info' });
  });

  it('surfaces selected-machine project warnings only in local context', () => {
    const selectedMachineProjectStatus = {
      message: 'No local projects from this machine have been added to the workspace',
      tone: 'warning' as const,
    };

    expect(
      getChatLandingVisibleComposerStatus({
        contextType: 'local',
        composerStatus: null,
        localGitStateError: null,
        selectedMachineProjectStatus,
      })
    ).toEqual(selectedMachineProjectStatus);

    expect(
      getChatLandingVisibleComposerStatus({
        contextType: 'github',
        composerStatus: null,
        localGitStateError: null,
        selectedMachineProjectStatus,
      })
    ).toBeNull();
  });
});

describe('chat landing machine online state', () => {
  it('trusts the local desktop machine for a preselected local project before machine meta syncs', () => {
    expect(
      getChatLandingHasAnyOnlineMachine({
        localMachineId: 'local-machine',
        machines: new Map(),
        isMachineOnline,
      })
    ).toBe(true);
  });

  it('accepts an online machine even when the selected local project is on a different machine', () => {
    expect(
      getChatLandingHasAnyOnlineMachine({
        localMachineId: 'github-runner',
        machines: new Map([
          ['github-runner', { id: 'github-runner' }],
          ['project-machine', { id: 'project-machine' }],
        ]),
        isMachineOnline,
      })
    ).toBe(true);
  });

  it('uses the local desktop machine to keep known machines reachable when presence is stale', () => {
    const machines = new Map([['local-machine', { id: 'local-machine' }]]);

    expect(
      isChatLandingMachineReachable({
        machineId: 'local-machine',
        localMachineId: 'local-machine',
        machines,
        isMachineOnline,
      })
    ).toBe(true);
  });

  it('counts a desktop-known machine as online before machine meta is known', () => {
    expect(
      getChatLandingHasAnyOnlineMachine({
        localMachineId: 'local-machine',
        machines: new Map(),
        isMachineOnline,
      })
    ).toBe(true);
  });
});

describe('buildChatLandingPreSelectionKey', () => {
  const projectIntent = {
    context: 'local' as const,
    machine: 'machine-1',
    project: 'local-project-1',
    repo: undefined,
  };

  it('is stable while the URL names the same target', () => {
    expect(buildChatLandingPreSelectionKey(projectIntent)).toBe(
      buildChatLandingPreSelectionKey({ ...projectIntent })
    );
  });

  it('separates different targets', () => {
    expect(buildChatLandingPreSelectionKey(projectIntent)).not.toBe(
      buildChatLandingPreSelectionKey({ ...projectIntent, project: 'local-project-2' })
    );
  });

  it('treats each project-row selection for the same target as a new intent', () => {
    expect(
      buildChatLandingPreSelectionKey({ ...projectIntent, projectSelectionKey: 'a' })
    ).not.toBe(buildChatLandingPreSelectionKey({ ...projectIntent, projectSelectionKey: 'b' }));
  });

  it('keeps one intent stable across re-renders', () => {
    expect(buildChatLandingPreSelectionKey({ ...projectIntent, projectSelectionKey: 'a' })).toBe(
      buildChatLandingPreSelectionKey({ ...projectIntent, projectSelectionKey: 'a' })
    );
  });

  it('creates distinct project selection keys inside the same millisecond', () => {
    expect(createChatLandingProjectSelectionKey(123)).not.toBe(
      createChatLandingProjectSelectionKey(123)
    );
  });
});

describe('parseChatLandingSearch', () => {
  it('keeps the string search params the chat route understands', () => {
    expect(
      parseChatLandingSearch({
        context: 'local',
        machine: 'machine-1',
        project: 'local-project-1',
        repo: 'owner/repo',
        resetDraftKey: 'r1',
        projectSelection: 'p1',
      })
    ).toEqual({
      context: 'local',
      machine: 'machine-1',
      project: 'local-project-1',
      repo: 'owner/repo',
      resetDraftKey: 'r1',
      projectSelection: 'p1',
    });
  });

  it('drops unknown contexts and non-string values', () => {
    expect(
      parseChatLandingSearch({
        context: 'remote',
        machine: 7,
        project: null,
        projectSelection: ['p1'],
      })
    ).toEqual({
      context: undefined,
      machine: undefined,
      project: undefined,
      repo: undefined,
      resetDraftKey: undefined,
      projectSelection: undefined,
    });
  });
});

describe('getSelectedLocalProjectKey', () => {
  it('reads the chat route search under the workspace prefix', () => {
    expect(
      getSelectedLocalProjectKey('/acme/chat', 'acme', {
        context: 'local',
        machine: 'machine-1',
        project: 'local-project-1',
      })
    ).toBe('machine-1:local-project-1');
  });

  it('reads the legacy local project route', () => {
    expect(getSelectedLocalProjectKey('/acme/local/machine-1/local-project-1', 'acme')).toBe(
      'machine-1:local-project-1'
    );
  });

  it('names no project for other locations', () => {
    expect(getSelectedLocalProjectKey('/acme/chat', 'acme', { context: 'github' })).toBeNull();
    expect(getSelectedLocalProjectKey('/acme/sessions/s1', 'acme')).toBeNull();
  });
});

describe('buildChatLandingProjectSelectionNavigation', () => {
  const activation = {
    machineId: 'machine-1',
    localProjectId: 'local-project-1',
  };

  it('replaces when the URL already names the activated project', () => {
    const navigation = buildChatLandingProjectSelectionNavigation({
      ...activation,
      selectedLocalProjectKey: 'machine-1:local-project-1',
    });
    expect(navigation.replace).toBe(true);
    expect(navigation.search).toMatchObject({
      context: 'local',
      machine: 'machine-1',
      project: 'local-project-1',
    });
  });

  it('pushes when coming from another project or from no project', () => {
    expect(
      buildChatLandingProjectSelectionNavigation({
        ...activation,
        selectedLocalProjectKey: 'machine-1:local-project-2',
      }).replace
    ).toBe(false);
    expect(
      buildChatLandingProjectSelectionNavigation({
        ...activation,
        selectedLocalProjectKey: null,
      }).replace
    ).toBe(false);
  });

  it('carries a fresh selection nonce on every activation', () => {
    const first = buildChatLandingProjectSelectionNavigation({
      ...activation,
      selectedLocalProjectKey: null,
      now: 123,
    });
    const second = buildChatLandingProjectSelectionNavigation({
      ...activation,
      selectedLocalProjectKey: 'machine-1:local-project-1',
      now: 123,
    });
    expect(second.search.projectSelection).not.toBe(first.search.projectSelection);
  });
});
