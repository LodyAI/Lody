import {
  buildPendingUserHistoryEntry,
  buildSessionTurnInputConfig,
  normalizeMcpServerIdSelection,
  type AcpConfigOptionValue,
  type MessageQueueItem,
  type SessionHistoryInput,
  type SessionMeta,
} from '@lody/shared';
import {
  extractPromptPreviewFromInputBlocks,
  normalizeSessionInputBlocks,
} from './session-execution-helpers';
import { resolveResumableAcpSessionId } from './session-dispatch-logic';

const isConfigOptionValueRecord = (
  value: unknown
): value is Record<string, AcpConfigOptionValue> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (item) => typeof item === 'string' || typeof item === 'boolean'
  );
};

/** Materialize one durable queue item as the user turn that will execute it. */
export function buildQueuedMessageUserTurn(
  queuedItem: MessageQueueItem,
  meta: SessionMeta,
  options: { status?: 'pending' | 'pending_apply' } = {}
): SessionHistoryInput | null {
  const inputBlocks = normalizeSessionInputBlocks(
    queuedItem.acpSessionConfig?.inputBlocks,
    queuedItem.acpSessionConfig?.prompt ?? queuedItem.task
  );
  const inputConfig = buildSessionTurnInputConfig({
    inputBlocks,
    prompt: queuedItem.acpSessionConfig?.prompt ?? extractPromptPreviewFromInputBlocks(inputBlocks),
    cliType: queuedItem.acpSessionConfig?.cliType ?? meta.cliType,
    agentType: queuedItem.acpSessionConfig?.agentType ?? meta.agentType,
    modeId: queuedItem.acpSessionConfig?.modeId,
    modelId: queuedItem.acpSessionConfig?.modelId,
    configOptionValues: isConfigOptionValueRecord(queuedItem.acpSessionConfig?.configOptionValues)
      ? queuedItem.acpSessionConfig.configOptionValues
      : undefined,
    mcpServerIds: normalizeMcpServerIdSelection(queuedItem.acpSessionConfig?.mcpServerIds) ?? [],
    taskToolsEnabled: queuedItem.acpSessionConfig?.taskToolsEnabled === true,
    agentRoleId: queuedItem.acpSessionConfig?.agentRoleId,
    agentRoleRevision: queuedItem.acpSessionConfig?.agentRoleRevision,
    issuePRMentions: queuedItem.acpSessionConfig?.issuePRMentions,
    resume: resolveResumableAcpSessionId(meta),
  });
  const pendingEntry = buildPendingUserHistoryEntry({
    userId: queuedItem.userId ?? meta.userId,
    inputBlocks,
    timestamp: queuedItem.timestamp,
    inputConfig,
    ...(options.status ? { status: options.status } : {}),
  });
  if (!pendingEntry) return null;

  return {
    ...pendingEntry,
    id: queuedItem.userTurnId?.trim() || `queued-${queuedItem.$cid}`,
  };
}
