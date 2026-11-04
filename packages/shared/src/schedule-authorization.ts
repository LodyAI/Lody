import { isContainer, LoroMap, type LoroDoc, type OpId } from 'loro-crdt';
import { z } from 'zod';
import { scheduleDefinitionFingerprint } from './schedule-registry';
import type { ScheduleDocument } from './schedule-types';

export const SCHEDULE_AUTHORIZATIONS = 'scheduleAuthorizations';
export const ScheduleAuthorizationRequestSchema = z.object({
  scheduleId: z.string().min(1).max(256),
  definitionFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  manualRunKey: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type ScheduleAuthorizationRequest = z.infer<typeof ScheduleAuthorizationRequestSchema>;

/** The transport signature, never a field in this record, supplies the author. */
export function recordScheduleAuthorization(
  doc: LoroDoc,
  document: ScheduleDocument,
  manualRunKey?: string
): void {
  const record = doc.getList(SCHEDULE_AUTHORIZATIONS).pushContainer(new LoroMap());
  record.set('definitionFingerprint', scheduleDefinitionFingerprint(document));
  record.set('kind', manualRunKey ? 'manual' : 'definition');
  if (manualRunKey) record.set('manualRunKey', manualRunKey);
  doc.commit();
}

export function readScheduleAuthorization(doc: LoroDoc, manualRunKey?: string) {
  const list = doc.getList(SCHEDULE_AUTHORIZATIONS);
  for (let index = list.length - 1; index >= 0; index--) {
    const value = list.get(index);
    if (!isContainer(value) || value.kind() !== 'Map') continue;
    const record = value as LoroMap;
    if (record.get('kind') !== (manualRunKey ? 'manual' : 'definition')) continue;
    if (manualRunKey && record.get('manualRunKey') !== manualRunKey) continue;
    const id = list.getIdAt(index);
    return id ? { id, value: record.toJSON() as unknown } : undefined;
  }
  return undefined;
}

/** Include deletes and even same-value rewrites; value equality cannot preserve a grant. */
export function scheduleChangedSince(doc: LoroDoc, signed: Pick<LoroDoc, 'version'>): boolean {
  const version = signed.version();
  for (const [peer, end] of doc.version().toJSON()) {
    const start = version.get(peer) ?? 0;
    if (start >= end) continue;
    for (const container of doc.getChangedContainersIn(
      { peer, counter: start } as OpId,
      end - start
    )) {
      const root = doc.getPathToContainer(container)?.[0];
      if (root === 'definition' || root === 'prompt' || root === 'message') return true;
    }
  }
  return false;
}

/** A waiter fences execution edits and replacement declarations, not timeline work. */
export function captureScheduleAuthorization(doc: LoroDoc, manualRunKey?: string): () => boolean {
  const version = doc.version();
  const read = () =>
    JSON.stringify([
      readScheduleAuthorization(doc),
      ...(manualRunKey ? [readScheduleAuthorization(doc, manualRunKey)] : []),
    ]);
  const declarations = read();
  return () => declarations === read() && !scheduleChangedSince(doc, { version: () => version });
}
