import { useEffect, useMemo, useState } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouter,
} from '@tanstack/react-router';
import { ChatLandingView } from '@/components/chat/chat-landing-view';
import {
  getSessionCreationNavigation,
  useComposerNavigationFocus,
} from '@/components/chat/submission/use-composer-navigation-focus';
import { useIsMobile } from '@/hooks/use-mobile';
import { isNativeAppShell } from '@/lib/native-platform';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type {
  AgentConfigId,
  MachineId,
  MachineViewMeta,
  SessionId,
  SessionMeta,
  WorkspaceId,
} from '@lody/shared';

import { currentWorkspaceIdAtom } from '@/atoms';
import { machineMetaCacheAtom } from '@/atoms/doc-meta';
import { authTokenAtom } from '@/atoms/runtime';
import { SessionChatInputArea } from '@/components/sessions/session-chat-input-area';

const STORY_WORKSPACE_ID = 'workspace-storybook' as WorkspaceId;
const STORY_MACHINE_ID = 'machine-storybook' as MachineId;
const STORY_AGENT_CONFIG_ID = 'agent-storybook' as AgentConfigId;
const STORY_SESSION_ID = 'session-storybook' as SessionId;
const STORY_AUTH_TOKEN = 'storybook-token';

const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'user-storybook', name: 'Storybook user' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [{ id: STORY_WORKSPACE_ID, name: 'Storybook', slug: 'storybook', role: 'owner' }],
    activeWorkspaceId: STORY_WORKSPACE_ID,
  }),
});

const storyMachineViewMeta: MachineViewMeta = {
  id: STORY_MACHINE_ID,
  name: 'Storybook Machine',
  os: 'macOS',
  cliVersion: '1.0.0',
  sessions: [STORY_SESSION_ID],
  raceLimits: {},
};

type StoryShellProps = {
  isAgentBusy: boolean;
  initialInputText?: string;
  showFreeTurnLimitNotice?: boolean;
  onSendMessage?: () => Promise<boolean>;
  claimNavigationFocus?: () => boolean;
};

function createStoryStore() {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, STORY_WORKSPACE_ID);
  store.set(authTokenAtom, STORY_AUTH_TOKEN);
  store.set(machineMetaCacheAtom, {
    [STORY_MACHINE_ID]: storyMachineViewMeta,
  });
  return store;
}

