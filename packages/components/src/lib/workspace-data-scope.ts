import type { WorkspaceId } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import type { DocMetaCacheScope } from '@/atoms/doc-meta';

export type WorkspaceDataScopeState =
  | { status: 'switching'; targetSlug: string }
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
  if (!runtime || runtime.workspaceSlug !== targetSlug) {
    return { status: 'switching', targetSlug };
  }
  if (!docMetaScope || docMetaScope.runtime !== runtime || !docMetaScope.ready) {
    return { status: 'switching', targetSlug };
  }
  if (
    organizationsReady &&
    (expectedWorkspaceId === null || expectedWorkspaceId !== runtime.workspaceId)
  ) {
    return { status: 'switching', targetSlug };
  }
  return {
    status: 'ready',
    targetSlug,
    workspaceId: runtime.workspaceId,
    runtime,
  };
}
