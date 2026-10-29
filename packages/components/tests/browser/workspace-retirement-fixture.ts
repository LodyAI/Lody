import * as personal from '../../../e2ee-client/test/browser/host-fixture';
import {
  createWorkspaceRuntimeRetirements,
  type WorkspaceRuntimeResources,
} from '../../src/providers/workspace-runtime-retirements';
export { personal };
const owners = createWorkspaceRuntimeRetirements();
let resources: WorkspaceRuntimeResources;
let closing: Promise<void>, incomplete: unknown;
export async function retirePersonal() {
  const status = await personal.runtimeReader.status();
  const identity = {
    accountId: 'account',
    genesisHash: status.genesisHash,
    signingPublicKey: status.signingPublicKey!,
  };
  resources = {
    native: { ...identity, workspaceId: status.workspaceId },
    repo: { workspaceId: status.workspaceId, identity },
  };
  const entry = owners.create(() => resources, personal.runtimeReader.close);
  closing = owners.retire(entry);
  void closing.catch((error) => {
    incomplete = error;
  });
}
export async function closeOutcome() {
  try {
    await closing;
    return 'closed';
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
export async function samePhysicalIdentity() {
  try {
    await owners.drain({ native: { ...resources.native!, signingPublicKey: 'ee'.repeat(32) } });
    return { blocked: false, sameOwner: false };
  } catch (error) {
    const previous = incomplete as { owner?: unknown },
      current = error as { code?: string; owner?: unknown };
    return {
      blocked: current.code === 'close-incomplete',
      sameOwner: !!previous.owner && current.owner === previous.owner,
    };
  }
}
export async function finishRetirement() {
  await owners.drain(resources);
}
const openDraftDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ordinary-independent-workspace-B', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
export async function ordinaryDraft() {
  try {
    await owners.drain({ repo: { workspaceId: 'independent-workspace-B' } });
    let db = await openDraftDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put('ordinary draft remains writable', 'draft');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
    db = await openDraftDb();
    try {
      const body = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction('drafts'),
          read = tx.objectStore('drafts').get('draft');
        tx.oncomplete = () => resolve(read.result);
        tx.onabort = () => reject(tx.error);
      });
      return { opened: true, body };
    } finally {
      db.close();
    }
  } catch (error) {
    return { opened: false, code: (error as { code?: string }).code };
  }
}
