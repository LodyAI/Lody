import type {
  LocalProjectBranchListResult,
  LocalProjectGitState,
  LocalProjectId,
  LocalProjectMeta,
  MachineId,
  MachineMeta,
  WorkspaceId,
} from '@lody/shared';

export const LOCAL_PROJECT_BRANCH_PAGE_SIZE = 50;
export const LOCAL_PROJECT_GIT_STATE_FRESH_TTL_MS = 60_000;
export const LOCAL_PROJECT_GIT_STATE_STALE_TTL_MS = 30 * 60_000;

export type LocalProjectObservedGitState =
  | { git: false }
  | {
      git: true;
      currentBranch: string | null;
      defaultBranch: string | null;
      pinnedBranches: string[];
      branches: string[];
      truncated: boolean;
      nextCursor?: string;
      totalCount: number;
      githubRepoFullName?: string | null;
      summaryOnly?: boolean;
    };

type AnyLocalProjectGitState =
  | LocalProjectGitState
  | LocalProjectBranchListResult
  | LocalProjectObservedGitState;

export function normalizeOrderedLocalProjectBranches(args: {
  pinnedBranches?: readonly (string | null | undefined)[];
  branches: readonly string[];
  selectedBranch?: string | null;
}): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  };
  for (const pinned of args.pinnedBranches ?? []) push(pinned);
  push(args.selectedBranch);
  for (const branch of args.branches) push(branch);
  return result;
}

export function deriveLocalProjectGitStateFromMeta(
  meta: LocalProjectMeta | null | undefined
): LocalProjectObservedGitState | null {
  if (!meta || typeof meta.git !== 'boolean') return null;
  if (!meta.git) return { git: false };
  const defaultBranch = meta.defaultBranch?.trim() || null;
  const currentBranch = meta.currentBranch?.trim() || null;
  const pinnedBranches = normalizeOrderedLocalProjectBranches({
    pinnedBranches: [defaultBranch, currentBranch],
    branches: [],
  });
  return {
    git: true,
    currentBranch,
    defaultBranch,
    pinnedBranches,
    branches: pinnedBranches,
    truncated: pinnedBranches.length > 0,
    totalCount: pinnedBranches.length,
    githubRepoFullName: meta.githubRepoFullName?.trim() || null,
    summaryOnly: true,
  };
}

export function toObservedLocalProjectGitState(
  result: LocalProjectBranchListResult,
  meta?: LocalProjectMeta | null
): LocalProjectObservedGitState {
  if (!result.git) return { git: false };
  const pinnedBranches = normalizeOrderedLocalProjectBranches({
    pinnedBranches: result.pinnedBranches,
    branches: [],
  });
  return {
    git: true,
    currentBranch: result.currentBranch,
    defaultBranch: result.defaultBranch,
    pinnedBranches,
    branches: result.branches,
    truncated: result.truncated,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    totalCount: result.totalCount,
    githubRepoFullName: meta?.githubRepoFullName?.trim() || null,
    summaryOnly: false,
  };
}

export function resolveLocalProjectBranchSelection(
  state: AnyLocalProjectGitState,
  previousBranch: string | null
): string | null {
  if (!state.git) return null;
  const pinned =
    'pinnedBranches' in state ? state.pinnedBranches : [state.defaultBranch, state.currentBranch];
  const available = normalizeOrderedLocalProjectBranches({
    pinnedBranches: pinned,
    branches: state.branches,
  });
  const isPartial =
    ('truncated' in state && state.truncated) || ('summaryOnly' in state && state.summaryOnly);
  const preferred = previousBranch?.trim() || null;
  if (preferred && (available.includes(preferred) || isPartial)) {
    return preferred;
  }
  if (available.length === 0) return null;
  const defaultBranch = state.defaultBranch?.trim() || null;
  if (defaultBranch && available.includes(defaultBranch)) {
    return defaultBranch;
  }
  for (const candidate of [
    'main',
    'lody:branch:local:main',
    'master',
    'lody:branch:local:master',
  ]) {
    if (available.includes(candidate)) return candidate;
  }
  const currentBranch = state.currentBranch?.trim() || null;
  if (currentBranch && available.includes(currentBranch)) {
    return currentBranch;
  }
  return available[0] ?? null;
}

