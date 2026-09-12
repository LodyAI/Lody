import { LoroDoc } from 'loro-crdt';
import type { SessionHistoryInput } from '@lody/shared';
import type { SessionDocument } from '../src/lib/loro/doc';

/**
 * Attach real storage to a `SessionDocument` test double: a real `LoroDoc`, the
 * control-plane Mirror, the one shared writer and the session-data seam.
 *
 * Tests previously did `doc.mirror = createSessionMirror({ doc, initialState })`
 * and read `doc.mirror.getState().history`. That is no longer the production
 * shape: history is read through `doc.getHistory()`/`doc.readHistorySnapshot()`
 * or the session-data reader, and written through `doc.sessionData`.
 *
 * Returns the composed `LoroDoc` so a test can assert raw storage or drive a
 * second writer/peer over the same doc.
 */
export function composeTestSessionDoc(
  sessionDoc: SessionDocument,
  options: {
    doc?: LoroDoc;
    history?: SessionHistoryInput[];
    session?: Record<string, unknown>;
  } = {}
): LoroDoc {
  const doc = options.doc ?? new LoroDoc();
  // `composeSessionData` does not assign `handle`; shallow readers and storage
  // metadata need it, matching `init()` which sets it from `openPersistedDoc`.
  sessionDoc.handle = { doc } as never;
  sessionDoc.composeSessionData(doc, {
    session: { id: sessionDoc.sessionId, ...(options.session ?? {}) },
    history: options.history ?? [],
  } as never);
  return doc;
}
