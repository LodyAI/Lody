import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Provider, createStore } from 'jotai';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { Result } from 'effect';
import { exportVerifiedState } from '@lody/e2ee-core/protocol';
import {
  createLocalPlatformProvider,
  createStaticStore,
  type E2eeRuntimeLedgerView,
  type E2eeWorkspaceRuntime,
  type PlatformE2eeWorkspaces,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { appendLedgerHistory, bytesToHex } from '@/lib/e2ee-ledger-history';
import { Route } from '@/routes/workspace/e2ee/$workspaceId';

// Public synthetic signed genesis shared with the existing ledger UI fixtures.
const workspaceId = 'stylex-route-173';
const genesisHash = '18cb6fa187326e2f18402cba33ef7f316b8a71b0e1d026da9b79c60f6b7055de';
const recordsHex = [
  '82860158208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c58200202020202020202020202020202020202020202020202020202020202020202500303030303030303030303030303030358200404040404040404040404040404040404040404040404040404040404040404582005050505050505050505050505050505050505050505050505050505050505055840116dc6d18360ac4d1020a255f4c4589f2bd533b045db20794f431079f298523ab37223a4d861f55ca506abb41876e2aefada1ee6931e9ca7e89c6a6235901a03',
];
const page = {
  workspaceId,
  genesisHash,
  checkpoint: { headHash: genesisHash, length: 1 },
  startIndex: 0,
  recordsHex,
  position: `p1:${workspaceId}:1:source:0`,
  nextCursor: null,
};
const verified = appendLedgerHistory(null, page, {
  workspaceId,
  genesisHash,
  localPin: genesisHash,
});
const exported = Result.getOrThrow(exportVerifiedState(verified.view));
const local: E2eeRuntimeLedgerView = {
  stateHex: bytesToHex(exported.bytes),
  recordsHex,
  status: {
    workspaceId,
    genesisHash,
    length: 1,
    headHash: genesisHash,
    stateDigest: bytesToHex(exported.stateDigest.toBytes()),
    position: page.position,
    epoch: 0,
    rotationRequired: false,
    deviceKind: 'personal',
    hasCurrentKey: true,
    continuityPending: false,
  },
};
const unsupported = async (): Promise<never> => {
  throw new Error('Synthetic ledger fixture has no content or creation transport');
};
const runtime: E2eeWorkspaceRuntime = {
  account: async () => ({ userId: 'stylex-route-173-account', source: 'offline' }),
  recordCreated: async () => {},
  open: async () => local.status,
  close: async () => {},
  status: async () => local.status,
  ledgerView: async () => local,
  ingestLedgerRecords: async () => local.status,
  refresh: async () => local.status,
  contentStreamsToken: unsupported,
  seal: unsupported,
  openContent: unsupported,
};
const port: PlatformE2eeWorkspaces = {
  runtime,
  create: unsupported,
  describe: async () => {
    if (!navigator.onLine) throw new TypeError('Failed to fetch');
    return {
      workspaceId,
      contentMode: 'e2ee',
      contentModeVersion: 1,
      activation: 'control-only',
      genesisHash,
      cryptoOrgId: genesisHash,
    };
  },
  history: async (request) => ({
    ...page,
    startIndex: request.after ? 1 : 0,
    recordsHex: request.after ? [] : recordsHex,
  }),
};

function E2eeRouteFixture() {
  const [fixture] = useState(() => {
    const root = createRootRoute({ component: Outlet });
    const originalRoute = {
      options: Route.options,
      id: Route.id,
      parent: Route.parentRoute,
    };
    const route = createRoute({
      path: '/workspace/e2ee/$workspaceId',
      getParentRoute: () => root,
      component: Route.options.component,
    });
    const router = createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: [`/workspace/e2ee/${workspaceId}`] }),
      context: {},
    });
    if (
      Route.options !== originalRoute.options ||
      Route.id !== originalRoute.id ||
      Route.parentRoute !== originalRoute.parent
    ) {
      throw new Error('The visual fixture must not mutate the production route');
    }
    const platform = {
      ...createLocalPlatformProvider({
        session: createStaticStore({
          status: 'authenticated',
          user: { id: 'stylex-route-173-account', name: 'Synthetic', email: 'ui@example.test' },
        }),
        workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
      }),
      e2eeWorkspaces: port,
    };
    return { store: createStore(), router, platform };
  });
  // The production component and children use a fresh same-path memory route.
  return (
    <Provider store={fixture.store}>
      <PlatformContext.Provider value={fixture.platform}>
        <RouterProvider router={fixture.router} />
      </PlatformContext.Provider>
    </Provider>
  );
}

const meta = {
  title: 'Migration/OwnedE2eeWorkspaceRoute',
  component: E2eeRouteFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof E2eeRouteFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NativeLedgerOfflineNotice: Story = {};
