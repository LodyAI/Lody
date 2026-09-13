import { getServerNow, type StoredLodyOperation } from '@lody/shared';
import { requireSessionAccepted, type SessionData } from '@lody/shared/session-data';
import type { OperationProgressStatusByTarget } from '@lody/shared/session-data';
export {
  getOperationProgressTurnId,
  getOperationProgressTargetKey,
  buildOperationProgressContent,
  mergeOperationProgressContent,
} from '@lody/shared/session-data';
export type { OperationProgressStatusByTarget } from '@lody/shared/session-data';
export type OperationProgressHistoryDocument = { sessionData: SessionData };
export const upsertOperationProgressHistory = async (
  sessionDoc: OperationProgressHistoryDocument,
  operation: StoredLodyOperation,
  now: () => number = getServerNow,
  statusByTarget?: OperationProgressStatusByTarget
): Promise<void> => {
  requireSessionAccepted(
    await sessionDoc.sessionData.commands.applyHistoryAction({
      kind: 'operation-progress',
      operation,
      timestamp: new Date(now()).toISOString(),
      statuses: statusByTarget ? [...statusByTarget] : undefined,
    })
  );
};
