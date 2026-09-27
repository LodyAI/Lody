import { describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@lody/shared';

import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { resolveWorkspaceDataScope } from '../src/lib/workspace-data-scope';

const createRuntime = (slug: string, id: string): WorkspaceRuntime =>
  ({ workspaceSlug: slug, workspaceId: id as WorkspaceId }) as WorkspaceRuntime;

const createDocMetaScope = (runtime: WorkspaceRuntime, ready = true) => ({
  runtime,
  workspaceId: runtime.workspaceId,
  workspaceSlug: runtime.workspaceSlug,
  ready,
});

describe('resolveWorkspaceDataScope', () => {
  it('rejects the previous runtime under a new route target', () => {
    const runtimeA = createRuntime('workspace-a', 'workspace-a-id');

    expect(
      resolveWorkspaceDataScope({
        targetSlug: 'workspace-b',
        runtime: runtimeA,
        docMetaScope: createDocMetaScope(runtimeA),
        organizationsReady: false,
        expectedWorkspaceId: null,
      })
    ).toEqual({
      status: 'switching',
      targetSlug: 'workspace-b',
      blocker: 'runtime_other_workspace',
    });
  });

  it('rejects metadata owned by an earlier runtime with the same target slug', () => {
    const oldRuntime = createRuntime('workspace-b', 'workspace-b-id');
    const currentRuntime = createRuntime('workspace-b', 'workspace-b-id');

    expect(
      resolveWorkspaceDataScope({
        targetSlug: 'workspace-b',
        runtime: currentRuntime,
        docMetaScope: createDocMetaScope(oldRuntime),
        organizationsReady: true,
        expectedWorkspaceId: 'workspace-b-id',
      })
    ).toEqual({ status: 'switching', targetSlug: 'workspace-b', blocker: 'doc_meta_scan_pending' });
  });

  it('rejects a matching snapshot until its bootstrap is ready', () => {
    const runtime = createRuntime('workspace-b', 'workspace-b-id');

    expect(
      resolveWorkspaceDataScope({
        targetSlug: 'workspace-b',
        runtime,
        docMetaScope: createDocMetaScope(runtime, false),
        organizationsReady: true,
        expectedWorkspaceId: 'workspace-b-id',
      })
    ).toEqual({ status: 'switching', targetSlug: 'workspace-b', blocker: 'doc_meta_scan_pending' });
  });

  it('allows an offline cached runtime without waiting for organizations', () => {
    const runtime = createRuntime('workspace-b', 'workspace-b-id');

    expect(
      resolveWorkspaceDataScope({
        targetSlug: 'workspace-b',
        runtime,
        docMetaScope: createDocMetaScope(runtime),
        organizationsReady: false,
        expectedWorkspaceId: null,
      })
    ).toEqual({
      status: 'ready',
      targetSlug: 'workspace-b',
      workspaceId: 'workspace-b-id',
      runtime,
    });
  });

  it('rejects a server organization id that disagrees with the runtime', () => {
    const runtime = createRuntime('workspace-b', 'cached-workspace-b-id');

    expect(
      resolveWorkspaceDataScope({
        targetSlug: 'workspace-b',
        runtime,
        docMetaScope: createDocMetaScope(runtime),
        organizationsReady: true,
        expectedWorkspaceId: 'server-workspace-b-id',
      })
    ).toEqual({ status: 'switching', targetSlug: 'workspace-b', blocker: 'workspace_id_mismatch' });
  });

  it('names each remaining reason the scope is held back', () => {
    const runtime = createRuntime('workspace-b', 'workspace-b-id');
    const resolve = (overrides: Partial<Parameters<typeof resolveWorkspaceDataScope>[0]>) =>
      resolveWorkspaceDataScope({
        targetSlug: 'workspace-b',
        runtime,
        docMetaScope: createDocMetaScope(runtime),
        organizationsReady: true,
        expectedWorkspaceId: 'workspace-b-id',
        ...overrides,
      });

    expect(resolve({ runtime: null })).toMatchObject({ blocker: 'runtime_missing' });
    expect(resolve({ docMetaScope: null })).toMatchObject({ blocker: 'doc_meta_scan_pending' });
    expect(
      resolve({
        docMetaScope: {
          ...createDocMetaScope(runtime, false),
          scanFailure: { errorType: 'TypeError' },
        },
      })
    ).toMatchObject({ blocker: 'doc_meta_scan_failed' });
    expect(resolve({ expectedWorkspaceId: null })).toMatchObject({
      blocker: 'workspace_not_in_organizations',
    });
  });
});
