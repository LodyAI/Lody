import { LoroDoc } from 'loro-crdt/base64';
import { clientFor, importUpdates, unpack } from '../session.ts';

// A bounded server read: never export unsent local edits or a projected UI cache.
export async function readShareHistory(
  workspace: string,
  id: string,
  getGrant: () => Promise<{ token: string; gatewayBaseUrl: string }>,
  signal: AbortSignal,
) {
  const client = await clientFor(`${workspace}:s:${id}`, getGrant);
  const doc = new LoroDoc();
  try {
    const initial = await client.bootstrap({ signal });
    if (!initial.ok) throw new Error('share_history_unavailable');
    let size = 0;
    const consume = (bytes: Uint8Array, snapshot = false) => {
      size += bytes.length;
      if (size > 32 * 1024 * 1024) throw new Error('share_history_limit');
      if (snapshot) doc.import(unpack(bytes));
      else importUpdates(doc, bytes);
    };
    const data = initial.result;
    if (data.snapshotOffset !== '-1' && data.snapshot)
      consume(data.snapshot.body, true);
    for (const update of data.updates) consume(update.body);
    let { nextOffset: offset, cursor, upToDate } = data;
    for (let pages = 0; !upToDate; pages++) {
      if (pages >= 100) throw new Error('share_history_limit');
      const next = await client.readOnce({ offset, cursor, signal });
      if (!next.ok || next.result.closed)
        throw new Error('share_history_unavailable');
      if (next.result.payload) consume(next.result.payload.body);
      if (!next.result.upToDate && next.result.nextOffset === offset)
        throw new Error('share_history_stalled');
      ({ nextOffset: offset, cursor, upToDate } = next.result);
    }
    signal.throwIfAborted();
    return doc.getList('history').toJSON();
  } finally {
    doc.free();
  }
}
