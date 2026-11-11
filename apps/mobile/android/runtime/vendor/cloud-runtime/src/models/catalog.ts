export type Project = {
  id: string;
  machineId: string;
  name: string;
  rootPath: string;
  repoFullName?: string;
  /** A multi-repository project's GitHub members (`projectRun`), in member order. */
  repositories?: string[];
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
  branchName?: string;
  /** Web `session.baseBranch || project.branch`: the branch the session started from. */
  baseBranch?: string;
  iosSimulatorPreviewRequestId?: string;
  pullRequests?: import('./pull-request').PullRequestReference[];
  diff?: { add: number; del: number };
  /** Uncommitted changes / local commits the remote lacks; drive the action bar's Commit & Push. */
  workspaceDirty?: boolean;
  workspaceUnpushed?: boolean;
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
};
export type SavedCatalog = { catalog: Catalog; syncedAt: number };
export type Connection = {
  state: 'live' | 'syncing' | 'offline';
  machines: number;
  syncedAt?: number;
};
