import type { MachineId, SessionId } from './index';
import type { AgentConfigCliType, SessionInputBlock, SessionTurnInputConfig } from './ai';
import { AgentConfigCliTypeSchema, ProjectRefSchema } from './message-schemas';
import { getProjectRefBranch, resolveProjectGitHubRepo } from './project';
import type { SessionHistoryInput, SessionMeta } from './schema';
import { SessionStatusFactory } from './session-status-machine';
import {
  buildPendingUserHistoryEntry,
  buildSessionTurnInputConfig,
  extractPromptPreviewFromInputBlocks,
  normalizeSessionInputBlocks,
} from './session-input';

export const initialSessionBootstrapProjectSchema = ProjectRefSchema.optional();

export const buildInitialHistoryEntry = (args: {
  userId: string;
  timestamp: string;
  cliType: AgentConfigCliType;
  agentType: string;
  prompt: string | undefined;
  inputBlocks: SessionInputBlock[] | undefined;
  modeId?: string;
  modelId?: string;
  configOptionValues?: SessionTurnInputConfig['configOptionValues'];
  issuePRMentions?: SessionTurnInputConfig['issuePRMentions'];
  resume?: SessionTurnInputConfig['resume'];
  taskToolsEnabled?: boolean;
  scheduleToolsEnabled?: boolean;
}): SessionHistoryInput | null => {
  const normalizedInputBlocks = normalizeSessionInputBlocks(args.inputBlocks, args.prompt ?? '');
  if (normalizedInputBlocks.length === 0) {
    return null;
  }

  const inputConfig: SessionTurnInputConfig = buildSessionTurnInputConfig({
    inputBlocks: normalizedInputBlocks,
    prompt: args.prompt?.trim() || extractPromptPreviewFromInputBlocks(normalizedInputBlocks),
    cliType: args.cliType,
    agentType: args.agentType,
    modeId: args.modeId,
    modelId: args.modelId,
    configOptionValues: args.configOptionValues,
    issuePRMentions: args.issuePRMentions,
    resume: args.resume,
    taskToolsEnabled: args.taskToolsEnabled,
    scheduleToolsEnabled: args.scheduleToolsEnabled,
  });
  const pendingEntry = buildPendingUserHistoryEntry({
    userId: args.userId,
    inputBlocks: normalizedInputBlocks,
    timestamp: args.timestamp,
    inputConfig,
  });
  if (!pendingEntry) {
    return null;
  }

  return {
    ...pendingEntry,
    id: crypto.randomUUID(),
  };
};

export const buildInitialSessionMetaPatch = (args: {
  sessionId: SessionId;
  machineId: MachineId;
  userId: string;
  cliType: AgentConfigCliType;
  agentType: string;
  createdAt: string;
  project?: SessionMeta['project'];
  parentSessionId?: SessionId;
  fromFeedbackPostId?: string;
}): Partial<SessionMeta> => {
  const repoFullName = resolveProjectGitHubRepo(args.project);
  // A local ProjectRef branch is a user selector and may be an opaque
  // `lody:branch:*` value. The target CLI resolves it before authoring the
  // exact Git ref into baseBranch.
  const baseBranch = args.project?.kind === 'local' ? undefined : getProjectRefBranch(args.project);
  const metaToWrite: Partial<SessionMeta> = {
    id: args.sessionId,
    machineId: args.machineId,
    userId: args.userId,
    status: SessionStatusFactory.idle(),
    isArchived: false,
    createdAt: args.createdAt,
    cliType: args.cliType,
    agentType: args.agentType as SessionMeta['agentType'],
  };
  if (args.project) {
    metaToWrite.project = args.project;
  }
  if (repoFullName) {
    metaToWrite.repoFullName = repoFullName;
  }
  if (baseBranch) {
    metaToWrite.baseBranch = baseBranch;
  }
  if (args.fromFeedbackPostId) {
    metaToWrite.fromFeedbackPostId = args.fromFeedbackPostId;
  }
  if (args.parentSessionId) {
    metaToWrite.parentSessionId = args.parentSessionId;
  }
  return metaToWrite;
};

export const isValidInitialBootstrapCliType = (value: unknown): value is AgentConfigCliType =>
  AgentConfigCliTypeSchema.safeParse(value).success;
