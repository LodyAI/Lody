export * from './daemon-release';
export * from './daemon-update';
export * from './preview-control';
export type * from './history-writer';
export type { AgentHistoryTargets } from './history-agent-window';
export * from './history-write-schema';
export type * from './session-mirror';
export type * from './session-control-plane';
export * from './session-cancel-request';

export type {
  AbsolutePath,
  AgentConfigId,
  AgentRoleId,
  BindingId,
  ClientId,
  MachineId,
  McpServerId,
  RepoId,
  SessionId,
  TaskId,
  WorkspaceId,
} from './ids';
export * from './message';
export * from './ai';
export * from './acp-model-capabilities';
export * from './acp-model-config-options';
export * from './pi-provider-migration';
export * from './message-quote';
export * from './message-text-spans';
export * from './deepseek-harness';
export * from './acp-run-config';
export * from './acp-startup-budget';
export * from './image-file-types';
export * from './custom-acp-command';
export * from './session-image';
export * from './avatar';
export * from './community';
export * from './session-file';
export * from './session-file-text';
export * from './incremental-sha256';
export * from './bug-report';
export * from './billing';
export * from './agent-brand';
export * from './agent-authentication';
export * from './subscription-quota';
export * from './acp-authentication-limits';
export * from './schema';
export * from './agent-session-defaults';
export * from './schedule-types';
export * from './schedule-time';
export * from './schedule-recurrence';
export * from './schedule-registry';
export type * from './schedule-schema';
export type * from './schedule-authorization';
export * from './e2ee-execution-intent';
export type * from './schedule-repository';
export * from './cron-next-fire';
export * from './scheduled-tasks-from-history';
export * from './project';
export * from './time-sync';
export * from './time-sync-maintenance';
export * from './session-status-machine';
export * from './session-archive-targets';
export * from './session-operation-targets';
export * from './session-orchestration';
export * from './session-failure';
export * from './electron-ipc';
export * from './loro-server-auth';
export * from './auth';
export * from './message-schemas';
export * from './acp/registry-generated';
export * from './acp/codex-raw';
export * from './acp/claude-code-raw';
export * from './acp/claude-subagent-task';
export * from './acp/codex-collab-agent-task';
export * from './acp/devin-subagent-task';
export * from './acp/schema';
export * from './acp/tool-call-history';
export * from './acp/history-apply';
export { inheritHistoryStreamText } from './history-stream-text';
export * from './acp/history-replay-import';
export * from './acp/ask-user-question';
export * from './acp/lody-rate-limit-migration';
export * from './acp/skills';
export * from './replay-prompt-builder';
export * from './conversation-markdown';
export * from './reliable-message';
export * from './worktree-paths';
export * from './loro-streams-auth';
export * from './rpc-secret';
export * from './presence';
export * from './loro-streams-websocket';
export * from './machine-monitor';
export * from './machine-protocol-capabilities';
export * from './pi-extensions';
export * from './repo-doc-meta';
export * from './session-input';
export * from './acp-config-option-sensitivity';
export * from './session-bootstrap';
export * from './goal';
export * from './comment-reference-format';
export * from './session-comment-types';
export * from './preview-comment-types';
export type * from './preview-comment-schema';
export * from './task-types';
export * from './today-types';
export * from './today-outline';
export * from './task-index';
export * from './pr-prompts';
export * from './preview-comment-mutation';
export * from './account-data';
export * from './visual-annotation-types';
export * from './visual-annotation-injected-script';
export * from './github-api';
export * from './github-url';
export * from './filtered-diff-files';
export * from './cli-api-key';
export * from './machine-pairing';
export * from './preview';
export * from './browser-url';
export * from './workspace-slugs';
export * from './workspace-route';
export * from './layout';
export * from './code-collab';
export * from './code-collab-diff';
export * from './file-preview';
export * from './file-download';
export * from './machine-flock';
export * from './workspace-mcp';
export * from './mcp-authentication';
export * from './agent-role';
export * from './agent-role-proposal';
export * from './workspace-flock';
export * from './pinned-sections';
export * from './status-view';
export { FractionalIndex, type JitterOptions } from './vendor/loro-fractional-index';
export * from './local-machine-rpc';
export * from './local-loro-data-plane';
export * from './json-guards';
export * from './password-validation';
export * from './in-flight-dedupe';
export * from './analytics';
export * from './live-activity-summary';
export * from './live-activity-permission-action';
export * from './convex-site-url';
export * from './terminal-protocol';
export type { WebSocketMessage } from './message';
export * from './loro-streams-routing';
import type { WorkspaceId } from './ids';

export type SupportedLanguage = 'en' | 'zh_CN';

export type FileTreeItem = {
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeItem[];
  modified?: boolean;
  lazyDirectoryId?: string;
};

export interface GeneralSettings {
  language: SupportedLanguage;
}

export interface Organization {
  id: WorkspaceId;
  name: string;
  slug: string;
  createdAt: Date;
  logo?: string;
}

// User Types
export type User = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  image?: string;
};

export type OrganizationMember = Pick<User, 'id' | 'email' | 'image' | 'name'>;

// Attachment Types
export interface Attachment {
  id: string;
  name: string;
  url: string;
  type: string;
  size: number;
  uploadedAt: Date;
  uploadedBy: User;
}

export * from './schedule-control';
export * from './workspace-bundle-control';
export * from './codex-auth-profile';
export * from './ios-simulator';
export * from './session-acp-identity';

export * from './memory-provider';
export * from './message-author';

export * from './magpie-import';

export * from './workspace-project';

export * from './project-path';

export * from './session-pull-requests';
export * from './session-pull-request-links';
export * from './pull-request-url';

export type * from './prompt-suggestions';

export * from './encrypted-attachment';

export * from './device-preview';

export * from './android-emulator';

export {
  isContainedSession,
  sessionHistoryWriteIntentDigest,
  type SessionAccessRecord,
} from './session-access';

export {
  getWorkspaceShortcutBodyStreamId,
  getWorkspaceShortcutIndexStreamId,
} from './prompt-shortcuts/access';
