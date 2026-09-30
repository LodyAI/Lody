import type { WorkspaceId } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import type { DocMetaCacheScope } from '@/atoms/doc-meta';

/**
 * The first condition holding a workspace scope back from `ready`, in check
 * order. Diagnostics report it; product code only reads `status`.
 */
export type WorkspaceDataScopeBlocker =
  /** No active runtime yet. */
  | 'runtime_missing'
  /** The active runtime still belongs to the previous workspace. */
  | 'runtime_other_workspace'
  /** The runtime's first doc-metadata scan has not resolved. */
  | 'doc_meta_scan_pending'
  /** The runtime's first doc-metadata scan rejected; nothing retries it. */
  | 'doc_meta_scan_failed'
  /** Organizations loaded, and none of them has the target slug. */
  | 'workspace_not_in_organizations'
  /** The organization's workspace id disagrees with the runtime's. */
  | 'workspace_id_mismatch';

export type WorkspaceDataScopeState =
  | { status: 'switching'; targetSlug: string; blocker: WorkspaceDataScopeBlocker }
  | {
      status: 'ready';
      targetSlug: string;
      workspaceId: WorkspaceId;
      runtime: WorkspaceRuntime;
    };

export function resolveWorkspaceDataScope({
  targetSlug,
  runtime,
  docMetaScope,
  organizationsReady,
  expectedWorkspaceId,
}: {
  targetSlug: string;
  runtime: WorkspaceRuntime | null;
  docMetaScope: DocMetaCacheScope | null;
  organizationsReady: boolean;
  expectedWorkspaceId: string | null;
}): WorkspaceDataScopeState {
  if (!runtime) {
    return { status: 'switching', targetSlug, blocker: 'runtime_missing' };
  }
  if (runtime.workspaceSlug !== targetSlug) {
    return { status: 'switching', targetSlug, blocker: 'runtime_other_workspace' };
  }
  if (!docMetaScope || docMetaScope.runtime !== runtime || !docMetaScope.ready) {
    const failed = docMetaScope?.runtime === runtime && docMetaScope.scanFailure !== undefined;
    return {
      status: 'switching',
      targetSlug,
      blocker: failed ? 'doc_meta_scan_failed' : 'doc_meta_scan_pending',
    };
  }
  if (organizationsReady && expectedWorkspaceId === null) {
    return { status: 'switching', targetSlug, blocker: 'workspace_not_in_organizations' };
  }
  if (organizationsReady && expectedWorkspaceId !== runtime.workspaceId) {
    return { status: 'switching', targetSlug, blocker: 'workspace_id_mismatch' };
  }
  return {
    status: 'ready',
    targetSlug,
    workspaceId: runtime.workspaceId,
    runtime,
  };
}
