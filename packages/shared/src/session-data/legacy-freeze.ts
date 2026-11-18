import type { LoroDoc } from 'loro-crdt';
const frozen = new WeakSet<LoroDoc>();
/** Permanently retire an old in-memory body after its admitted writers drain.
 * WASM detachment also fences containers captured before our facade guards.
 * Snapshot export may attach the Doc internally; re-detach synchronously before
 * returning bytes, so an async storage barrier never exposes an editable gap. */
export function freezeLegacySessionLoroDocument(doc: LoroDoc): void {
  if (frozen.has(doc)) return;
  doc.commit();
  doc.setDetachedEditing(false);
  const detach = doc.detach.bind(doc),
    exportSnapshot = doc.export.bind(doc);
  detach();
  doc.export = ((...args: Parameters<LoroDoc['export']>) => {
    try {
      return exportSnapshot(...args);
    } finally {
      detach();
    }
  }) as LoroDoc['export'];
  const reject = () => {
    throw new Error('Legacy Session author has retired');
  };
  doc.attach = reject;
  doc.setDetachedEditing = reject;
  doc.checkout = reject;
  frozen.add(doc);
}
