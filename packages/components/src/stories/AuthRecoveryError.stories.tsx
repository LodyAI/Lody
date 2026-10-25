import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import { AuthRecoveryErrorView } from '@/components/auth-recovery-error';
import { AuthRecoveryEntryProvider } from '@/components/auth-recovery-entry';
import { LoroSidebar } from '@/components/loro-sidebar';
import { WorkspaceCard } from '@/components/workspace-frame';
import { SidebarUpdateBanner } from '@/components/sidebar-update-banner';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import {
  SessionConversationPage,
  SessionConversationPageBody,
} from '@/components/sessions/session-conversation-page';
import { SessionTabBar } from '@/components/sessions/session-tab-bar';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import { ChatComposer } from '@/components/chat/chat-composer';
import type { SessionHistoryParsed, SessionMeta } from '@lody/shared';

const session = {
  id: 'auth-recovery-story-session',
  machineId: 'storybook-machine',
  createdAt: '2026-10-25T06:00:00.000Z',
  title: 'Auth recovery in a real session',
  userId: 'storybook-user',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
  agentConfigId: 'storybook-agent',
  repoFullName: 'LodyAI/lody',
  branchName: 'fix/auth-recovery-ux',
  baseBranch: 'main',
  project: { kind: 'local', localProjectId: 'local:lody' },
} as unknown as SessionMeta;
const messages: SessionHistoryParsed[] = [
  {
    id: 'story-user-turn',
    role: 'user',
    read: true,
    timestamp: '2026-10-25T06:00:00.000Z',
    items: [{ type: 'text', text: 'Make connection recovery non-blocking so I can keep working.' }],
  },
  {
    id: 'story-assistant-turn',
    role: 'assistant',
    read: true,
    finished: true,
    timestamp: '2026-10-25T06:00:01.000Z',
    endedAt: Date.parse('2026-10-25T06:00:12.000Z'),
    items: [
      {
        type: 'text',
        text: 'I’ll keep the session and draft available during recovery. Connection status will have its own space in the workspace, with retry and sign-in available on demand.',
      },
    ],
  },
];
const platform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'storybook-user', name: 'Zixuan' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [{ id: 'lody', name: 'Lody', slug: 'lody', role: 'owner' }],
    activeWorkspaceId: 'lody',
  }),
});

function RealWorkspace({ recovery }: { recovery?: ReactNode }) {
  const [draft, setDraft] = useState('Keep this draft while the connection recovers.');
  const childSession = {
    ...session,
    id: 'auth-recovery-child' as SessionMeta['id'],
    title: 'Review the UX details',
  };
  return (
    <PlatformContext.Provider value={platform}>
      <AuthRecoveryEntryProvider notice={recovery}>
        <div className="flex h-dvh w-full overflow-hidden bg-sidebar text-foreground">
          <LoroSidebar
            workspaceName="Lody"
            userEmail="zixuan@lody.dev"
            workspaces={[{ id: 'lody', name: 'Lody', planTier: 'plus', memberCount: 4 }]}
            currentWorkspaceId="lody"
            workspaceSwitcherEnabled={false}
            activeNav="home"
            sessionListProps={{
              selectedSessionId: session.id,
              repos: [{ repoFullName: 'LodyAI/lody', collapsed: false }],
              sessions: [
                {
                  sessionId: session.id,
                  title: session.title ?? 'Auth recovery in a real session',
                  repoFullName: 'LodyAI/lody',
                  branchName: 'fix/auth-recovery-ux',
                  latestMessageAt: Date.now() - 180000,
                  addedLines: 128,
                  deletedLines: 42,
                  isWorking: false,
                  hasUnreadMessages: true,
                  isOffline: false,
                  isWaitingPermission: false,
                },
              ],
            }}
            bottomFloatingContent={
              <SidebarUpdateBanner
                stage="downloaded"
                version="1.4.2"
                percent={null}
                isRestarting={false}
                onViewChangelog={fn()}
                onRestart={fn()}
                onLater={fn()}
              />
            }
            onInviteClicked={fn()}
            onLinkRepoClicked={fn()}
            onSettingsClicked={fn()}
            onRequestCollapse={fn()}
            onHomeClicked={fn()}
            onArchiveClicked={fn()}
            onSchedulesClicked={fn()}
          />
          <WorkspaceCard>
            <main className="relative min-w-0 flex-1 overflow-hidden">
              <SessionConversationPage
                className="h-full"
                subHeaderSlot={
                  <SessionTabBar
                    variant="session"
                    parentSession={session}
                    childSessions={[childSession]}
                    draftTabs={[]}
                    archivedChildSessions={[]}
                    activeTabSessionId={session.id}
                    onTabSelect={fn()}
                    onNewTab={fn()}
                    onTabRename={fn()}
                    onTabClose={fn()}
                    tabOrder={[childSession.id]}
                  />
                }
                bodySlot={
                  <SessionConversationPageBody
                    streamSlot={
                      <SessionChatStreamView
                        sessionId={session.id}
                        items={messages.map((message, turnIndex) => ({
                          type: 'message',
                          sessionId: session.id,
                          message,
                          turnIndex,
                        }))}
                        renderMessageRow={({ message, sessionId }) => (
                          <MessageRowView message={message} sessionId={sessionId} />
                        )}
                      />
                    }
                    composerSlot={
                      <>
                        <SessionInfoBar
                          status={null}
                          projectName="LodyAI/lody"
                          branch="fix/auth-recovery-ux"
                          diffStat={{ add: 128, del: 42 }}
                          onOpenAllChanges={fn()}
                        />
                        <ChatComposer
                          variant="session"
                          tone="dark"
                          promptValue={draft}
                          onPromptChange={setDraft}
                          promptPlaceholder="Message the agent…"
                          primaryAction={<Button size="small">Send</Button>}
                          className="mx-auto mb-4 w-full max-w-3xl px-4"
                        />
                      </>
                    }
                  />
                }
              />
            </main>
          </WorkspaceCard>
        </div>
      </AuthRecoveryEntryProvider>
    </PlatformContext.Provider>
  );
}

