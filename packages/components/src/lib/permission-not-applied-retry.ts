import { useCallback, useRef, useState } from 'react';
import type { AcpConfigOptionValue, AgentRoleId, SessionInputBlock } from '@lody/shared';

/**
 * Recovering a turn the daemon stopped because the agent reported a permission
 * wider than the turn asked for.
 *
 * The offer must replay THAT turn: its own prompt, mode, model and config
 * option values, frozen in its `inputConfig`. Reading the composer instead
 * would pair the old prompt with whatever the user has since selected, which is
 * a different run than the one that was stopped — and the whole point of the
 * stop was that the user gets to decide about this exact one.
 */
export type PermissionNotAppliedRetryTarget = {
  /** History entry id of the failure notice, for matching the render site. */
  noticeId: string;
  /** The permission the stopped turn asked for. */
  requestedModeId: string;
  /** The wider one the agent reported. */
  effectiveModeId: string;
  userTurnId: string;
  inputBlocks: SessionInputBlock[];
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  agentRoleId?: AgentRoleId | null;
  agentRoleRevision?: number;
  /**
   * Tool reach is part of what that turn was, not of what the composer holds
   * now. An explicit empty selection is a selection — `mcpServerIds: []` means
   * "no servers", which is why it travels as `undefined`-vs-array rather than
   * being collapsed to falsy.
   */
  mcpServerIds?: string[];
  taskToolsEnabled?: boolean;
  issuePRMentions?: unknown[];
};

type RetryHistoryItem = { type?: string; name?: string; meta?: unknown } | null | undefined;

type RetryHistoryEntry = {
  id: string;
  role?: string;
  items?: readonly RetryHistoryItem[];
  inputConfig?: unknown;
};

const readPermissionMeta = (
  item: RetryHistoryItem
): { requestedModeId: string; effectiveModeId: string } | null => {
  if (item?.type !== 'system_notice' || item.name !== 'chat_failed') {
    return null;
  }
  const meta = item.meta as
    | { reason?: unknown; permission?: { requestedModeId?: unknown; effectiveModeId?: unknown } }
    | undefined;
  if (meta?.reason !== 'permission_not_applied') {
    return null;
  }
  const requestedModeId = meta.permission?.requestedModeId;
  const effectiveModeId = meta.permission?.effectiveModeId;
  return typeof requestedModeId === 'string' && typeof effectiveModeId === 'string'
    ? { requestedModeId, effectiveModeId }
    : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The newest stopped turn still awaiting a decision, or null.
 *
 * A user entry newer than the notice supersedes it: the user moved on, and
 * replaying the old turn would inject it out of order behind whatever they
 * sent. The same rule the capacity retry uses.
 */
export const findPermissionNotAppliedRetryTarget = (
  history: readonly RetryHistoryEntry[] | null | undefined
): PermissionNotAppliedRetryTarget | null => {
  if (!history) {
    return null;
  }
  let noticeIndex = -1;
  let permission: { requestedModeId: string; effectiveModeId: string } | null = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    if (entry.role === 'user') {
      return null;
    }
    const found = entry.items?.map(readPermissionMeta).find((value) => value !== null) ?? null;
    if (found) {
      noticeIndex = index;
      permission = found;
      break;
    }
  }
  if (noticeIndex < 0 || !permission) {
    return null;
  }

  for (let index = noticeIndex - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry || entry.role !== 'user') continue;
    const inputConfig = isRecord(entry.inputConfig) ? entry.inputConfig : undefined;
    const inputBlocks = Array.isArray(inputConfig?.inputBlocks)
      ? (inputConfig.inputBlocks as SessionInputBlock[])
      : [];
    if (inputBlocks.length === 0) {
      // Without the frozen blocks there is nothing to replay faithfully, and
      // reconstructing from the rendered items would risk sending something
      // other than what that turn ran.
      return null;
    }
    return {
      noticeId: history[noticeIndex]?.id ?? '',
      ...permission,
      userTurnId: entry.id,
      inputBlocks,
      ...(typeof inputConfig?.modeId === 'string' ? { modeId: inputConfig.modeId } : {}),
      ...(typeof inputConfig?.modelId === 'string' ? { modelId: inputConfig.modelId } : {}),
      ...(isRecord(inputConfig?.configOptionValues)
        ? {
            configOptionValues: inputConfig.configOptionValues as Record<
              string,
              AcpConfigOptionValue
            >,
          }
        : {}),
      ...(typeof inputConfig?.agentRoleId === 'string' || inputConfig?.agentRoleId === null
        ? { agentRoleId: inputConfig.agentRoleId as AgentRoleId | null }
        : {}),
      ...(typeof inputConfig?.agentRoleRevision === 'number'
        ? { agentRoleRevision: inputConfig.agentRoleRevision }
        : {}),
      ...(Array.isArray(inputConfig?.mcpServerIds)
        ? { mcpServerIds: inputConfig.mcpServerIds as string[] }
        : {}),
      ...(typeof inputConfig?.taskToolsEnabled === 'boolean'
        ? { taskToolsEnabled: inputConfig.taskToolsEnabled }
        : {}),
      ...(Array.isArray(inputConfig?.issuePRMentions)
        ? { issuePRMentions: inputConfig.issuePRMentions as unknown[] }
        : {}),
    };
  }
  return null;
};

/** What the failure notice needs to render its one-time acceptance action. */
export type PermissionRetryControl = {
  noticeId: string;
  requestedModeId: string;
  effectiveModeId: string;
  pending: boolean;
  canRetry: boolean;
  retry: () => void;
};

/**
 * Runs an action at most once at a time.
 *
 * The ref closes the double-click window before the first `await`; `pending`
 * only drives the button's disabled state, and React would not have re-rendered
 * in time to stop the second click. The flag is always cleared, so a failed
 * attempt leaves the action usable — the alternative is a permanently dead
 * button on the one turn the user is trying to recover.
 */
export const useOneShotAction = (
  action: () => Promise<void>
): { pending: boolean; run: () => void } => {
  const inFlightRef = useRef(false);
  const [pending, setPending] = useState(false);
  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setPending(true);
    void actionRef
      .current()
      .catch(() => undefined)
      .finally(() => {
        inFlightRef.current = false;
        setPending(false);
      });
  }, []);

  return { pending, run };
};
