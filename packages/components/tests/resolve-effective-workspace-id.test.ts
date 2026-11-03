import { describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@lody/shared';

import { resolveEffectiveWorkspaceId } from '../src/providers/resolve-effective-workspace-id';

describe('resolveEffectiveWorkspaceId', () => {
  it('prefers server workspace id when it disagrees with cache (authoritative)', () => {
    expect(
      resolveEffectiveWorkspaceId({
        workspaceSlug: 'b',
        cachedWorkspaceId: 'w2' as WorkspaceId,
        serverWorkspaceId: 'w3' as WorkspaceId,
        prevWorkspaceSlug: 'b',
        prevServerWorkspaceId: 'w2' as WorkspaceId,
      })
    ).toBe('w3');
  });

  it('ignores mismatched server workspace id when it is stale during slug transition', () => {
    expect(
      resolveEffectiveWorkspaceId({
        workspaceSlug: 'b',
        cachedWorkspaceId: 'w2' as WorkspaceId,
        serverWorkspaceId: 'w1' as WorkspaceId,
        prevWorkspaceSlug: 'a',
        prevServerWorkspaceId: 'w1' as WorkspaceId,
      })
    ).toBe('w2');
  });

  it('treats serverWorkspaceId as stale when slug changed but id did not', () => {
    expect(
      resolveEffectiveWorkspaceId({
        workspaceSlug: 'b',
        cachedWorkspaceId: null,
        serverWorkspaceId: 'w1' as WorkspaceId,
        prevWorkspaceSlug: 'a',
        prevServerWorkspaceId: 'w1' as WorkspaceId,
      })
    ).toBeNull();
  });
});
