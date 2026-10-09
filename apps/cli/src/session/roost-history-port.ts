import {
  fromApplicationJson,
  toApplicationJson,
  type HistoryProjectedMessage,
} from '@loro-dev/roost/lody-history';
import type { RoostHistorySegment, RoostHistoryPort } from '@lody/shared/session-data';

/**
 * Convert the current Roost 0.1.1 projected row into Lody's storage-neutral
 * port DTO. Shared readers and session orchestration do not inspect the
 * published Roost package's envelope or segment storage.
 */
export function adaptRoostProjectedMessage(row: HistoryProjectedMessage): RoostHistorySegment {
  return {
    businessId: row.businessId,
    segmentId: row.segmentId,
    content: toApplicationJson(row.content),
    nextSeq: row.nextSeq,
    sealed: row.sealed,
  };
}

export function adaptRoostProjectedMessages(
  rows: readonly HistoryProjectedMessage[]
): readonly RoostHistorySegment[] {
  return rows.map(adaptRoostProjectedMessage);
}

/** Validated optional fields use undefined for absence; JSON storage omits them. */
export function encodeRoostContent(value: unknown) {
  return fromApplicationJson(JSON.parse(JSON.stringify(value)));
}

/**
 * Bind the published Roost projection to the Lody history port. The caller owns
 * change subscription and lifecycle; this adapter performs no polling or fallback.
 */
export function createRoostReadPort(
  history: Pick<
    { readProjectedMessages(): Promise<readonly HistoryProjectedMessage[]> },
    'readProjectedMessages'
  >,
  observe: RoostHistoryPort['observe']
): RoostHistoryPort {
  return {
    readProjectedMessages: async () =>
      adaptRoostProjectedMessages(await history.readProjectedMessages()),
    observe,
  };
}
