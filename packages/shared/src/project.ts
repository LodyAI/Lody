import type { AgentConfigCliType, AgentType } from './ai';

export type LocalProjectId = string & { __brand: 'LocalProjectId' };

export type WorktreeSetupShell = 'bash' | 'powershell';

export type WorktreeScriptPhase = 'setup' | 'cleanup';

export type WorktreeSetupScriptConfig = {
  scripts: Partial<Record<WorktreeSetupShell, string>>;
  timeoutMs?: number;
};

export type WorktreeCleanupScriptConfig = WorktreeSetupScriptConfig;

export const DEFAULT_WORKTREE_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_WORKTREE_CLEANUP_TIMEOUT_MS = DEFAULT_WORKTREE_SETUP_TIMEOUT_MS;

/**
 * Maps a machine platform string (`process.platform` / `MachineMeta.os`) to the
 * worktree-setup shell that machine runs. Windows uses PowerShell; every other
 * platform (macOS, Linux, WSL) uses Bash. Shared so the UI can probe a local
 * project's machine and show only the relevant shell, and so the CLI runner and
 * the settings UI never drift on the mapping.
 */
export function resolveWorktreeSetupShellForPlatform(
  platform: string | undefined | null
): WorktreeSetupShell {
  return platform === 'win32' ? 'powershell' : 'bash';
}

export function getWorktreeSetupScriptForShell(
  config: WorktreeSetupScriptConfig,
  shell: WorktreeSetupShell
): string | null {
  const script = config.scripts[shell]?.trim();
  if (!script) {
    return null;
  }
  return script;
}

export type LocalProjectWorkingTreeState = {
  clean: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
};

export type LocalProjectGitState =
  | { git: false }
  | {
      git: true;
      currentBranch: string | null;
      defaultBranch: string | null;
      branches: string[];
      githubRepoFullName: string | null;
      workingTree: LocalProjectWorkingTreeState;
    };

export type LocalProjectHistoryProvider = {
  cliType: AgentConfigCliType;
  agentType: AgentType;
};

export type LocalProjectHistoryProviderKey = string & { __brand: 'LocalProjectHistoryProviderKey' };
export type ExternalAcpHistoryImportKey = string & { __brand: 'ExternalAcpHistoryImportKey' };

export function getLocalProjectHistoryProviderKey(
  provider: LocalProjectHistoryProvider
): LocalProjectHistoryProviderKey {
  return `${provider.cliType}:${provider.agentType}` as LocalProjectHistoryProviderKey;
}

export function getExternalAcpHistoryImportKey(options: {
  machineId: string;
  localProjectId: LocalProjectId;
  provider: LocalProjectHistoryProvider;
  sourceAcpSessionId: string;
}): ExternalAcpHistoryImportKey {
  return [
    options.machineId,
    options.localProjectId,
    getLocalProjectHistoryProviderKey(options.provider),
    options.sourceAcpSessionId,
  ].join(':') as ExternalAcpHistoryImportKey;
}

export type LocalProjectHistoryCatalogItem = {
  acpSessionId: string;
  title: string;
  updatedAt?: string;
  importedSessionId?: string;
  status?: 'available' | 'imported' | 'sync_conflict';
};

export type LocalProjectHistoryCatalog = {
  lastListedAt: number;
  sessions: Record<string, LocalProjectHistoryCatalogItem>;
};

export type LocalProjectHistoryCatalogs = Partial<
  Record<LocalProjectHistoryProviderKey, LocalProjectHistoryCatalog>
>;

export type ProjectRef =
  | { kind: 'github'; repoFullName: string; branch: string }
  | {
      kind: 'local';
      localProjectId: LocalProjectId;
      branch?: string;
      githubRepoFullName?: string;
      /** When true, create the session in an isolated git worktree for this local project. */
      useWorktree?: boolean;
    };

export type LocalProjectMeta = {
  id: LocalProjectId;
  name: string;
  rootPath: string;
  createdAtMs: number;
  lastOpenedAtMs?: number;
  history?: LocalProjectHistoryCatalogs;
};

const DEFAULT_BASE_BRANCH = 'main';

function getTrimmedBranch(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getTrimmedRepoFullName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getProjectRefBranch(project: unknown): string | undefined {
  if (!project || typeof project !== 'object') {
    return undefined;
  }
  return getTrimmedBranch((project as { branch?: unknown }).branch);
}

export function resolveProjectGitHubRepo(project: unknown): string | undefined {
  if (!project || typeof project !== 'object') {
    return undefined;
  }
  const typedProject = project as {
    kind?: unknown;
    repoFullName?: unknown;
    githubRepoFullName?: unknown;
  };
  if (typedProject.kind === 'github') {
    return getTrimmedRepoFullName(typedProject.repoFullName);
  }
  if (typedProject.kind === 'local') {
    return getTrimmedRepoFullName(typedProject.githubRepoFullName);
  }
  return undefined;
}

/**
 * Whether a local-project Session runs in the project's original shared
 * directory rather than a Session-owned worktree.
 *
 * `SessionMeta.isWorktree` is accepted separately for legacy/restored local
 * worktree Sessions whose persisted `ProjectRef` predates `useWorktree`.
 */
export function isDirectLocalProject(project: unknown, sessionIsWorktree?: unknown): boolean {
  if (!project || typeof project !== 'object') {
    return false;
  }
  const typedProject = project as { kind?: unknown; useWorktree?: unknown };
  return (
    typedProject.kind === 'local' &&
    typedProject.useWorktree !== true &&
    sessionIsWorktree !== true
  );
}

/**
 * Structural, brand-agnostic view of a `ProjectRef` so this helper accepts both
 * the branded `ProjectRef` (web) and the Zod-inferred preparation spec (CLI),
 * whose `localProjectId` is a plain string.
 */
type ProjectRefDedupInput =
  | { kind: 'github'; repoFullName: string; branch: string }
  | {
      kind: 'local';
      localProjectId: string;
      branch?: string;
      githubRepoFullName?: string;
      useWorktree?: boolean;
    };

/**
 * Produces a stable, JSON-comparable value from a `ProjectRef` so that the CLI's
 * session-preparation claim key and the client's preparation request key derive
 * the SAME identity. Both sides MUST consume this single definition: if the shapes
 * drift, preparations silently stop being claimed and every draft falls back to a
 * cold start with no error. Returns `null` when there is no project.
 */
export function normalizeProjectRefForDedup(project: ProjectRefDedupInput | null | undefined): unknown {
  if (!project) return null;
  if (project.kind === 'github') {
    return ['github', project.repoFullName, project.branch];
  }
  return [
    'local',
    project.localProjectId,
    project.branch ?? null,
    project.githubRepoFullName ?? null,
    project.useWorktree === true,
  ];
}

export function resolveBaseBranchPreference(options: {
  preferredBranch?: unknown;
  baseBranch?: unknown;
  project?: unknown;
  fallbackBranch?: string;
}): string {
  const fallback = getTrimmedBranch(options.fallbackBranch) ?? DEFAULT_BASE_BRANCH;
  return (
    getTrimmedBranch(options.preferredBranch) ??
    getTrimmedBranch(options.baseBranch) ??
    getProjectRefBranch(options.project) ??
    fallback
  );
}
