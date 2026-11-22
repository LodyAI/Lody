import { atom } from 'jotai';
import { Brand } from 'effect';
import type { WorkspaceId } from '@lody/shared';
import { workspaceRuntimeInitFailureAtom } from './runtime';

export type WorkspaceContext = {
  slug: string | null;
  workspaceId: WorkspaceId | null;
};

/**
 * Nominal proof minted only when a device has verified both its credential and
 * the current epoch key for an encrypted workspace, allowing it to hand off to
 * the workspace route without losing `workspaceId` on initial mount.
 */
export type AdmittedWorkspaceTicket = {
  readonly accountId: string;
  readonly slug: string;
  readonly workspaceId: WorkspaceId;
} & Brand.Brand<'AdmittedWorkspaceTicket'>;

export const AdmittedWorkspaceTicket = Brand.nominal<AdmittedWorkspaceTicket>();

export function mintAdmittedWorkspaceTicket(input: {
  accountId: string;
  slug: string;
  workspaceId: WorkspaceId;
  hasDeviceCredential: boolean;
  hasCurrentKey: boolean;
}): AdmittedWorkspaceTicket | null {
  if (!input.hasDeviceCredential || !input.hasCurrentKey) return null;
  return AdmittedWorkspaceTicket({
    accountId: input.accountId,
    slug: input.slug,
    workspaceId: input.workspaceId,
  });
}

type VersionedWorkspaceContext = WorkspaceContext & { revision: number };

const workspaceContextAtom = atom<VersionedWorkspaceContext>({
  slug: null,
  workspaceId: null,
  revision: 0,
});

/** Read the latest identity and revision from an async continuation. */
export const workspaceContextSnapshotAtom = atom((get) => get(workspaceContextAtom));

/** Publish a route target and its resolved id as one observable state change. */
export const setWorkspaceContextAtom = atom(
  null,
  (get, set, context: WorkspaceContext | AdmittedWorkspaceTicket) => {
    const current = get(workspaceContextAtom);
    if ('accountId' in context && workspaceRuntimeInitFailureAtom && typeof workspaceRuntimeInitFailureAtom === 'object') {
      const failure = get(workspaceRuntimeInitFailureAtom);
      if (
        failure &&
        (failure.workspaceSlug === context.slug || failure.workspaceId === context.workspaceId)
      ) {
        set(workspaceRuntimeInitFailureAtom, null);
      }
    }
    // Preserve an already-staged workspaceId for the same slug when a route mount
    // optimism pass publishes `{ slug, workspaceId: null }` before `access` resolves.
    const preservedWorkspaceId =
      context.workspaceId === null &&
      context.slug !== null &&
      current.slug === context.slug &&
      current.workspaceId !== null
        ? current.workspaceId
        : context.workspaceId;
    const revision = current.revision + 1;
    set(workspaceContextAtom, {
      slug: context.slug,
      workspaceId: preservedWorkspaceId,
      revision,
    });
    return revision;
  }
);

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
