import { useMemo } from 'react';
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
