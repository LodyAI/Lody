// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformProvider } from '@lody/platform';
import { usePlatform } from '@lody/platform/react';

const fixture = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  organization: {} as Record<string, unknown>,
}));

vi.mock('jotai', () => ({ useAtomValue: () => false }));
vi.mock('@/atoms/local-probe', () => ({ localAgentEnabledAtom: 'local-agent' }));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => false }));
vi.mock('@/hooks/useStableSession', () => ({ useStableSession: () => fixture.session }));
vi.mock('@/hooks/useOrganization', () => ({ useOrganization: () => fixture.organization }));
vi.mock('@/providers/convex-provider', () => ({ useAuthSignOut: () => async () => {} }));
vi.mock('@/providers/cloud-platform-api', () => ({ cloudPlatformApi: {} }));
vi.mock('@/providers/cloud-github-token-port', () => ({ cloudGitHubTokenPort: {} }));
vi.mock('@/lib/github-token-port', () => ({ installGitHubTokenPort: () => () => {} }));
vi.mock('@/lib/cloud-http-port', () => ({ installCloudHttpPort: () => () => {} }));

import { CloudPlatformProvider } from '@/providers/cloud-platform-provider';

/** What better-auth hands back on a refetch: equal data in new objects. */
function refetch(workspaceName: string) {
  const user = { id: 'user-a', email: 'a@example.com', name: 'A', image: null };
  fixture.session = { data: { user }, isPending: false, isRetrying: false, isOptimistic: false };
  // `createOrganization` closes over the refetched `user`, so it is new too.
  fixture.organization = {
    organizations: [{ id: 'workspace-a', name: 'A', slug: 'a' }],
    activeOrganization: { id: 'workspace-a' },
    role: 'owner',
    error: null,
    activateOrganization: async () => {},
    refetchActiveOrganization: async () => {},
    refetchOrganizations: async () => {},
    updateOrganization: async () => null,
    createOrganization: async () => ({ id: 'workspace-new', name: workspaceName, slug: null }),
  };
}

describe('CloudPlatformProvider', () => {
  let container: HTMLDivElement;
  let root: Root;
  const seen: PlatformProvider[] = [];
  function Probe() {
    seen.push(usePlatform());
    return null;
  }
  const render = () =>
    act(() => root.render(createElement(CloudPlatformProvider, null, createElement(Probe))));

  beforeEach(() => {
    seen.length = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps one platform object across a session refetch and calls the latest actions', async () => {
    refetch('first');
    await render();
    const first = seen.at(-1)!;
    expect(first.identity.session.get()).toMatchObject({
      status: 'authenticated',
      user: { id: 'user-a' },
    });

    refetch('second');
    await render();

    // A consumer that owns resources per platform object (the Prompt Shortcut
    // runtime) must not be torn down by a refetch that changed nothing.
    expect(seen.at(-1)).toBe(first);
    await expect(first.workspaces.create({ name: 'x' })).resolves.toMatchObject({
      name: 'second',
      role: 'owner',
    });
  });
});
