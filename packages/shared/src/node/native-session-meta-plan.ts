import type {
  SessionMeta,
  SessionQueuePromotionRecord,
  SessionSteerOperationRecord,
} from '@lody/shared';
export function prepareSessionQueuePromotionLedger(
  meta: SessionMeta | undefined,
  operationId: string,
  record: SessionQueuePromotionRecord | undefined
): SessionMeta['queuePromotionLedger'] {
  const ledger = { ...(meta?.queuePromotionLedger ?? {}) };
  if (record) ledger[operationId] = record;
  else delete ledger[operationId];
  const entries = Object.entries(ledger);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - 64)));
}
export function prepareSessionSteerOperationLedger(
  meta: SessionMeta | undefined,
  operationId: string,
  record: SessionSteerOperationRecord | undefined
): SessionMeta['steerOperationLedger'] {
  if (record && record.operationId !== operationId)
    throw new Error(`Steer operation id does not match ledger key ${operationId}`);
  const ledger = { ...(meta?.steerOperationLedger ?? {}) };
  if (record) ledger[operationId] = record;
  else delete ledger[operationId];
  const records = Object.entries(ledger);
  if (records.length > 128) {
    const settled = records
      .filter(([, entry]) => entry.phase === 'settled')
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [id] of settled.slice(0, Math.max(0, records.length - 128))) delete ledger[id];
  }
  return ledger;
}
