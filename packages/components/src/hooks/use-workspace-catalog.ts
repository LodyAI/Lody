import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import {
  acquireWorkspaceCatalog,
  EMPTY_WORKSPACE_CATALOG,
  type WorkspaceCatalogSnapshot,
} from '@/lib/workspace-catalog-room';

/**
 * The workspace document's catalogs. Every consumer in a workspace reads one
 * shared, ref-counted room, so the snapshot object is identity-stable across
 * mounts as well as renders.
 *
 * The snapshot is stored with the runtime it came from and only returned for
 * that runtime: the effect that joins the next workspace's room runs after the
 * first render of the switch, and that render must not show — or send with —
 * the previous workspace's catalog or project defaults.
 */
export function useWorkspaceCatalog(): WorkspaceCatalogSnapshot {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const [state, setState] = useState<{
    runtime: WorkspaceRuntime | null;
    snapshot: WorkspaceCatalogSnapshot;
  }>({ runtime: null, snapshot: EMPTY_WORKSPACE_CATALOG });

  useEffect(() => {
    if (!runtime) {
      setState({ runtime: null, snapshot: EMPTY_WORKSPACE_CATALOG });
      return undefined;
    }
    const lease = acquireWorkspaceCatalog(runtime, (snapshot) => setState({ runtime, snapshot }));
    setState({ runtime, snapshot: lease.snapshot });
    return lease.release;
  }, [runtime]);

  return runtime && state.runtime === runtime ? state.snapshot : EMPTY_WORKSPACE_CATALOG;
}
