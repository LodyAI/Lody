import type { LoroDoc } from 'loro-crdt';
import { freezeLegacySessionLoroDocument } from '@lody/shared/session-data/legacy-freeze';

/** The native route probe may itself initiate migration. It is deliberately
 * outside the legacy operation gate. A real legacy owner is published before
 * that gate releases its final admitted operation, so freeze cannot miss it. */
export async function openSessionBodyStore<Store>(ports: {
  openNative(): Promise<Store | undefined>;
  createLegacy(): Promise<Store>;
  runLegacy?(work: () => Promise<Store>): Promise<Store>;
  publishLegacy(store: Store): void;
  guardLegacy?(store: Store): Store;
}): Promise<Store> {
  const native = await ports.openNative();
  if (native) return native;
  const create = async () => {
    const original = await ports.createLegacy();
    ports.publishLegacy(original);
    return original;
  };
  const original = await (ports.runLegacy ? ports.runLegacy(create) : create());
  return ports.guardLegacy?.(original) ?? original;
}

/** A cache's pending creation may be waiting on this exact migration. Only a
 * materialized legacy store owns a Mirror that must be released; waiting on an
 * unmaterialized native probe would wait on ourselves. The real SDK unload,
 * not the cache's best-effort release, is the physical persistence receipt. */
export async function drainLegacySessionBodyStore(
  legacy: { readonly doc?: LoroDoc; dispose(): void } | undefined,
  ports: {
    refreshRoutes(): Promise<unknown>;
    unload(): Promise<unknown>;
    releaseMaterializedLegacy(): Promise<void>;
    forgetLegacy(): void;
  }
): Promise<void> {
  legacy?.dispose();
  if (legacy?.doc) freezeLegacySessionLoroDocument(legacy.doc);
  await ports.refreshRoutes();
  await ports.unload();
  if (legacy) await ports.releaseMaterializedLegacy();
  ports.forgetLegacy();
}
