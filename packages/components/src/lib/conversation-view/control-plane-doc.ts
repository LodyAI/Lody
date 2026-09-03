import type { LoroDoc, LoroEventBatch } from 'loro-crdt';

/**
 * A `LoroDoc` facade for the control-plane Mirror: the Mirror keeps session,
 * queue, preview, fork, cursor, and runtime-config state, and must never see
 * `history`.
 *
 * Two things are intercepted, everything else is forwarded to the real doc:
 *
 * - `subscribe`: events under an ignored root are dropped before the Mirror's
 *   listener runs. loro-mirror's incremental event path applies every root it
 *   receives — including roots its schema marks `Ignore` — so without this a
 *   streaming turn would be materialized into the in-memory `history` slot
 *   turn by turn, which is the cost this whole module exists to avoid.
 * - `getShallowValue`: loro-mirror enumerates doc roots once at construction
 *   (`ignoreUnknownProperties` mirrors roots its schema does not declare).
 *   Enumerating roots makes Loro walk every container of a lazily loaded
 *   snapshot (~35 ms for a 2,000-turn session), so the facade answers with
 *   nothing. Unknown roots still reach the Mirror through the incremental
 *   event path the moment they change, and the Mirror never deletes a root it
 *   does not hold, so nothing a newer peer wrote is at risk.
 */
export function createControlPlaneDoc(
  doc: LoroDoc,
  options: { ignoredRootKeys: readonly string[] }
): LoroDoc {
  const ignored = new Set(options.ignoredRootKeys);
  const subscribe = (listener: (batch: LoroEventBatch) => void) =>
    doc.subscribe((batch) => {
      const events = batch.events.filter((event) => !ignored.has(String(event.path[0])));
      if (events.length === 0) return;
      listener(events.length === batch.events.length ? batch : { ...batch, events });
    });
  const getShallowValue = () => ({});
  return new Proxy(doc, {
    get(target, property, receiver) {
      if (property === 'subscribe') return subscribe;
      if (property === 'getShallowValue') return getShallowValue;
      const value = Reflect.get(target, property, receiver === undefined ? target : target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
