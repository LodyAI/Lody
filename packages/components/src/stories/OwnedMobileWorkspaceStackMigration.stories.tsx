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
  useLocation,
  useRouter,
} from '@tanstack/react-router';
import * as stylex from '@stylexjs/stylex';
import type { WorkspaceId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { MobileWorkspaceStack } from '@/components/mobile/mobile-workspace-stack';
import { setWorkspaceContextAtom } from '@/atoms/workspace-context';
import { docMetaCacheReadyAtom } from '@/atoms/doc-meta';
import { runtimeInitializingAtom } from '@/atoms/control-connection';
import { runtimeAtom } from '@/atoms/runtime';
import { SettingsStoryProviders } from './settings-story-shell';

const slug = 'lody';
const sessionId = 'visual-loading-session';
const styles = stylex.create({ frame: { height: '100dvh', width: '100%', position: 'relative' } });

function StackRoute() {
  const router = useRouter();
  const pathname = useLocation({ select: (state) => state.pathname });
  return (
    <div {...stylex.props(styles.frame)} data-mobile-stack-fixture data-fixture-path={pathname}>
      {pathname.endsWith('/chat') ? (
        <Button
          data-reopen-stack
          onClick={() =>
            void router.navigate({
              to: '/$workspaceName/sessions/$sessionId',
              params: { workspaceName: slug, sessionId },
            })
          }
        >
          Open synthetic loading session
        </Button>
      ) : null}
      <MobileWorkspaceStack workspaceName={slug} />
      <Outlet />
    </div>
  );
}

function StackFixture() {
  const [fixture] = useState(() => {
    const store = createStore();
    store.set(setWorkspaceContextAtom, {
      slug,
      workspaceId: 'settings-story-workspace' as WorkspaceId,
    });
    store.set(docMetaCacheReadyAtom, true);
    store.set(runtimeInitializingAtom, false);
    store.set(runtimeAtom, null);
    const root = createRootRoute({ component: Outlet });
    const workspace = createRoute({
      getParentRoute: () => root,
      path: '$workspaceName',
      component: StackRoute,
    });
    const auth = createRoute({ getParentRoute: () => workspace, id: '_auth', component: Outlet });
    const chat = createRoute({ getParentRoute: () => auth, path: 'chat', component: () => null });
    const session = createRoute({
      getParentRoute: () => auth,
      path: 'sessions/$sessionId',
      component: () => null,
    });
    const router = createRouter({
      routeTree: root.addChildren([workspace.addChildren([auth.addChildren([chat, session])])]),
      history: createMemoryHistory({ initialEntries: [`/${slug}/sessions/${sessionId}`] }),
      context: {},
    });
    return { store, router };
  });
  // This directly mounts the real stack with a missing runtime, not a complete
  // workspace-ready host. SessionDetail must remain its real loading surface.
  return (
    <Provider store={fixture.store}>
      <SettingsStoryProviders>
        <RouterProvider router={fixture.router} />
      </SettingsStoryProviders>
    </Provider>
  );
}

const meta = {
  title: 'Migration/OwnedMobileWorkspaceStack',
  component: StackFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof StackFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LoadingSession: Story = {};
