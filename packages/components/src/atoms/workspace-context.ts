import { atom } from 'jotai';
import type { WorkspaceId } from '@lody/shared';

export type WorkspaceContext = {
  slug: string | null;
  workspaceId: WorkspaceId | null;
};

type VersionedWorkspaceContext = WorkspaceContext & { revision: number };

const workspaceContextAtom = atom<VersionedWorkspaceContext>({
  slug: null,
  workspaceId: null,
  revision: 0,
});

/** Read the latest identity and revision from an async continuation. */
export const workspaceContextSnapshotAtom = atom((get) => get(workspaceContextAtom));

/** Publish a route target and its resolved id as one observable state change. */
export const setWorkspaceContextAtom = atom(null, (get, set, context: WorkspaceContext) => {
  const revision = get(workspaceContextAtom).revision + 1;
  set(workspaceContextAtom, { ...context, revision });
  return revision;
});

/** Publish only if no newer route, logout, or mutation has replaced the transition. */
export const setWorkspaceContextAtRevisionAtom = atom(
  null,
  (get, set, update: { revision: number | null; context: WorkspaceContext }): boolean => {
    const current = get(workspaceContextAtom);
    if (update.revision === null || current.revision !== update.revision) return false;
    set(workspaceContextAtom, {
      ...update.context,
      revision: current.revision + 1,
    });
    return true;
  }
);

/** Clear only the route scope that is actually unmounting. */
export const clearWorkspaceContextForSlugAtom = atom(null, (get, set, slug: string) => {
  const current = get(workspaceContextAtom);
  if (current.slug === slug) {
    set(workspaceContextAtom, {
      slug: null,
      workspaceId: null,
      revision: current.revision + 1,
    });
  }
});

// Compatibility views for existing consumers. A route slug change clears the
// previous route's id in the same Jotai transaction, while an initial slug write
// preserves an id staged by legacy setup code.
export const currentWorkspaceIdAtom = atom(
  (get) => get(workspaceContextAtom).workspaceId,
  (get, set, workspaceId: WorkspaceId | null) => {
    const current = get(workspaceContextAtom);
    set(workspaceContextAtom, {
      ...current,
      workspaceId,
      revision: current.revision + 1,
    });
  }
);

export const currentWorkspaceSlugAtom = atom(
  (get) => get(workspaceContextAtom).slug,
  (get, set, slug: string | null) => {
    const current = get(workspaceContextAtom);
    set(workspaceContextAtom, {
      slug,
      workspaceId:
        slug === null || (current.slug !== null && current.slug !== slug)
          ? null
          : current.workspaceId,
      revision: current.revision + 1,
    });
  }
);
