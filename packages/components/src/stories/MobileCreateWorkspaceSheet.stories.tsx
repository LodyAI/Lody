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
import {
  clearPendingE2eeWorkspace,
  listPendingE2eeWorkspaces,
  savePendingE2eeWorkspace,
  setPendingE2eeWorkspaceArchived,
} from '@/lib/e2ee-workspace-storage';
import { AuthProvider } from '@/providers/convex-provider';

/* The real mobile create sheet in its encrypted-preview states. Every port is
   synthetic: no device key, network or real account is touched. */

const user = { id: 'synthetic-mobile-create-user', name: 'Synthetic', email: 'a@example.com' };
const pending = {
  accountId: user.id,
  requestId: 'synthetic-request',
  name: 'Field notes',
  slug: 'field-notes',
};
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

/** A saved request reopens locked to its original name and handle. */
export const ResumeSaved: Story = {
  beforeEach: () => {
    clearSaved();
    savePendingE2eeWorkspace(localStorage, pending);
  },
};

/** Continuing still could not confirm the result; the request stays saved. */
export const ResumeFailed: Story = {
  beforeEach: () => {
    clearSaved();
    savePendingE2eeWorkspace(localStorage, pending);
  },
  play: async () => {
    const body = within(document.body);
    await userEvent.click(
      await body.findByRole('button', { name: /Continue saved creation|继续已保存的创建请求/ })
    );
    await body.findByRole('alert');
  },
};

/** Two saved requests, one archived: the archive stays reachable for restore. */
export const ArchivedRequest: Story = {
  beforeEach: () => {
    clearSaved();
    const archived = {
      ...pending,
      requestId: 'synthetic-request-archived',
      name: 'Staging check 2',
      slug: 'staging-check-2',
    };
    savePendingE2eeWorkspace(localStorage, pending);
    savePendingE2eeWorkspace(localStorage, archived);
    setPendingE2eeWorkspaceArchived(localStorage, archived, true);
  },
  play: async () => {
    const body = within(document.body);
    await userEvent.click(await body.findByRole('button', { name: /Archived|已归档/ }));
  },
};