function BlockingRecoveryDialog() {
  const { t } = useTranslation();
  return (
    <AlertDialog.Root open>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{t('authRecovery.failedTitle')}</AlertDialog.Title>
          <AlertDialog.Description>{t('authRecovery.failedDescription')}</AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <Button variant="secondary">{t('authRecovery.retry')}</Button>
          <Button>{t('authRecovery.signInAgain')}</Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

const meta = {
  title: 'Auth/RecoveryError',
  component: AuthRecoveryErrorView,
  parameters: { layout: 'fullscreen' },
  args: { onRetry: fn(), onSignOut: fn().mockResolvedValue(undefined) },
  globals: { theme: 'dark', locale: 'en' },
} satisfies Meta<typeof AuthRecoveryErrorView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BeforeBlocking: Story = {
  name: 'Before · blocking dialog',
  render: () => (
    <>
      <RealWorkspace />
      <BlockingRecoveryDialog />
    </>
  ),
};
export const AfterNonBlocking: Story = {
  name: 'After · non-blocking status',
  render: (args) => (
    <RealWorkspace
      recovery={<AuthRecoveryErrorView {...args} onSignOut={async () => undefined} />}
    />
  ),
};
export const Reconnecting: Story = {
  render: (args) => (
    <RealWorkspace
      recovery={<AuthRecoveryErrorView {...args} isRecovering onSignOut={async () => undefined} />}
    />
  ),
};
export const Offline: Story = {
  render: (args) => (
    <RealWorkspace
      recovery={<AuthRecoveryErrorView {...args} isOffline onSignOut={async () => undefined} />}
    />
  ),
};
export const Interactive: Story = {
  render: function InteractiveRecovery(args) {
    const [phase, setPhase] = useState<'paused' | 'recovering' | 'healthy'>('paused');
    return (
      <RealWorkspace
        recovery={
          phase === 'healthy' ? undefined : (
            <AuthRecoveryErrorView
              {...args}
              isRecovering={phase === 'recovering'}
              onRetry={() => setPhase('recovering')}
              onSignOut={async () => undefined}
            />
          )
        }
      />
    );
  },
};
export const FailureWhileTyping: Story = {
  render: function FailureWhileTypingStory(args) {
    const [failed, setFailed] = useState(false);
    return (
      <>
        <RealWorkspace
          recovery={
            failed ? <AuthRecoveryErrorView {...args} onSignOut={async () => undefined} /> : null
          }
        />
        {!failed ? (
          <Button className="fixed right-4 top-4 z-50" size="small" onClick={() => setFailed(true)}>
            Simulate recovery failure
          </Button>
        ) : null}
      </>
    );
  },
};
