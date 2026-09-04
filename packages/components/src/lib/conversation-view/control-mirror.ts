import { Mirror } from 'loro-mirror';
import type { LoroDoc, LoroEventBatch } from 'loro-crdt';
import type { SessionId } from '@lody/shared';
import { sessionControlDocSchema } from './control-doc-schema';

export type SessionControlMirror = Mirror<typeof sessionControlDocSchema>;

const HISTORY_ROOT = 'history';

const isHistoryEvent = (event: LoroEventBatch['events'][number], historyRootId: string): boolean =>
  event.target === historyRootId ||
  (Array.isArray(event.path) && event.path[0] === HISTORY_ROOT);

/**
 * The control-plane Mirror: `sessionControlDocSchema` over the session doc.
 *
 * loro-mirror 2.3.1 honors an `Ignore` root when it builds its initial
 * snapshot, but its incremental event path does not: a doc event under
 * `history` is applied to the state anyway, which materializes the event's
 * delta into a partial `history` array and registers every container the
 * delta carries. Over a streaming session that is the whole transcript,
 * item by item, plus a registry that grows with every new container — the
 * exact cost the control schema exists to avoid, and a partial array whose
 * indices do not match the doc's. This installs an instance-level filter on
 * the two methods the Mirror runs on every batch so history events never
 * reach them. `ConversationView` owns those events.
 */
export function createSessionControlMirror(doc: LoroDoc, sessionId: SessionId): SessionControlMirror {
  const mirror = new Mirror({
    doc,
    schema: sessionControlDocSchema,
    // Tolerate root keys written by peers running a newer schema version.
    ignoreUnknownProperties: true,
    initialState: { session: { id: sessionId } },
    debug: false,
  });
  const historyRootId = doc.getList(HISTORY_ROOT).id as string;
  const withoutHistory = (batch: LoroEventBatch): LoroEventBatch => ({
    ...batch,
    events: batch.events.filter((event) => !isHistoryEvent(event, historyRootId)),
  });
  const internals = mirror as unknown as {
    normalizeLoroEventBatch: (batch: LoroEventBatch) => LoroEventBatch;
    registerContainersFromLoroEvent: (batch: LoroEventBatch) => void;
  };
  const normalize = internals.normalizeLoroEventBatch.bind(mirror);
  const register = internals.registerContainersFromLoroEvent.bind(mirror);
  internals.normalizeLoroEventBatch = (batch) => normalize(withoutHistory(batch));
  internals.registerContainersFromLoroEvent = (batch) => register(withoutHistory(batch));
  return mirror;
}
