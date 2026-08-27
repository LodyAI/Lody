import type { ChatLandingHintType } from './chat-landing-view';
import type { SessionContextType } from './context-switch';

type ChatLandingProjectRefLike =
  | {
      kind: 'github';
      repoFullName?: string | null;
    }
  | {
      kind: 'local';
      localProjectId?: string | null;
    }
  | {
      kind?: string | null;
      repoFullName?: string | null;
      localProjectId?: string | null;
    };

export type ChatLandingProjectSession = {
  machineId: string;
  project?: ChatLandingProjectRefLike | null;
  repoFullName?: string | null;
  lastMessageAt?: number | null;
};

export type ChatLandingProjectRecency = {
  byRepo: ReadonlyMap<string, number>;
  byProject: ReadonlyMap<string, number>;
};

export type SharingReviewActionTarget = 'machines' | 'projects' | null;

export function getSharingReviewActionTarget({
  privateMachineCount,
  privateProjectCount,
}: {
  privateMachineCount: number;
  privateProjectCount: number;
}): SharingReviewActionTarget {
  if (privateMachineCount > 0) return 'machines';
  if (privateProjectCount > 0) return 'projects';
  return null;
}

export function shouldRetrySharingReviewConflict({
  writerId,
  attempt,
  serverWriterId,
  serverAttempt,
  isLatestAttempt,
}: {
  writerId: string;
  attempt: number;
  serverWriterId: string | null;
  serverAttempt: number | null;
  isLatestAttempt: boolean;
}): boolean {
  return (
    isLatestAttempt &&
    serverWriterId === writerId &&
    serverAttempt !== null &&
    serverAttempt < attempt
  );
}

export function getSharingReviewSourcesReady({
  docMetaCacheReady,
  visibleMachinesLoading,
  visibleLocalProjectsLoading,
  repositoriesReady,
  isMetaRoomFirstSyncPending,
}: {
  docMetaCacheReady: boolean;
  visibleMachinesLoading: boolean;
  visibleLocalProjectsLoading: boolean;
  repositoriesReady: boolean;
  isMetaRoomFirstSyncPending: boolean;
}): boolean {
  return (
    docMetaCacheReady &&
    !visibleMachinesLoading &&
    !visibleLocalProjectsLoading &&
    repositoriesReady &&
    !isMetaRoomFirstSyncPending
  );
}

