/**
 * Demo-data shapes the landing replica renders. These are deliberately NOT the
 * app's types: the replica is display-only and must not follow app refactors.
 */

export type ReplicaLocale = 'en' | 'zh';
export type ReplicaAgent = 'codex' | 'claude';
export type ReplicaPrStatus = 'open' | 'merged' | 'closed' | 'draft';

// ---- Conversation ----------------------------------------------------------

export type ReplicaToolKind = 'read' | 'edit' | 'execute' | 'search' | 'other';
export type ReplicaToolStatus = 'in_progress' | 'completed' | 'failed';

export type ReplicaToolCall = {
  type: 'tool_call';
  id: string;
  kind: ReplicaToolKind;
  title: string;
  status: ReplicaToolStatus;
};

export type ReplicaImage = {
  src: string;
  width: number;
  height: number;
  fileName: string;
};

export type ReplicaAssistantItem =
  | { type: 'text'; text: string }
  | ReplicaToolCall
  | { type: 'image'; image: ReplicaImage };

/** A comment left on the Browser preview, carried into the composer / history. */
export type ReplicaVisualAnnotation = {
  body: string;
  authorName: string;
  /** Short CSS path to the annotated element, e.g. `main > section.hero > p`. */
  selector: string;
  /** Text content of the annotated element. */
  targetText: string;
  tag: string;
  /** Pathname of the annotated page; the history card shows `/ · p`. Defaults to `/`. */
  pagePath?: string;
};

export type ReplicaUserMessage = {
  id: string;
  role: 'user';
  /** ISO timestamp; rendered in the viewer's local time like the app. */
  timestamp: string;
  text?: string;
  annotation?: ReplicaVisualAnnotation;
};

export type ReplicaAssistantMessage = {
  id: string;
  role: 'assistant';
  timestamp: string;
  items: ReplicaAssistantItem[];
  /** False while the turn is still streaming. */
  finished: boolean;
  agent: ReplicaAgent;
  /** Model label shown in the turn footer, e.g. `5.5`. */
  modelLabel: string;
};

export type ReplicaMessage = ReplicaUserMessage | ReplicaAssistantMessage;

export type ReplicaChatUser = { name: string; avatarUrl: string };

// ---- Sidebar / session rows -------------------------------------------------

export type ReplicaSessionRow = {
  id: string;
  title: string;
  /** GitHub `owner/repo`, local project name, or null for a plain chat. */
  repoFullName: string | null;
  branchName: string;
  prUrl?: string;
  prNumber?: number;
  prStatus?: ReplicaPrStatus;
  /** CI verdict: success / failure / pending. */
  prCiState?: 'success' | 'failure' | 'pending';
  /** True when the PR is proven mergeable (sidebar shows the pill). */
  prMergeable?: boolean;
  addedLines: number;
  deletedLines: number;
  isWorking: boolean;
  hasUnreadMessages: boolean;
  isWaitingPermission: boolean;
  isWorktree: boolean;
  /** Epoch ms of the latest message. */
  latestMessageAt: number;
  /** Pre-formatted relative age (`now`, `1h`). */
  ageLabel: string;
};

// ---- Changes ------------------------------------------------------------------

export type ReplicaChangeFile = {
  path: string;
  add: number;
  del: number;
  oldText: string;
  newText: string;
};
