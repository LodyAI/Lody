import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceId } from '@lody/shared';

vi.mock('@/lib/auth-bootstrap', () => ({
  readStoredAuthToken: () => null,
}));

import { resolveActiveWorkspaceRuntimeState, type WorkspaceRuntime } from '../src/atoms/runtime';

const createRuntime = (
  overrides: Partial<Pick<WorkspaceRuntime, 'workspaceId' | 'workspaceSlug'>> = {}
): WorkspaceRuntime =>
  ({
    workspaceSlug: overrides.workspaceSlug ?? 'workspace-slug',
    workspaceId: overrides.workspaceId ?? ('workspace-1' as WorkspaceId),
  }) as WorkspaceRuntime;

describe('resolveActiveWorkspaceRuntimeState', () => {
  it('keeps local cached runtime ready before the server workspace id is available', () => {
    const runtime = createRuntime();

    expect(
      resolveActiveWorkspaceRuntimeState({
        runtime,
        workspaceId: null,
        workspaceSlug: 'workspace-slug',
      })
    ).toEqual({ status: 'ready', runtime });
  });

  it('keeps local cached runtime ready when the workspace id atom still has the previous route value', () => {
    const runtime = createRuntime();

    expect(
      resolveActiveWorkspaceRuntimeState({
        runtime,
        workspaceId: 'previous-workspace-id' as WorkspaceId,
        workspaceSlug: 'workspace-slug',
      })
    ).toEqual({ status: 'ready', runtime });
  });

  it('rejects a runtime from a different route slug', () => {
    const runtime = createRuntime({ workspaceSlug: 'previous-workspace' });

    expect(
      resolveActiveWorkspaceRuntimeState({
        runtime,
        workspaceId: null,
        workspaceSlug: 'workspace-slug',
      })
    ).toEqual({
      status: 'stale',
      runtime: null,
      rawRuntime: runtime,
      reason: 'workspace-slug-mismatch',
    });
  });

  it('rejects a runtime by workspace id when there is no route slug', () => {
    const runtime = createRuntime({ workspaceId: 'previous-workspace-id' as WorkspaceId });

    expect(
      resolveActiveWorkspaceRuntimeState({
        runtime,
        workspaceId: 'workspace-1' as WorkspaceId,
        workspaceSlug: null,
      })
    ).toEqual({
      status: 'stale',
      runtime: null,
      rawRuntime: runtime,
      reason: 'workspace-id-mismatch',
    });
  });
});
