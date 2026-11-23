import { getServerNow, type StoredLodyOperation } from '@lody/shared';
import type { OperationProgressStatusByTarget } from '@lody/shared/session-data';
import type { SessionBackend } from '@/session/session-backend';
export {
  getOperationProgressTurnId,
  getOperationProgressTargetKey,
  buildOperationProgressContent,
  mergeOperationProgressContent,
} from '@lody/shared/session-data';
export type { OperationProgressStatusByTarget } from '@lody/shared/session-data';
export const upsertOperationProgressHistory = async (
  backend: Pick<SessionBackend, 'applyHistoryAction'>,
  operation: StoredLodyOperation,
  now: () => number = getServerNow,
  statusByTarget?: OperationProgressStatusByTarget
): Promise<void> => {
  await backend.applyHistoryAction({
    kind: 'operation-progress',
    operation,
    timestamp: new Date(now()).toISOString(),
    statuses: statusByTarget ? [...statusByTarget] : undefined,
  });
};
