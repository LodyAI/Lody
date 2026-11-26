import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent, within } from 'storybook/test';
import type { ReactNode } from 'react';
import { Provider as JotaiProvider } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import {
  createCapabilitySet,
  createLocalPlatformProvider,
  createStaticStore,
  type CloudApi,
  type PlatformE2eeWorkspaces,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';

import { userAtom } from '@/atoms';
import { developerModeEnabledAtom, e2eeWorkspaceCreationEnabledAtom } from '@/atoms/settings';
import { MobileCreateWorkspaceSheet } from '@/components/mobile/mobile-create-workspace-sheet';
import { AuthenticatedConvexContext } from '@/hooks/use-authenticated-convex';
import type { LodyAuthClient } from '@/lib/auth';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { clearPendingE2eeWorkspace, listPendingE2eeWorkspaces } from '@/lib/e2ee-workspace-storage';
import { AuthProvider } from '@/providers/convex-provider';

/* The real mobile create sheet in its encrypted-preview states. Every port is
   synthetic: no device key, network or real account is touched. */

const user = { id: 'synthetic-mobile-create-user', name: 'Synthetic', email: 'a@example.com' };
const local = createLocalPlatformProvider({
  session: createStaticStore({ status: 'authenticated', user }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});
const cloudApi = {
  useQuery: (operation) => {
    if (operation.name === cloudOperations.billing.getWorkspaceCreationAvailability.name)
      return { canCreateFree: true };
    if (operation.name === cloudOperations.auth.isWorkspaceSlugAvailable.name)
      return { available: true };
    return undefined;
  },
  useMutation: () => async () => null,
  useAction: () => async () => null,
} as CloudApi;
const e2eeWorkspaces = {
  prepareCreation: async () => {
    throw new Error('synthetic lost response');
  },
} as unknown as PlatformE2eeWorkspaces;
const platform = {
  ...local,
  cloudApi,
  e2eeWorkspaces,
  capabilities: createCapabilitySet([...local.capabilities.list(), 'cloudAccount', 'billing']),
};
const authClient = {
  useSession: () => ({ data: null, isPending: false, error: null, refetch: async () => ({}) }),
  useListOrganizations: () => ({ data: [], isPending: false, error: null, refetch: fn() }),
  useActiveOrganization: () => ({ data: null, isPending: false, error: null, refetch: fn() }),
} as unknown as LodyAuthClient;

function Hydrate({ children }: { children: ReactNode }) {
  useHydrateAtoms([
    [userAtom, user],
    [developerModeEnabledAtom, true],
    [e2eeWorkspaceCreationEnabledAtom, true],
  ] as never);
  return <>{children}</>;
}

function Sheet() {
  return (
    <JotaiProvider>
      <PlatformContext.Provider value={platform}>
        <AuthProvider authClient={authClient}>
          <AuthenticatedConvexContext.Provider
            value={{ isAuthenticated: true, isLoading: false } as never}
          >
            <Hydrate>
              <MobileCreateWorkspaceSheet open onOpenChange={fn()} onCreated={fn()} />
            </Hydrate>
          </AuthenticatedConvexContext.Provider>
        </AuthProvider>
      </PlatformContext.Provider>
    </JotaiProvider>
  );
}

const clearSaved = () => {
  for (const saved of listPendingE2eeWorkspaces(localStorage, user.id))
    clearPendingE2eeWorkspace(localStorage, saved);
};

const meta = {
  title: 'Mobile/MobileCreateWorkspaceSheet',
  component: Sheet,
  parameters: { layout: 'fullscreen', viewport: { defaultViewport: 'mobile2' } },
  beforeEach: clearSaved,
} satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Developer preview on: the standard / encrypted choice sits below the ordinary fields. */
export const EncryptionOffered: Story = {};

/** Encrypted chosen: the same cost points and loss warning the desktop page shows. */
export const EncryptedSelected: Story = {
  play: async () => {
    const body = within(document.body);
    await userEvent.click(await body.findByTestId('mobile-create-workspace-encrypted'));
  },
};
