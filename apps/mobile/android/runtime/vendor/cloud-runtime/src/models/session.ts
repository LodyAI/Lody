import { type TurnMetadata } from '../protocol/turnMetadata.ts';
export type SystemNoticeMeta = {
  reason?: string;
  code?: string;
  message?: string;
};

export type ItemSummary =
  | {
      itemId: string;
      rev: number;
      type: 'system_notice';
      name: string;
      meta?: SystemNoticeMeta;
    }
  | { itemId: string; rev: number; type: 'text'; text: string }
  | { itemId: string; rev: number; type: 'thought'; text: string }
  | {
      itemId: string;
      rev: number;
      type: 'proposed_plan';
      turnId: string;
      markdown: string;
      status: 'delta' | 'completed' | 'cleared';
      isLatest: boolean;
    }
  | {
      itemId: string;
      rev: number;
      type: 'tool_call';
      kind: string;
      title: string;
      status: string;
      path?: string;
      added?: number;
      removed?: number;
      hasDetail: boolean;
      permission?: {
        requestId: string;
        pending: boolean;
        options?: PermissionOption[];
        kind?: 'permission' | 'ask_user_question';
        questionMeta?: QuestionMeta;
      };
    }
  | {
      itemId: string;
      rev: number;
      type: 'plan';
      entries: { content: string; status: string; priority?: string }[];
    }
  | {
      itemId: string;
      rev: number;
      type: 'subagent_task';
      taskId: string;
      status: string;
      actor?: string;
      description?: string;
      lastToolName?: string;
      summary?: string;
      error?: string;
      isBackgrounded?: boolean;
      skipTranscript?: boolean;
      /** Web `groupOf`: an agent run is a subagent; a command, MCP task, monitor or wakeup a task. */
      group?: 'subagents' | 'tasks';
      run?: { sessionId: string; state: string; items: ItemSummary[] };
    }
  | { itemId: string; rev: number; type: string };

export type EntrySummary = TurnMetadata & {
  id: string;
  rev: number;
  role: string;
  status: string;
  finished: boolean;
  canSteer?: boolean;
  userTurnId?: string;
  userId?: string;
  executionId?: string;
  executionFinished?: boolean;
  steerCount?: number;
  delivery?: string;
  holdOpen?: boolean;
  timestamp?: string;
  startedAt?: number;
  endedAt?: number;
  permissionWaitMs?: number;
  modelInfo?: { modelId?: string; name?: string; thoughtLevel?: string };
  items: ItemSummary[];
  fileDiffs?: { path: string; add: number; del: number }[];
};

export type Envelope = {
  v: 1;
  status: string;
  reason?: string;
  revision: number;
  billableTurnCount?: number;
  awaitingUserSince?: number;
  preview?: { label: string; active: boolean };
  composer?: {
    modelId?: string;
    modeId?: string;
    effort?: string;
    configOptionValues?: Record<string, string | boolean>;
  };
  entries: EntrySummary[];
};

export type Snapshot = Omit<Envelope, 'v'>;

export type DetailBlock = {
  type: string;
  path?: string;
  oldText?: string;
  newText?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  output?: string;
  exitStatus?: { exitCode?: number | null; signal?: string | null };
};

export type DetailResponse = {
  itemId: string;
  rev: number;
  blocks: DetailBlock[];
  rawInput?: unknown;
  rawOutput?: unknown;
  options?: PermissionOption[];
  outcome?: unknown;
  truncated: boolean;
  nextCursor?: string;
};

export type PermissionTarget = {
  questionMeta?: QuestionMeta;
  options?: PermissionOption[];
  entryId: string;
  itemId: string;
  requestId: string;
  kind: string;
  title: string;
  path?: string;
};

export type PermissionTargetState = {
  ready: boolean;
  target?: PermissionTarget;
};

export type PermissionOption = {
  optionId: string;
  name: string;
  kind?: string;
};

export type PermissionDetail = {
  options: PermissionOption[];
  command?: DetailBlock;
};

export type PermissionResult = { requestId: string } | undefined;

export type Question = {
  id?: string;
  header: string;
  question: string;
  options: { label: string; description?: string; preview?: string }[];
  multiSelect: boolean;
  allowCustomAnswer?: boolean;
  isSecret?: boolean;
};

export type QuestionMeta = {
  source: 'lody' | 'claude' | 'codex';
  version: number;
  questions: Question[];
  allowCustomAnswer: boolean;
  autoResolveAt?: number;
};

export type QuestionAnswers = Record<string, string | string[]>;
