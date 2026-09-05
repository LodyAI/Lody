import {
  type AgentConfigId,
  type AgentConfigCliType,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
  type ProjectRef,
  RepoId,
  SessionId,
  type WorktreeCleanupScriptConfig,
  type WorktreeSetupScriptConfig,
  WorkspaceId,
  type McpServerId,
  type SessionTurnInputConfig,
} from '@lody/shared';
import type { SessionActivePresencePhase } from '@/lib/loro/session-active-presence';
/**
 * 会话配置
 */
export interface SessionConfig {
  workspaceId: WorkspaceId;
  requesterUserId: string;
  machineId: string;
  agentConfigId?: AgentConfigId;
  agentCliType: AgentConfigCliType;
  agentType: string;
  /** Config selected by the driving turn and carried into ACP session startup. */
  configOptionValues?: SessionTurnInputConfig['configOptionValues'];
  /** Selection carried by the dispatching turn; ACP startup must not re-read history for it. */
  mcpServerIds: McpServerId[];
  /** Whether this driving Turn mounts the built-in Lody Task MCP tools. */
  taskToolsEnabled: boolean;
  scheduleToolsEnabled?: boolean;
  /** Launch spec for this execution request; durable default lives on the agent config. */
  customAcp?: CustomAcpLaunchSpec;
  /** Advanced runtime binary override for builtin Claude/Codex. */
  runtimeOverrides?: BuiltinRuntimeOverrides;
  project?: ProjectRef;
  // undefined means create a new session
  sessionId?: SessionId;
  // promptBuildConfig: PromptBuildConfig;
  env?: Record<string, string>;
  assumeDocExisting?: boolean;
  // for local session
  title?: string;
  /** Human-readable repo identifier (e.g. "owner/name") for UI status messages. */
  githubRepo?: string;
  /** Selected base branch for worktree/session startup. */
  branch?: string;
  /** Existing session branch to reattach when restoring a cleaned-up archived worktree. */
  restoreBranchName?: string;
  /** Internally captured, verified commit used as the exact worktree start point. */
  worktreeStartPoint?: string;
  /** Let a higher-level saga publish worktree metadata with its final commit. */
  deferWorktreeMetaPersistence?: boolean;

  // Worktree fields
  /** Repository identifier for worktree management */
  repoId?: RepoId;
  /** GitHub repository URL for cloning */
  githubRepoUrl?: string;
  /** GitHub worktree setup config passed from workspace-scoped repo settings. */
  worktreeSetup?: WorktreeSetupScriptConfig;
  /** GitHub worktree cleanup config passed from workspace-scoped repo settings. */
  worktreeCleanup?: WorktreeCleanupScriptConfig;
  /**
   * Worktree setup runs before the first prompt but after the assistant placeholder exists.
   * Insert its system history before that placeholder so ACP deltas keep targeting the same turn.
   */
  worktreeScriptHistoryInsertBeforeEntryId?: string;

  /**
   * Resume an existing session workspace/worktree instead of creating from scratch.
   * This is primarily used when the CLI restarts and needs to re-enter a session.
   */
  resume?: boolean;

  /** Force workdir for this session. */
  workdir?: string;

  /** Reports active-presence phase to the owner; does not write presence directly. */
  onPresencePhase?: (phase: SessionActivePresencePhase, detail?: string) => void;

  /** Parent session ID for child tab sessions. When set, reuse the parent's workspace directory. */
  parentSessionId?: SessionId;

  /** Git commit author name (from session creator) */
  userName: string;
  /** Git commit author email (from session creator) */
  userEmail: string;
}

/**
 * 会话状态
 */
export interface SessionStatus {
  sessionId: SessionId;
  status: 'existing' | 'created' | 'failed' | 'running' | 'stopped' | 'stopping' | 'terminated';
  message?: string;
  error?: string;
}

/**
 * 会话输出事件
 */
export interface SessionOutputEvent {
  sessionId: SessionId;
  data: string;
  timestamp: Date;
}

/**
 * 会话错误事件
 */
export interface SessionErrorEvent {
  sessionId: SessionId;
  error: Error;
}

/**
 * 会话退出事件
 */
export interface SessionExitEvent {
  sessionId: SessionId;
  exitCode: number;
}