function StoryShell({
  isAgentBusy,
  initialInputText = '',
  showFreeTurnLimitNotice = false,
  onSendMessage = async () => true,
  claimNavigationFocus,
}: StoryShellProps) {
  const store = useMemo(() => createStoryStore(), []);
  const session = useMemo<SessionMeta>(
    () => ({
      id: isAgentBusy
        ? ('session-storybook-running' as SessionId)
        : ('session-storybook-idle' as SessionId),
      machineId: STORY_MACHINE_ID,
      createdAt: '2026-04-10T00:00:00.000Z',
      title: isAgentBusy ? 'Running Session' : 'Idle Session',
      userId: 'user-storybook',
      status: isAgentBusy ? { type: 'running' } : { type: 'idle' },
      cliType: 'builtin',
      agentType: 'codex',
      agentConfigId: STORY_AGENT_CONFIG_ID,
      repoFullName: 'loro-dev/lody',
      project: {
        kind: 'github',
        repoFullName: 'loro-dev/lody',
        branch: 'fix/vscode-theme-adaptation',
      },
      baseBranch: 'main',
    }),
    [isAgentBusy]
  );

  return (
    <PlatformContext.Provider value={storyPlatform}>
      <Provider store={store}>
        <div className="min-h-screen bg-background px-6 py-10">
          <div className="mx-auto max-w-4xl overflow-hidden rounded-[28px] border border-border/70 bg-card shadow-xs">
            <div className="h-[20rem] bg-muted/20" />
            <SessionChatInputArea
              session={session}
              claimNavigationFocus={claimNavigationFocus}
              sessionLocalProjectRootPath={null}
              isMachineRemoved={false}
              isAgentBusy={isAgentBusy}
              canStopAgent={isAgentBusy}
              isDark
              isEmptyConversation={false}
              selectedModeId={null}
              selectedModelId={null}
              modeOptions={[]}
              modelOptions={[]}
              availableCommands={[]}
              freeTurnLimitNotice={
                showFreeTurnLimitNotice
                  ? {
                      current: 25,
                      limit: 30,
                      onUpgrade: () => {},
                    }
                  : null
              }
              onModeChange={() => {}}
              onModelChange={() => {}}
              onSendMessage={onSendMessage}
              onStop={() => {}}
              onRemoveQueueItem={async () => {}}
              initialInputText={initialInputText}
              disableImageUpload
            />
          </div>
        </div>
      </Provider>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Sessions/SessionChatInputArea',
  component: StoryShell,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    isAgentBusy: false,
    initialInputText: '',
    showFreeTurnLimitNotice: false,
  },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const IdleDark: Story = {
  globals: {
    theme: 'dark',
  },
};

export const RunningDark: Story = {
  args: {
    isAgentBusy: true,
  },
  globals: {
    theme: 'dark',
  },
};

export const DraftDark: Story = {
  args: {
    initialInputText: 'Audit the theme token mapping for the current session input controls.',
  },
  globals: {
    theme: 'dark',
  },
};

export const FreeTurnLimitNoticeDark: Story = {
  args: {
    showFreeTurnLimitNotice: true,
  },
  globals: {
    theme: 'dark',
  },
};

// Explicit acceptance signal lets browser tests exercise the real pending commit
// without network, elapsed-time assumptions, or a fake composer.
export const DeferredSubmission: Story = {
  args: {
    onSendMessage: () =>
      new Promise<boolean>((resolve) => {
        window.addEventListener(
          'storybook:submission-result',
          (event) => {
            resolve((event as CustomEvent<boolean>).detail);
          },
          { once: true }
        );
      }),
  },
};

function NavigationLanding() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [prompt, setPrompt] = useState('');
  const navigate = () => {
    void router.navigate(
      getSessionCreationNavigation(
        'storybook',
        'session-storybook-idle',
        isMobile || isNativeAppShell()
      )
    );
  };
  return (
    <>
      <ChatLandingView
        tone="light"
        title="New chat"
        isMobile={isMobile}
        promptValue={prompt}
        onPromptChange={setPrompt}
        onSubmit={navigate}
        submitLabel="Send"
        errorLabels={{ tryAgain: 'Retry' }}
        onPromptKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            navigate();
          }
        }}
      />
      <button onClick={() => router.history.back()}>Back to session</button>
    </>
  );
}

function NavigationSession() {
  const router = useRouter();
  const claimNavigationFocus = useComposerNavigationFocus('session-storybook-idle');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const markReady = () => setReady(true);
    window.addEventListener('storybook:composer-ready', markReady);
    return () => window.removeEventListener('storybook:composer-ready', markReady);
  }, []);
  return (
    <>
      <button onClick={() => void router.navigate({ to: '/' })}>Leave session</button>
      {ready ? (
        <StoryShell isAgentBusy={false} claimNavigationFocus={claimNavigationFocus} />
      ) : (
        <p>Preparing session</p>
      )}
    </>
  );
}

function NavigationStory() {
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: Outlet });
    const landingRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: NavigationLanding,
    });
    const sessionRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/$workspaceName/sessions/$sessionId',
      component: NavigationSession,
    });
    return createRouter({
      routeTree: rootRoute.addChildren([landingRoute, sessionRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
  }, []);
  return (
    <PlatformContext.Provider value={storyPlatform}>
      <RouterProvider router={router} />
    </PlatformContext.Provider>
  );
}

export const LandingNavigation: Story = { render: () => <NavigationStory /> };
