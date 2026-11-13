export type Project = {
  id: string;
  machineId: string;
  name: string;
  rootPath: string;
  repoFullName?: string;
  /** A multi-repository project's GitHub members (`projectRun`), in member order. */
  repositories?: string[];
};
/** One repository or folder of a multi-repository (Project group) conversation. */
export type ProjectRunMember = {
  id: string;
  /** Path under the conversation's directory, e.g. `api/proto`. */
  path: string;
  kind: 'github' | 'local';
  /** Nesting depth in the placement forest; roots are 0. */
  depth: number;
  submodule: boolean;
  /** `additional` / `link`: a local folder used in place, with no branch or PR. */
  access?: 'worktree' | 'additional' | 'link';
  repoFullName?: string;
  branch?: string;
  diff?: { add: number; del: number };
  dirty?: boolean;
  unpushed?: boolean;
  /** The member repository's current PR: the last one recorded for it. */
  pullRequest?: import('./pull-request').PullRequestReference;
};
/** The frozen Project group snapshot of a conversation (session meta `projectRun`). */
export type ProjectRun = {
  id: string;
  name: string;
  /** Placement order: each root followed by its submodules. */
  members: ProjectRunMember[];
};
export type Session = {
  lastModel?: { modelId?: string; name?: string } | null;
  cliType?: string;
  agentType?: string;
  resume?: string;
  id: string;
  machineId: string;
  title: string;
  openedBySessionId?: string;
  openedByRootSessionId?: string;
  parentSessionId?: string;
  childSessionPlacement?: string;
  status: string;
  archived: boolean;
  isTabClosed?: boolean;
  pinned: boolean;
  /** The Lody user who owns the session (session meta `userId`). */
  userId?: string;
  /** The agent config (ACP provider) the session runs; picks its model capability. */
  agentConfigId?: string;
  projectId: string;
  createdAt: string;
  latestUserMsgId?: string;
  lastMessageAt?: number;
  lastReadAt?: number;
  lastRunningSeen?: number;
  awaitingUserSince?: number;
  /** Latest user turn the machine finished (session meta `lastHandledUserMsgId`). */
  lastHandledUserMsgId?: string;
  /**
   * Latest user turn that ended in failure (session meta `lastFailedUserMsgId`). The
   * conversation is failed only while it equals `lastHandledUserMsgId`.
   */
  lastFailedUserMsgId?: string;
  branchName?: string;
  /** Web `session.baseBranch || project.branch`: the branch the session started from. */
  baseBranch?: string;
  iosSimulatorPreviewRequestId?: string;
  androidEmulatorPreviewRequestId?: string;
  pullRequests?: import('./pull-request').PullRequestReference[];
  diff?: { add: number; del: number };
  /** Uncommitted changes / local commits the remote lacks; drive the action bar's Commit & Push. */
  workspaceDirty?: boolean;
  workspaceUnpushed?: boolean;
  /** Present for Project group conversations. */
  projectRun?: ProjectRun;
};
export type Catalog = {
  agentUsage?: Record<string, import('./agent-usage.ts').AgentUsage>;
  projects: Project[];
  sessions: Session[];
  machineIds: string[];
  machineNames?: Record<string, string>;
  /** Each computer's OS (`darwin` / `win32` / `linux`), for its icon. */
  machineOs?: Record<string, string>;
  machineSimulators?: Record<string, 'available' | 'upgrade-required'>;
  /** Machines whose CLI advertises Android emulator preview (`androidEmulator: 1`), on any OS. */
  machineEmulators?: Record<string, 'available'>;
};
export type SavedCatalog = { catalog: Catalog; syncedAt: number };
export type Connection = {
  state: 'live' | 'syncing' | 'offline';
  machines: number;
  syncedAt?: number;
};
