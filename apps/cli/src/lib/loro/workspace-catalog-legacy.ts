import {
  createLegacyWorkspaceCatalogCommands,
  createLegacyWorkspaceCatalogQuery,
  getWorkspaceFlockDocId,
  parseWorkspaceFlockRow,
  type WorkspaceCatalogBinding,
  type WorkspaceCatalogCommands,
  type WorkspaceCatalogQuery,
  type WorkspaceCatalogRoleLookup,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import { isDeepStrictEqual } from 'node:util';

/** Borrow the manager's whole legacy room; no extra replica or sync owner. */
export function createLegacyCliWorkspaceCatalog(options: {
  repo: Pick<LoroRepo, 'openFlockDoc' | 'flush'>;
  binding: WorkspaceCatalogBinding;
  isCurrent(): boolean;
}): WorkspaceCatalogQuery & WorkspaceCatalogCommands & WorkspaceCatalogRoleLookup {
  const binding = Object.freeze({ ...options.binding });
  const open = async () => {
    if (!options.isCurrent()) throw new Error('Workspace catalog scope is closed');
    const handle = await options.repo.openFlockDoc(getWorkspaceFlockDocId(binding.workspaceId));
    if (!options.isCurrent()) throw new Error('Workspace catalog scope is closed');
    return handle;
  };
  return {
    ...createLegacyWorkspaceCatalogQuery({
      binding,
      open,
      authorizeRoleLookup: () => options.isCurrent(),
    }),
    ...createLegacyWorkspaceCatalogCommands({
      binding,
      isCurrent: options.isCurrent,
      put: async (key, value) => {
        const { flock } = await open();
        const raw = flock.get([...key]);
        const previous = raw === undefined ? undefined : parseWorkspaceFlockRow(key, raw);
        if (raw !== undefined && !previous) throw new Error('Unsupported workspace catalog row');
        if (isDeepStrictEqual(previous, parseWorkspaceFlockRow(key, value))) return false;
        flock.set([...key], value as Parameters<typeof flock.set>[1]);
        flock.commit();
        await options.repo.flush();
        return true;
      },
      remove: async (key) => {
        const { flock } = await open();
        if (!parseWorkspaceFlockRow(key, flock.get([...key]))) return false;
        flock.delete([...key]);
        flock.commit();
        await options.repo.flush();
        return true;
      },
      update: async (key, plan) => {
        const { flock } = await open();
        const changed = flock.txn(() => {
          if (!options.isCurrent()) throw new Error('Workspace catalog scope is closed');
          const next = plan(flock.get([...key]));
          if (next === undefined) return false;
          flock.set([...key], next as Parameters<typeof flock.set>[1]);
          return true;
        });
        if (changed) await options.repo.flush();
        return changed;
      },
      upload: async () => {
        await (await open()).syncOnce();
      },
    }),
  };
}
