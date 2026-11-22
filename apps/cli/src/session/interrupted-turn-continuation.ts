import {
  buildPendingUserHistoryEntry,
  buildSessionTurnInputConfig,
  normalizeSessionInputBlocks,
  normalizeSessionTurnInputConfig,
  resolveResumableAcpSessionId,
  type SessionHistoryInput,
  type SessionMeta,
} from '@lody/shared';

/**
 * A Turn interrupted by a process end is not replayed. After the next start its
 * Session receives one new input whose whole text is `continue`, the message users
 * otherwise send by hand. Spec: `specs/interrupted-turn-continuation.md`.
 */
export const INTERRUPTED_TURN_CONTINUATION_TEXT = 'continue';
/** Stable id prefix: an interrupted continuation is recognized and never continued again. */
export const INTERRUPTED_TURN_CONTINUATION_ID_PREFIX = 'lody-continue-';

export type InterruptedTurnContinuationPlan =
  | { kind: 'continue'; entry: SessionHistoryInput & { id: string } }
  | {
      kind: 'skip';
      reason:
        | 'continuation-interrupted'
        | 'session-unavailable'
        | 'session-archived'
        | 'not-a-user-turn'
        | 'newer-input'
        | 'queued-input'
        | 'already-continued';
    };

/**
 * A process end (crash, kill or orderly restart during a running prompt) leaves the
 * input's dispatch claim, `processingUserMsgId`, in Session metadata; every other
 * ending clears it. Only the owning Machine continues its own interrupted Turns.
 */
export function isTurnInterruptedByProcessEnd(
  meta: Pick<SessionMeta, 'machineId' | 'processingUserMsgId'> | undefined,
  machineId: string,
  userTurnId: string
): boolean {
  return meta?.machineId === machineId && meta.processingUserMsgId === userTurnId;
}

export function interruptedTurnContinuationId(interruptedTurnId: string): string {
  return `${INTERRUPTED_TURN_CONTINUATION_ID_PREFIX}${interruptedTurnId}`;
}

/**
 * Decide whether an interrupted Turn's Session continues. The user wins: an archived
 * Session, a newer activated input or queued input means the user already moved on.
 * The continuation keeps the interrupted input's Agent configuration, never its text.
 */
export function planInterruptedTurnContinuation(args: {
  interruptedTurnId: string;
  interruptedTurn: { role: string; userId?: string; inputConfig?: unknown } | undefined;
  meta: SessionMeta | undefined;
  queuedInputCount: number;
  continuationExists: boolean;
  timestamp: string;
}): InterruptedTurnContinuationPlan {
  const { interruptedTurnId, interruptedTurn, meta } = args;
  if (interruptedTurnId.startsWith(INTERRUPTED_TURN_CONTINUATION_ID_PREFIX))
    return { kind: 'skip', reason: 'continuation-interrupted' };
  if (!meta) return { kind: 'skip', reason: 'session-unavailable' };
  if (meta.isArchived === true) return { kind: 'skip', reason: 'session-archived' };
  if (args.continuationExists) return { kind: 'skip', reason: 'already-continued' };
  if (meta.latestUserMsgId !== undefined && meta.latestUserMsgId !== interruptedTurnId)
    return { kind: 'skip', reason: 'newer-input' };
  if (args.queuedInputCount > 0) return { kind: 'skip', reason: 'queued-input' };
  const config = normalizeSessionTurnInputConfig(interruptedTurn?.inputConfig);
  const cliType = config?.cliType ?? meta.cliType;
  const agentType = config?.agentType ?? meta.agentType;
  if (interruptedTurn?.role !== 'user' || !cliType || !agentType)
    return { kind: 'skip', reason: 'not-a-user-turn' };
  const inputBlocks = normalizeSessionInputBlocks(undefined, INTERRUPTED_TURN_CONTINUATION_TEXT);
  const pending = buildPendingUserHistoryEntry({
    userId: interruptedTurn.userId ?? meta.userId,
    inputBlocks,
    timestamp: args.timestamp,
    inputConfig: buildSessionTurnInputConfig({
      inputBlocks,
      prompt: INTERRUPTED_TURN_CONTINUATION_TEXT,
      cliType,
      agentType,
      modeId: config?.modeId,
      modelId: config?.modelId,
      configOptionValues: config?.configOptionValues,
      memory: config?.memory,
      mcpServerIds: config?.mcpServerIds,
      agentRoleId: config?.agentRoleId,
      agentRoleRevision: config?.agentRoleRevision,
      agentRoleSnapshot: config?.agentRoleSnapshot,
      resume: resolveResumableAcpSessionId(meta),
    }),
  });
  if (!pending) return { kind: 'skip', reason: 'not-a-user-turn' };
  return {
    kind: 'continue',
    entry: {
      ...pending,
      id: interruptedTurnContinuationId(interruptedTurnId),
      // Lody, not the human, sent this input.
      author: { v: 1, kind: 'system' },
    },
  };
}
