import { describe, expect, it } from 'vitest';
import {
  isAdmittedEncryptedWorkspace,
  resolveOptimisticWorkspaceRouteGuard,
  resolveWorkspaceAccessDeniedFallback,
} from '../src/lib/workspace-route-guard';

describe('resolveOptimisticWorkspaceRouteGuard', () => {
  it('waits until active workspace catches up when target access is confirmed', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: [{ slug: 'target-workspace' }, { slug: 'previous-workspace' }],
        activeOrganization: { slug: 'previous-workspace' },
      })
    ).toBe('wait-for-switch');
  });

  it('surfaces a switch error instead of waiting forever when the switch fails before orgs load', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: undefined,
        activeOrganization: { slug: 'previous-workspace' },
        error: new Error('Failed to switch organization'),
      })
    ).toBe('switch-error');
  });

  it('renders when server access is confirmed even if active organization switching is stale', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: [{ slug: 'target-workspace' }, { slug: 'previous-workspace' }],
        activeOrganization: { slug: 'previous-workspace' },
        error: new Error('Failed to switch organization'),
        serverAccessConfirmed: true,
      })
    ).toBe('render');
  });

  it('redirects when the target workspace is not in the accessible organization list', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'missing-workspace',
        organizations: [{ slug: 'current-workspace' }],
        activeOrganization: { slug: 'current-workspace' },
      })
    ).toBe('redirect');
  });

  it('renders when the target workspace is accessible but active organization is still hydrating', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: [{ slug: 'target-workspace' }, { slug: 'previous-workspace' }],
        activeOrganization: null,
      })
    ).toBe('render');
  });
});

describe('freshly created encrypted workspace', () => {
  const stale = {
    workspaceName: 'vault',
    organizations: [{ slug: 'personal' }],
    activeOrganization: { slug: 'personal' },
  };
  const mode = {
    accountId: 'account-A',
    workspaceSlug: 'vault',
    workspaceId: 'ws-vault',
    descriptor: { contentMode: 'e2ee' },
  };
  const runtime = { accountId: 'account-A', workspaceId: 'ws-vault', contentMode: 'e2ee' };

  it('stays open after admission while the organization list is still stale', () => {
    const accessConfirmed = isAdmittedEncryptedWorkspace('vault', mode, runtime);
    expect(accessConfirmed).toBe(true);
    expect(
      resolveOptimisticWorkspaceRouteGuard({ ...stale, serverAccessConfirmed: accessConfirmed })
    ).toBe('render');
  });

  it('does not count another workspace, account or an unopened runtime as admission', () => {
    expect(isAdmittedEncryptedWorkspace('other', mode, runtime)).toBe(false);
    expect(
      isAdmittedEncryptedWorkspace('vault', mode, { ...runtime, accountId: 'account-B' })
    ).toBe(false);
    expect(isAdmittedEncryptedWorkspace('vault', mode, { ...runtime, workspaceId: 'ws-old' })).toBe(
      false
    );
    expect(isAdmittedEncryptedWorkspace('vault', mode, null)).toBe(false);
    expect(
      isAdmittedEncryptedWorkspace(
        'vault',
        { ...mode, descriptor: { contentMode: 'plaintext' } },
        {
          ...runtime,
          contentMode: 'plaintext',
        }
      )
    ).toBe(false);
    expect(resolveOptimisticWorkspaceRouteGuard(stale)).toBe('redirect');
  });
});

describe('resolveWorkspaceAccessDeniedFallback', () => {
  it('uses the preferred workspace when it is an accessible fallback', () => {
    expect(
      resolveWorkspaceAccessDeniedFallback({
        workspaceName: 'stale-workspace',
        organizations: [{ slug: 'alpha' }, { slug: 'beta' }],
        activeOrganization: { slug: 'alpha' },
        preferredWorkspaceSlug: 'beta',
      })
    ).toEqual({ kind: 'workspace', slug: 'beta' });
  });

  it('redirects to workspace creation when the resolved organization list is empty', () => {
    expect(
      resolveWorkspaceAccessDeniedFallback({
        workspaceName: 'stale-workspace',
        organizations: [],
        activeOrganization: null,
      })
    ).toEqual({ kind: 'create-workspace' });
  });

  it('never offers a slug that was itself denied (A↔B redirect alternation regression)', () => {
    /* A user removed from BOTH workspaces while the cached org list still
       names both: /A falls back to B, /B must NOT fall back to A — that
       alternation remounted the whole workspace subtree per hop until React's
       nested-update limit (#185). Exhausted fallbacks wait instead. */
    const organizations = [{ slug: 'alpha' }, { slug: 'beta' }];
    expect(
      resolveWorkspaceAccessDeniedFallback({
        workspaceName: 'alpha',
        organizations,
        activeOrganization: null,
        deniedSlugs: new Set(),
      })
    ).toEqual({ kind: 'workspace', slug: 'beta' });
    expect(
      resolveWorkspaceAccessDeniedFallback({
        workspaceName: 'beta',
        organizations,
        activeOrganization: { slug: 'alpha' },
        preferredWorkspaceSlug: 'alpha',
        deniedSlugs: new Set(['alpha']),
      })
    ).toEqual({ kind: 'wait' });
  });
});
