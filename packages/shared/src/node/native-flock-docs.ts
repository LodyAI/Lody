import type { RepoClient } from '@loro-dev/loro-repo-client';
import type { ExternalFlockDocFeed, ExternalFlockDocsAdapter } from 'loro-repo';
import { observeFlockRegisters } from './native-repo';
import { registersToBundle, type FlockExportBundle } from '../native-flock-bundle';

/** Type-only loro-repo use keeps its WASM out of the Electron main bundle. */
const CAPABILITY = 'loro-external-flock-docs-v1' as const;

/** Commits replica payloads: UTF-8 export bundles or complete Flock files. */
export async function commitFlockPayloads(
  client: RepoClient,
  namespace: string,
  flockDocId: string,
  payloads: readonly Uint8Array[]
) {
  const room = { kind: 'flock' as const, id: flockDocId };
  for (const payload of payloads)
    await client.importRoomState(
      namespace,
      room,
      payload[0] === 0x7b ? { updates: [payload] } : { snapshot: payload }
    );
}

/** Register view of one named Flock document (creates the room if needed). */
export async function observeNativeFlockDoc(
  client: RepoClient,
  namespace: string,
  flockDocId: string,
  listener: Parameters<typeof observeFlockRegisters>[3]
) {
  const room = { kind: 'flock' as const, id: flockDocId };
  await client.createRoom(namespace, room, 'plaintext');
  return observeFlockRegisters(client, namespace, room, listener);
}

/**
 * Owner of selected named Flock documents for a LoroRepo in this process. Each
 * open replica has one register observation on the shared connection; a
 * reload after reconnect delivers the whole room again, which merges by clock.
 * `fileToBundle` converts a raw room file (the caller's Flock WASM).
 */
export function createNativeFlockDocs(
  client: RepoClient,
  namespace: string,
  owns: (flockDocId: string) => boolean,
  fileToBundle: (file: Uint8Array) => FlockExportBundle
): ExternalFlockDocsAdapter {
  return {
    capability: CAPABILITY,
    owns,
    async open(flockDocId, onChange): Promise<ExternalFlockDocFeed> {
      let snapshot: Uint8Array | undefined;
      const observation = await observeNativeFlockDoc(client, namespace, flockDocId, (event) => {
        if (event.kind === 'snapshot') {
          if (snapshot === undefined) snapshot = event.file;
          else onChange(fileToBundle(event.file));
        } else if (event.kind === 'changes' && event.registers.length) {
          onChange(registersToBundle(event.registers));
        }
      });
      try {
        await observation.ready;
      } catch (error) {
        await observation.release().catch(() => {});
        throw error;
      }
      return { snapshot, close: () => observation.release() };
    },
    commit: (flockDocId, payloads) => commitFlockPayloads(client, namespace, flockDocId, payloads),
  };
}
