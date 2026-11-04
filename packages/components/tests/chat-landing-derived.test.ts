import { describe, expect, it } from 'vitest';

import {
  compareChatLandingLocalProjectByRecency,
  getChatLandingBranchSelectorState,
  getChatLandingHasAnyOnlineMachine,
  getChatLandingInitialDataLoading,
  getChatLandingLocalProjectAvailability,
  getChatLandingProjectRecency,
  getChatLandingSubmitDisabled,
  getChatLandingVisibleComposerStatus,
  getSharingReviewSourcesReady,
  getSharingReviewTeamHasNoVisibleLocalResources,
  getSharingReviewTeamLooksEmpty,
  isChatLandingMachineReachable,
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

  it('ranks a multi-member project by its newest conversation', () => {
    const recency = getChatLandingProjectRecency([
      { machineId: 'machine-1', projectRun: { id: 'shop' }, lastMessageAt: 400 },
      { machineId: 'machine-2', projectRun: { id: 'shop' }, lastMessageAt: 500 },
      {
        machineId: 'machine-1',
        project: { kind: 'local', localProjectId: 'project-1' },
        lastMessageAt: 450,
      },
    ]);

    expect(recency.byGroup.get('shop')).toBe(500);
    // A group conversation is not counted against an unrelated local project.
    expect(recency.byProject.get('machine-1:project-1')).toBe(450);
  });
});

describe('compareChatLandingLocalProjectByRecency', () => {
  const project = (
    key: string,
    name: string,
    meta: { lastOpenedAtMs?: number; createdAtMs?: number } = {}
  ) => ({ key, project: { name, ...meta } });

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
});

describe('getChatLandingInitialDataLoading', () => {
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
});

describe('getChatLandingSubmitDisabled', () => {
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
});