export function getSharingReviewSourceRevision(parts: readonly string[]): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const part of parts) {
    const framed = `${part.length}:${part};`;
    for (let index = 0; index < framed.length; index += 1) {
      const code = framed.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
    }
  }
  first = Math.imul(first ^ (first >>> 16), 0x85ebca6b);
  second = Math.imul(second ^ (second >>> 13), 0xc2b2ae35);
  return `v1-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

export function getSharingReviewTeamLooksEmpty({
  sourcesReady,
  machineCount,
  localProjectCount,
  activeSessionCount,
  archivedSessionCount,
  githubRepositoryCount,
}: {
  sourcesReady: boolean;
  machineCount: number;
  localProjectCount: number;
  activeSessionCount: number;
  archivedSessionCount: number;
  githubRepositoryCount: number;
}): boolean {
  return (
    sourcesReady &&
    machineCount === 0 &&
    localProjectCount === 0 &&
    activeSessionCount === 0 &&
    archivedSessionCount === 0 &&
    githubRepositoryCount === 0
  );
}

export function getSharingReviewTeamHasNoVisibleLocalResources({
  sourcesReady,
  machineCount,
  localProjectCount,
}: {
  sourcesReady: boolean;
  machineCount: number;
  localProjectCount: number;
}): boolean {
  return sourcesReady && machineCount === 0 && localProjectCount === 0;
}

type ChatLandingRepositorySortItem = {
  fullName: string;
};

type ChatLandingLocalProjectSortItem = {
  key: string;
  project: {
    name: string;
    lastOpenedAtMs?: number | null;
    createdAtMs?: number | null;
  };
};

type ChatLandingMachineOnlineMeta = {
  id: string;
};

export interface ChatLandingMachineReachableArgs {
  machineId: string;
  localMachineId?: string | null;
  machines: ReadonlyMap<string, ChatLandingMachineOnlineMeta>;
  /** Presence-based machine liveness (see useMachineOnlineStatus). */
  isMachineOnline: (machineId: string) => boolean;
}

export interface ChatLandingHasOnlineMachineArgs {
  localMachineId?: string | null;
  machines: ReadonlyMap<string, ChatLandingMachineOnlineMeta>;
  isMachineOnline: (machineId: string) => boolean;
}

export interface ChatLandingBranchSelectorStateArgs {
  contextType: SessionContextType;
  workdirMode?: 'local' | 'worktree';
  selectedRepo?: string;
  repoBranchesCount: number;
  hasRepoDefaultBranch: boolean;
  hasSelectedLocalProject: boolean;
  selectedLocalProjectId?: string | null;
  isRuntimeInitializing: boolean;
  isLoadingLocalGitState: boolean;
  hasLocalGit: boolean;
  branchOptionsCount: number;
}

export interface ChatLandingSubmitDisabledArgs {
  submitting: boolean;
  hasBlockingImages: boolean;
  hasBlockingFiles: boolean;
  hasSendableContent: boolean;
  contextType: SessionContextType;
  workdirMode?: 'local' | 'worktree';
  hasSelectedLocalProject: boolean;
  isRuntimeInitializing: boolean;
  isLoadingLocalGitState: boolean;
  hasLocalGitStateError: boolean;
}

export type ChatLandingComposerStatus<TMessage = unknown> = {
  message: TMessage;
  tone: 'error' | 'warning' | 'info';
};

export interface ChatLandingVisibleComposerStatusArgs<TMessage = unknown> {
  contextType: SessionContextType;
  composerStatus: ChatLandingComposerStatus<TMessage> | null;
  localGitStateError: string | null;
  selectedMachineProjectStatus?: ChatLandingComposerStatus<TMessage> | null;
}

export interface ChatLandingInitialDataLoadingArgs {
  isRuntimeInitializing: boolean;
  isVisibleMachinesLoading: boolean;
  isDocMetaCacheReady: boolean;
  localMachineStateAttempted: boolean;
  hasSelectableMachine: boolean;
}

type ChatLandingLocalProjectMeta = {
  ownerUserId?: string | null;
  localProjects?: Record<string, unknown> | null;
};

export interface ChatLandingLocalProjectAvailabilityArgs {
  currentUserId?: string | null;
  selectedLocalProjectId?: string | null;
  machine?: ChatLandingLocalProjectMeta | null;
  machineOwnerUserId?: string | null;
  isMachineSharedWithTeam?: boolean;
  isProjectShared?: boolean;
  isVisibleMachinesLoading: boolean;
  // Missing local-project rows are authoritative only after the selected
  // machine's Flock doc completes a remote catch-up.
  isMachineFlockRemoteSynced: boolean;
  // Without this, a non-owner restoring a saved shared project gets toasted
  // as unavailable in the brief window before the share-rows query resolves.
  isVisibleLocalProjectsLoading?: boolean;
  isDocMetaCacheReady: boolean;
  // True until the durable meta-room remote first-sync completes. Machine
  // identity arrives through that room; machine-owned local-project rows arrive
  // separately through Machine Flock.
  isMetaRoomFirstSyncPending?: boolean;
}

export interface ChatLandingSelectedMachineProjectStatusArgs {
  contextType: SessionContextType;
  selectedMachineId?: string | null;
  hasSelectedLocalProject: boolean;
  hasAnyVisibleLocalProject: boolean;
  selectedMachineHasVisibleLocalProject: boolean;
  isVisibleLocalProjectsLoading: boolean;
  isDocMetaCacheReady: boolean;
}

export type ChatLandingSelectedMachineProjectStatus =
  | 'no-projects-on-selected-machine'
  | 'no-local-projects'
  | null;

function getFiniteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getSessionGitHubRepoFullName(session: ChatLandingProjectSession): string | null {
  if (session.project?.kind === 'github') {
    return session.project.repoFullName?.trim() || null;
  }
  return session.repoFullName?.trim() || null;
}

function getSessionLocalProjectKey(session: ChatLandingProjectSession): string | null {
  if (session.project?.kind !== 'local') {
    return null;
  }
  const localProjectId = session.project.localProjectId?.trim();
  if (!session.machineId || !localProjectId) {
    return null;
  }
  return `${session.machineId}:${localProjectId}`;
}

function recordLatestTimestamp(map: Map<string, number>, key: string | null, value: unknown): void {
  if (!key) return;
  const timestamp = getFiniteTimestamp(value);
  if (timestamp === null) return;
  const previous = map.get(key);
  if (previous === undefined || timestamp > previous) {
    map.set(key, timestamp);
  }
}

function compareNullableTimestampDesc(left: number | undefined, right: number | undefined): number {
  const leftTimestamp = getFiniteTimestamp(left);
  const rightTimestamp = getFiniteTimestamp(right);
  if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }
  if (leftTimestamp !== null && rightTimestamp === null) return -1;
  if (leftTimestamp === null && rightTimestamp !== null) return 1;
  return 0;
}

export function getChatLandingProjectRecency(
  sessions: Iterable<ChatLandingProjectSession>
): ChatLandingProjectRecency {
  const byRepo = new Map<string, number>();
  const byProject = new Map<string, number>();
  for (const session of sessions) {
    recordLatestTimestamp(byRepo, getSessionGitHubRepoFullName(session), session.lastMessageAt);
    recordLatestTimestamp(byProject, getSessionLocalProjectKey(session), session.lastMessageAt);
  }
  return { byRepo, byProject };
}

export function compareChatLandingRepositoryByRecency(
  left: ChatLandingRepositorySortItem,
  right: ChatLandingRepositorySortItem,
  latestMessageAtByRepo: ReadonlyMap<string, number>
): number {
  const timestampComparison = compareNullableTimestampDesc(
    latestMessageAtByRepo.get(left.fullName),
    latestMessageAtByRepo.get(right.fullName)
  );
  if (timestampComparison !== 0) return timestampComparison;
  return left.fullName.localeCompare(right.fullName);
}

export function compareChatLandingLocalProjectByRecency(
  left: ChatLandingLocalProjectSortItem,
  right: ChatLandingLocalProjectSortItem,
  latestMessageAtByProject: ReadonlyMap<string, number>
): number {
  const timestampComparison = compareNullableTimestampDesc(
    latestMessageAtByProject.get(left.key),
    latestMessageAtByProject.get(right.key)
  );
  if (timestampComparison !== 0) return timestampComparison;
  const projectTimestampComparison = compareNullableTimestampDesc(
    left.project.lastOpenedAtMs ?? left.project.createdAtMs ?? undefined,
    right.project.lastOpenedAtMs ?? right.project.createdAtMs ?? undefined
  );
  if (projectTimestampComparison !== 0) return projectTimestampComparison;
  const nameComparison = left.project.name.localeCompare(right.project.name);
  if (nameComparison !== 0) return nameComparison;
  return left.key.localeCompare(right.key);
}

// Single source of truth for the two empty-local-project i18n keys so the
// selector empty-text and the composer warning can't drift apart. Each caller
// still decides its own scope; only the key pairing is shared.
export function getEmptyLocalProjectsMessageKey(scopedToSelectedMachine: boolean): string {
  return scopedToSelectedMachine
    ? 'chat.mobileHome.emptyLocalProjects'
    : 'chat.mobileHome.emptyLocalProjectsAllMachines';
}

export function getChatLandingHintType({
  hasNoMachine,
  hasNoAgentConfig,
  isInitialDataLoading,
}: {
  hasNoMachine: boolean;
  hasNoAgentConfig: boolean;
  isInitialDataLoading: boolean;
}): ChatLandingHintType {
  // Suppress the empty-state banners while the first load is still in flight.
  // Otherwise the UI would falsely tell the user they have no machine / no
  // agent during the brief window before machine metadata and agent configs
  // arrive on app launch.
  if (isInitialDataLoading) {
    return null;
  }
  if (hasNoMachine) {
    return 'no-machine';
  }
  if (hasNoAgentConfig) {
    return 'no-agent-config';
  }
  return null;
}

export function getChatLandingInitialDataLoading({
  isRuntimeInitializing,
  isVisibleMachinesLoading,
  isDocMetaCacheReady,
  localMachineStateAttempted,
  hasSelectableMachine,
}: ChatLandingInitialDataLoadingArgs): boolean {
  if (isRuntimeInitializing || !isDocMetaCacheReady || !localMachineStateAttempted) {
    return true;
  }

  return isVisibleMachinesLoading && !hasSelectableMachine;
}

export function getChatLandingLocalProjectAvailability({
  currentUserId,
  selectedLocalProjectId,
  machine,
  machineOwnerUserId,
  isMachineSharedWithTeam = false,
  isProjectShared = false,
  isVisibleMachinesLoading,
  isMachineFlockRemoteSynced,
  isVisibleLocalProjectsLoading = false,
  isDocMetaCacheReady,
  isMetaRoomFirstSyncPending = false,
}: ChatLandingLocalProjectAvailabilityArgs): 'pending' | 'available' | 'unavailable' {
  if (!currentUserId || !selectedLocalProjectId) {
    return 'pending';
  }

  if (isVisibleMachinesLoading || isVisibleLocalProjectsLoading || !isDocMetaCacheReady) {
    return 'pending';
  }

  const effectiveMachineOwnerUserId = machineOwnerUserId ?? machine?.ownerUserId ?? null;
  if (!machine || !effectiveMachineOwnerUserId) {
    // The machine doc lands with the meta-room first sync, so an absent machine
    // means "not synced yet" — not "gone" — until that sync completes.
    return isMetaRoomFirstSyncPending ? 'pending' : 'unavailable';
  }

  // Mirrors the dual gate in `machines.canUseMachineFromCliToken`: dispatch
  // would deny non-owners unless both machine and project are explicitly
  // shared, so the dropdown must not pretend the project is reachable.
  if (
    effectiveMachineOwnerUserId !== currentUserId &&
    (!isMachineSharedWithTeam || !isProjectShared)
  ) {
    return 'unavailable';
  }

  if (Object.prototype.hasOwnProperty.call(machine.localProjects ?? {}, selectedLocalProjectId)) {
    return 'available';
  }

  return isMachineFlockRemoteSynced ? 'unavailable' : 'pending';
}

export function getChatLandingSelectedMachineProjectStatus({
  contextType,
  selectedMachineId,
  hasSelectedLocalProject,
  hasAnyVisibleLocalProject,
  selectedMachineHasVisibleLocalProject,
  isVisibleLocalProjectsLoading,
  isDocMetaCacheReady,
}: ChatLandingSelectedMachineProjectStatusArgs): ChatLandingSelectedMachineProjectStatus {
  if (contextType !== 'local' || !selectedMachineId || hasSelectedLocalProject) {
    return null;
  }

  if (isVisibleLocalProjectsLoading || !isDocMetaCacheReady) {
    return null;
  }

  if (selectedMachineHasVisibleLocalProject) {
    return null;
  }

  return hasAnyVisibleLocalProject ? 'no-projects-on-selected-machine' : 'no-local-projects';
}

export function isChatLandingMachineReachable({
  machineId,
  localMachineId,
  machines,
  isMachineOnline,
}: ChatLandingMachineReachableArgs): boolean {
  if (machineId === localMachineId) return true;
  return machines.has(machineId) && isMachineOnline(machineId);
}

export function getChatLandingHasAnyOnlineMachine({
  localMachineId,
  machines,
  isMachineOnline,
}: ChatLandingHasOnlineMachineArgs): boolean {
  if (localMachineId) return true;

  for (const machine of machines.values()) {
    if (
      isChatLandingMachineReachable({
        machineId: machine.id,
        localMachineId,
        machines,
        isMachineOnline,
      })
    ) {
      return true;
    }
  }

  return false;
}

export function getChatLandingBranchSelectorState({
  contextType,
  workdirMode = 'local',
  selectedRepo,
  repoBranchesCount,
  hasRepoDefaultBranch,
  hasSelectedLocalProject,
  selectedLocalProjectId,
  isRuntimeInitializing,
  isLoadingLocalGitState,
  hasLocalGit,
  branchOptionsCount,
}: ChatLandingBranchSelectorStateArgs) {
  const showBranchSelector =
    contextType === 'github' ||
    (contextType === 'local' &&
      workdirMode === 'worktree' &&
      hasSelectedLocalProject &&
      hasLocalGit);

  const isBranchDisabled =
    contextType === 'github'
      ? !selectedRepo || (repoBranchesCount === 0 && !hasRepoDefaultBranch)
      : isRuntimeInitializing || isLoadingLocalGitState || branchOptionsCount === 0;

  const branchSelectorKey =
    contextType === 'github'
      ? `github:${selectedRepo ?? 'none'}`
      : `local:${selectedLocalProjectId ?? 'none'}`;

  return {
    showBranchSelector,
    isBranchDisabled,
    branchSelectorKey,
  };
}

export function getChatLandingSubmitDisabled({
  submitting,
  hasBlockingImages,
  hasBlockingFiles,
  hasSendableContent,
  contextType,
  workdirMode = 'local',
  hasSelectedLocalProject,
  isRuntimeInitializing,
  isLoadingLocalGitState,
  hasLocalGitStateError,
}: ChatLandingSubmitDisabledArgs): boolean {
  if (submitting || hasBlockingImages || hasBlockingFiles || !hasSendableContent) {
    return true;
  }

  return (
    contextType === 'local' &&
    hasSelectedLocalProject &&
    (isRuntimeInitializing ||
      (workdirMode === 'worktree' && (isLoadingLocalGitState || hasLocalGitStateError)))
  );
}

export function getChatLandingVisibleComposerStatus<TMessage>({
  contextType,
  composerStatus,
  selectedMachineProjectStatus,
}: ChatLandingVisibleComposerStatusArgs<TMessage>): ChatLandingComposerStatus<
  TMessage | string
> | null {
  if (composerStatus) {
    return composerStatus;
  }
  if (contextType !== 'local') {
    return null;
  }
  // Raw local Git / RPC transport failures have a scoped retry control and
  // must not take over the landing composer as status copy.
  return selectedMachineProjectStatus ?? null;
}

export type ChatLandingPreSelectionIntent = {
  context: 'local' | 'github' | 'chat' | undefined;
  machine: string | undefined;
  project: string | undefined;
  repo: string | undefined;
  /**
   * Nonce marking an explicit "compose here" navigation. The composer applies a
   * URL pre-selection once per key and then lets the user steer freely, so a
   * caller that re-asserts the target the URL ALREADY names — the sidebar's
   * per-project new-session button, after the user cleared the composer's
   * project — changes no search param and would otherwise be a no-op.
   */
  newSessionKey?: string | undefined;
};

/** Identity of one URL-driven pre-selection intent. */
export function buildChatLandingPreSelectionKey({
  context,
  machine,
  project,
  repo,
  newSessionKey,
}: ChatLandingPreSelectionIntent): string {
  return `${context}|${machine}|${project}|${repo}|${newSessionKey}`;
}