export function getLocalProjectBranchLabel(
  branchSelector: string,
  labels: { local: string; remote: string }
): string {
  const localPrefix = 'lody:branch:local:';
  const remotePrefix = 'lody:branch:remote:';
  try {
    if (branchSelector.startsWith(localPrefix)) {
      const branchName = decodeURIComponent(branchSelector.slice(localPrefix.length));
      return `${branchName} (${labels.local})`;
    }
    if (branchSelector.startsWith(remotePrefix)) {
      const encoded = branchSelector.slice(remotePrefix.length);
      const separator = encoded.indexOf(':');
      if (separator < 0) return branchSelector;
      const remoteName = decodeURIComponent(encoded.slice(0, separator));
      const branchName = decodeURIComponent(encoded.slice(separator + 1));
      return `${remoteName}/${branchName} (${labels.remote})`;
    }
  } catch {
    return branchSelector;
  }
  return branchSelector;
}

export function getLocalProjectWorktreeAvailability(
  state: AnyLocalProjectGitState | null
): boolean {
  if (state?.git !== true) return false;
  if (state.branches.length > 0) return true;
  if ('pinnedBranches' in state && state.pinnedBranches.length > 0) return true;
  return Boolean(state.defaultBranch?.trim() || state.currentBranch?.trim());
}

export type LocalProjectBranchSwrEntry = {
  result: LocalProjectBranchListResult;
  freshUntilMs: number;
  staleUntilMs: number;
};

export class LocalProjectBranchSwrCache {
  private readonly entries = new Map<string, LocalProjectBranchSwrEntry>();

  constructor(
    private readonly options: {
      maxEntries?: number;
      freshTtlMs?: number;
      staleTtlMs?: number;
    } = {}
  ) {}

  get(
    key: string,
    nowMs = Date.now()
  ): { result: LocalProjectBranchListResult; isFresh: boolean } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (nowMs >= entry.staleUntilMs) {
      this.entries.delete(key);
      return null;
    }
    return {
      result: entry.result,
      isFresh: nowMs < entry.freshUntilMs,
    };
  }

  set(key: string, result: LocalProjectBranchListResult, nowMs = Date.now()): void {
    const maxEntries = this.options.maxEntries ?? 128;
    const freshTtlMs = this.options.freshTtlMs ?? LOCAL_PROJECT_GIT_STATE_FRESH_TTL_MS;
    const staleTtlMs = this.options.staleTtlMs ?? LOCAL_PROJECT_GIT_STATE_STALE_TTL_MS;
    this.entries.delete(key);
    this.entries.set(key, {
      result,
      freshUntilMs: nowMs + freshTtlMs,
      staleUntilMs: nowMs + staleTtlMs,
    });
    while (this.entries.size > maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export function getLocalProjectGitStateLoadKey(args: {
  workspaceId: WorkspaceId | null;
  machineId: MachineId | null;
  localProjectId: LocalProjectId | null;
  userId: string | null;
  machineOnline: boolean;
  retryNonce: number;
  hasRuntime: boolean;
  hasDesktopControl: boolean;
}): string | null {
  if (!args.workspaceId || !args.machineId || !args.localProjectId) return null;
  const loader = args.hasDesktopControl ? 'desktop' : args.hasRuntime ? 'runtime' : 'none';
  return [
    args.workspaceId,
    args.machineId,
    args.localProjectId,
    args.userId ?? 'missing-user',
    args.machineOnline ? 'online' : 'offline',
    loader,
    args.retryNonce,
  ].join(':');
}

/**
 * Returns true when the chat-landing Git-state fetch should fail fast with an
 * "offline" error instead of waiting on the workspace RPC to time out.
 *
 * Two non-obvious choices encoded here:
 *  - The visible local machine is treated as always reachable; the in-process
 *    handler / Electron fast path take over before any heartbeat check matters.
 *  - An *unknown* target machine (not yet in the workspace map) does NOT
 *    short-circuit. The workspace meta room may still be bootstrapping, and a
 *    false-positive offline error during initial sync is worse than letting
 *    the single 30s RPC timeout run. An unsynced presence room is unknown in
 *    the same way: only a synced room proves a missing heartbeat means offline.
 */
export function isLocalProjectMachineOffline(args: {
  projectMachineId: MachineId;
  visibleLocalMachineId: MachineId | null;
  targetMachine: MachineMeta | undefined;
  /** Whether the presence room is synced, so a missing heartbeat is meaningful. */
  presenceSynced: boolean;
  /** Presence-based machine liveness (see useMachineOnlineStatus). */
  isMachineOnline: (machineId: MachineId) => boolean;
}): boolean {
  if (args.visibleLocalMachineId === args.projectMachineId) return false;
  if (!args.targetMachine) return false;
  return args.presenceSynced && !args.isMachineOnline(args.projectMachineId);
}
