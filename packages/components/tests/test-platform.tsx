import { useMemo, type ReactNode } from 'react';
import { Provider, createStore } from 'jotai';
import { userAtom } from '../src/atoms';
import { setWorkspaceContextAtom } from '../src/atoms/workspace-context';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import type { WorkspaceId } from '@lody/shared';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStaticStore,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { cloudPlatformApi } from '../src/providers/cloud-platform-api';

/**
 * Explicit cloud composition root for component and hook tests.
 *
 * The production PlatformContext intentionally has no default. Tests that
 * exercise cloud-backed UI should mount this provider so a missing app-level
 * platform assembly remains a fail-fast programming error.
 */
export const TEST_CLOUD_PLATFORM: PlatformProvider = {
  kind: 'cloud',
  identity: {
    session: createStaticStore({ status: 'unauthenticated' }),
    signOut: async () => {},
  },
  workspaces: {
    state: createStaticStore({
      status: 'ready',
      workspaces: [],
      activeWorkspaceId: null,
    }),
    setActive: async () => {},
  },
  capabilities: CLOUD_PLATFORM_CAPABILITIES,
  cloudApi: cloudPlatformApi,
  sync: { mode: 'cloud' },
};

export function TestCloudPlatformProvider({ children }: { children: ReactNode }) {
  return (
    <PlatformContext.Provider value={TEST_CLOUD_PLATFORM}>{children}</PlatformContext.Provider>
  );
}

/** Explicit synthetic ordinary admission for tests of legacy remote APIs.
 * The default cloud provider intentionally supplies no mode verdict. */
export function TestOrdinaryWorkspaceProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children?: ReactNode;
}) {
  const store = useMemo(() => {
    const value = createStore();
    value.set(userAtom, { id: 'test-cloud-account' } as never);
    value.set(setWorkspaceContextAtom, {
      workspaceId: workspaceId as WorkspaceId,
      slug: workspaceId,
    });
    value.set(workspaceContentModeAtom, {
      accountId: 'test-cloud-account',
      workspaceId,
      workspaceSlug: workspaceId,
      descriptor: { workspaceId, contentMode: 'plaintext', contentModeVersion: 1 },
    });
    return value;
  }, [workspaceId]);
  return (
    <TestCloudPlatformProvider>
      <Provider store={store}>{children}</Provider>
    </TestCloudPlatformProvider>
  );
}
