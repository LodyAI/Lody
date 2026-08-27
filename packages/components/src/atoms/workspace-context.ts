import { atom } from 'jotai';
import type { WorkspaceId } from '@lody/shared';

export type WorkspaceContext = {
  slug: string | null;
  workspaceId: WorkspaceId | null;
};

const workspaceContextAtom = atom<WorkspaceContext>({
  slug: null,
  workspaceId: null,
});

/** Publish a route target and its resolved id as one observable state change. */
export const setWorkspaceContextAtom = atom(null, (_get, set, context: WorkspaceContext) =>
  set(workspaceContextAtom, context)
);

/** Clear only the route scope that is actually unmounting. */
export const clearWorkspaceContextForSlugAtom = atom(null, (get, set, slug: string) => {
  if (get(workspaceContextAtom).slug === slug) {
    set(workspaceContextAtom, { slug: null, workspaceId: null });
  }
});

// Compatibility views for existing consumers. A route slug change clears the
// previous route's id in the same Jotai transaction, while an initial slug write
// preserves an id staged by legacy setup code.
export const currentWorkspaceIdAtom = atom(
  (get) => get(workspaceContextAtom).workspaceId,
  (get, set, workspaceId: WorkspaceId | null) => {
    const current = get(workspaceContextAtom);
    set(workspaceContextAtom, { ...current, workspaceId });
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
    });
  }
);
