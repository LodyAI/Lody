import type {
  MessageContent,
  SessionHistoryInput,
  SessionMeta,
  SessionPlanEntry,
} from '@lody/shared';

export type ExportSessionSummary = {
  sessionId: string;
  title: string | null;
  createdAt: string;
  status: SessionMeta['status'] | null;
  archived: boolean;
  workspaceId: string;
  agent: {
    type: string;
  };
  project: SessionMeta['project'];
  repoFullName: string | null;
  baseBranch: string | null;
  branchName: string | null;
};

export type ExportTranscriptTurn = {
  turnId: string;
  role: SessionHistoryInput['role'];
  timestamp: string;
  finished: boolean | null;
  sendStatus: SessionHistoryInput['sendStatus'];
  startedAt: number | null;
  endedAt: number | null;
  modelInfo: SessionHistoryInput['modelInfo'];
  items: MessageContent[];
};

export type ExportPlanRecord = {
  turnId: string;
  timestamp: string;
  entries: SessionPlanEntry[];
};

export type ExportToolCallRecord = {
  turnId: string;
  timestamp: string;
  role: SessionHistoryInput['role'];
  toolCallId: string;
  title: string | null;
  kind: string | null;
  status: string;
  locations: Extract<MessageContent, { type: 'tool_call' }>['locations'];
  permissionRequest: Extract<MessageContent, { type: 'tool_call' }>['permissionRequest'];
  content: Exclude<
    NonNullable<Extract<MessageContent, { type: 'tool_call' }>['content']>[number],
    { type: 'diff' }
  >[];
  rawInput: Extract<MessageContent, { type: 'tool_call' }>['rawInput'];
  rawOutput: Extract<MessageContent, { type: 'tool_call' }>['rawOutput'];
};

export type ExportSystemNoticeRecord = {
  turnId: string;
  timestamp: string;
  role: SessionHistoryInput['role'];
  name: Extract<MessageContent, { type: 'system_notice' }>['name'];
  meta: Extract<MessageContent, { type: 'system_notice' }>['meta'];
};

export type ExportAttachmentRecord = {
  imageId: string;
  mimeType: string;
  fileName: string | null;
  originalFileName: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  sourceTurnIds: string[];
  relativePath: string | null;
};

export type ExportSessionArtifacts = {
  transcript: ExportTranscriptTurn[];
  plans: ExportPlanRecord[];
  toolCalls: ExportToolCallRecord[];
  systemNotices: ExportSystemNoticeRecord[];
  attachments: ExportAttachmentRecord[];
};

export type ExportManifest = {
  version: 1;
  exportedAt: string;
  workspace: {
    id: string;
    slug: string | null;
    name: string;
  };
  outputDir: string;
  sessionCount: number;
  taskCount: number;
  scheduleCount?: number;
  usageExported: boolean;
};

export type ExportUsageBundle = {
  summary: unknown;
  timelines: {
    day: unknown;
    week: unknown;
    month: unknown;
    total: unknown;
  };
};
