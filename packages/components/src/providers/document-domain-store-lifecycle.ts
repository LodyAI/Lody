import { documentDomainMigrationScope } from '@lody/shared/renderer-document-domain-migration';
import type { LoroDoc } from 'loro-crdt';
import { freezeLegacySessionLoroDocument } from '@lody/shared/session-data/legacy-freeze';
export type DocumentDomainDrainPhase =
  | 'detach'
  | 'dispose'
  | 'seal'
  | 'persist'
  | 'unload'
  | 'cache_release';
/** One leaf document's persistence boundary. Workspace flush also joins every
 * unrelated Doc/Flock/Meta writer; the SDK's targeted persist and unload are
 * the exact durable receipt needed here. Failed release retains the old owner. */
export async function drainLegacyDocumentDomainStore(
  legacy: { dispose(): void } | undefined,
  doc: LoroDoc | undefined,
  ports: {
    detach(): Promise<unknown>;
    persist(doc: LoroDoc): Promise<unknown>;
    unload(): Promise<unknown>;
    releaseMaterializedLegacy(): Promise<unknown>;
    forgetLegacy(): void;
    onFailure?(
      phase: DocumentDomainDrainPhase,
      code: 'resource_busy' | 'legacy_room_frozen' | 'unavailable'
    ): void;
  }
): Promise<void> {
  let phase: DocumentDomainDrainPhase = 'detach';
  try {
    await ports.detach();
    phase = 'dispose';
    legacy?.dispose();
    if (doc) {
      phase = 'seal';
      freezeLegacySessionLoroDocument(doc);
      phase = 'persist';
      await ports.persist(doc);
    }
    phase = 'unload';
    await ports.unload();
    if (legacy) {
      phase = 'cache_release';
      await ports.releaseMaterializedLegacy();
    }
    ports.forgetLegacy();
  } catch (error) {
    const code =
      error instanceof Error
        ? error.name === 'ResourceBusyError'
          ? 'resource_busy'
          : error.message === 'Legacy document author is frozen'
            ? 'legacy_room_frozen'
            : 'unavailable'
        : 'unavailable';
    try {
      ports.onFailure?.(phase, code);
    } catch {
      /* Diagnostics cannot replace the retained room failure. */
    }
    throw error;
  }
}

/** Runtime epoch notifications accept an internal full freeze scope too. Keep
 * the wire Target parser strict by projecting only its two public identity fields. */
export function notifyDocumentDomainEpoch(
  target: import('@lody/shared/native-document-domain-ipc').NativeDocumentDomainTarget,
  epochs: Map<string, number>,
  listeners: ReadonlyMap<string, ReadonlySet<() => void>>,
  onListenerFailure?: () => void
): void {
  const roomId = documentDomainMigrationScope({ domain: target.domain, id: target.id }).roomId;
  epochs.set(roomId, (epochs.get(roomId) ?? 0) + 1);
  for (const listener of listeners.get(roomId) ?? []) {
    try {
      listener();
    } catch {
      try {
        onListenerFailure?.();
      } catch {
        /* One view cannot interrupt the freeze. */
      }
    }
  }
}
