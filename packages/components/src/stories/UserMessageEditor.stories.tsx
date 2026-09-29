import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type {
  AcpCommandSummary,
  MachineId,
  MachineViewMeta,
  SessionHistoryParsed,
  SessionId,
  SessionMeta,
  WorkspaceId,
} from '@lody/shared';
import { getSessionRoomId } from '@lody/shared';

import { currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { machineMetaCacheAtom, sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { authTokenAtom } from '@/atoms/runtime';
import { UserMessageEditor } from '@/components/ai-gui/user-message-editor';
import type { UserMessageEditMentionContext } from '@/components/ai-gui/view';
import { MessageRowView } from '@/components/ai-gui/view';
import type { ConversationFontSize } from '@/atoms/settings';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';

const SHORT_TEXT = '你好';
const LONG_TEXT = Array.from(
  { length: 12 },
  (_, index) =>
    `Line ${index + 1}: rewrite the failing migration so the backfill is idempotent and re-runnable.`
).join('\n');

const STORY_WORKSPACE_ID = 'workspace-editor-story' as WorkspaceId;
const STORY_MACHINE_ID = 'machine-editor-story' as MachineId;
const STORY_SESSION_ID = 'session-editor-story' as SessionId;
const STORY_USER_ID = 'user-editor-story';

/**
 * A GitHub-project source is enough to light `@`/`/` without a local checkout:
 * the file and issue lists lazy-load off the source's repo, and the session
 * category reads the seeded meta cache below.
 */
const storyMentionSource: MentionProjectSource = {
  kind: 'github',
  repoFullName: 'loro-dev/lody',
  isPublic: true,
};

const storyCommands: AcpCommandSummary[] = [
  { name: 'review', description: 'Review the pending diff' },
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'plan', description: 'Enter plan mode' },
] as AcpCommandSummary[];

const storyEditMentionContext: UserMessageEditMentionContext = {
  mentionSource: storyMentionSource,
  availableCommands: storyCommands,
  skillAgent: {
    cliType: 'builtin',
    agentType: 'claude',
    machineId: STORY_MACHINE_ID,
  },
};

function createStoryStore() {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, STORY_WORKSPACE_ID);
  store.set(authTokenAtom, 'storybook-token');
  store.set(userAtom, {
    id: STORY_USER_ID,
    name: 'Storybook user',
  } as never);
  const machine: MachineViewMeta = {
    id: STORY_MACHINE_ID,
    name: 'Storybook Machine',
    os: 'macOS',
    cliVersion: '1.0.0',
    ownerUserId: STORY_USER_ID,
    sessions: [STORY_SESSION_ID],
    raceLimits: {},
  } as MachineViewMeta;
  store.set(machineMetaCacheAtom, { [STORY_MACHINE_ID]: machine });
  // Two mentionable sessions + the one being edited (excluded from `@` by
  // `currentSessionId`).
  const sessions: Record<string, SessionMeta> = {};
  for (const [id, title] of [
    ['session-alpha', 'Fix flaky scroll tests'],
    ['session-beta', 'Refactor mention hydration'],
  ] as const) {
    sessions[getSessionRoomId(id as SessionId)] = {
      id: id as SessionId,
      machineId: STORY_MACHINE_ID,
      userId: STORY_USER_ID,
      title,
      createdAt: '2026-09-20T10:00:00.000Z',
      status: { type: 'idle' },
      project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
    } as SessionMeta;
  }
  sessions[getSessionRoomId(STORY_SESSION_ID)] = {
    id: STORY_SESSION_ID,
    machineId: STORY_MACHINE_ID,
    userId: STORY_USER_ID,
    title: 'Session being edited',
    createdAt: '2026-09-28T10:00:00.000Z',
    status: { type: 'idle' },
    project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
  } as SessionMeta;
  store.set(sessionMetaCacheAtom, sessions);
  return store;
}

const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: STORY_USER_ID, name: 'Storybook user' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [
      {
        id: STORY_WORKSPACE_ID,
        name: 'Storybook',
        slug: 'storybook',
        role: 'owner',
      },
    ],
    activeWorkspaceId: STORY_WORKSPACE_ID,
  }),
});

function EditorHarness({
  initialValue,
  isSaving = false,
  conversationFontSize = 14,
  withMentions = false,
}: {
  initialValue: string;
  isSaving?: boolean;
  conversationFontSize?: ConversationFontSize;
  withMentions?: boolean;
}) {
  const store = useMemo(() => createStoryStore(), []);
  const [value, setValue] = useState(initialValue);
  const ctx = withMentions ? storyEditMentionContext : undefined;
  return (
    // The editor lives right-aligned in the user column, so preview it that way.
    <PlatformContext.Provider value={storyPlatform}>
      <Provider store={store}>
        <div className="flex w-[42rem] max-w-full justify-end">
          <UserMessageEditor
            value={value}
            onChange={setValue}
            onCancel={() => setValue(initialValue)}
            onSave={() => undefined}
            isSaving={isSaving}
            conversationFontSize={conversationFontSize}
            mentionSource={ctx?.mentionSource}
            availableCommands={ctx?.availableCommands}
            skillAgent={ctx?.skillAgent}
            currentSessionId={STORY_SESSION_ID}
          />
        </div>
      </Provider>
    </PlatformContext.Provider>
  );
}

const meta: Meta<typeof UserMessageEditor> = {
  title: 'AI GUI/UserMessageEditor',
  component: UserMessageEditor,
  parameters: { layout: 'centered' },
};

export default meta;

type Story = StoryObj<typeof UserMessageEditor>;

export const ShortMessage: Story = {
  render: () => <EditorHarness initialValue={SHORT_TEXT} />,
};

function FromMessageEditHarness() {
  const store = useMemo(() => createStoryStore(), []);
  return (
    <PlatformContext.Provider value={storyPlatform}>
      <Provider store={store}>
        <MessageRowView
          sessionId={STORY_SESSION_ID}
          message={
            {
              id: 'editable-user-message',
              role: 'user',
              timestamp: '2026-09-12T10:00:00.000Z',
              status: 'seen',
              read: true,
              items: [{ type: 'text', text: 'Clarify this instruction' }],
            } satisfies SessionHistoryParsed
          }
          onEdit={async () => true}
          editMentionContext={storyEditMentionContext}
        />
      </Provider>
    </PlatformContext.Provider>
  );
}

export const FromMessageEdit: Story = {
  render: () => <FromMessageEditHarness />,
};

/**
 * Acceptance: the editor is a real mention composer — typing `@` opens the
 * two-level menu and `/` opens the command menu.
 */
export const WithMentions: Story = {
  render: () => <EditorHarness initialValue="please rerun " withMentions />,
};

export const Empty: Story = {
  render: () => <EditorHarness initialValue="" />,
};

export const LongMessage: Story = {
  render: () => <EditorHarness initialValue={LONG_TEXT} />,
};

export const Saving: Story = {
  render: () => <EditorHarness initialValue={SHORT_TEXT} isSaving />,
};

export const LargeFontSize: Story = {
  render: () => <EditorHarness initialValue={SHORT_TEXT} conversationFontSize={24} />,
};

export const NarrowColumn: Story = {
  render: () => (
    <div className="w-[22rem]">
      <EditorHarness initialValue={SHORT_TEXT} />
    </div>
  ),
};
