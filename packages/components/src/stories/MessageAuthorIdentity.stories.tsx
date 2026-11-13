import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { getSessionRoomId, type SessionHistoryParsed, type SessionId } from '@lody/shared';
import { setDocMetaByRoomIdAtom } from '@/atoms/doc-meta';
import { MessageAuthorIdentity } from '@/components/ai-gui/message-author-identity';
import { MessageRowView } from '@/components/ai-gui/view';
import { ConversationColumn } from '@/components/shared/conversation-column';

const meta = {
  title: 'Sessions/MessageAuthorIdentity',
  component: MessageAuthorIdentity,
  args: {
    author: {
      v: 1,
      kind: 'agent',
      sessionId: 'synthetic-source',
      turnId: 'synthetic-turn',
      name: 'Codex',
      cliType: 'builtin',
      agentType: 'codex',
      model: { id: 'synthetic-model', name: 'Example model', source: 'runtime' },
      reasoningEffort: 'high',
    },
  },
} satisfies Meta<typeof MessageAuthorIdentity>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Agent: Story = {};
export const Role: Story = {
  args: {
    author: {
      ...meta.args.author,
      role: { id: 'reviewer', revision: 1, name: 'Reviewer', emoji: '🔎' },
    },
  },
};
export const DeletedRoleSnapshot: Story = {
  args: {
    author: {
      ...meta.args.author,
      role: { id: 'deleted-role', revision: 3, name: 'Historical reviewer', emoji: '🧭' },
    },
  },
};

const targetSessionId = 'synthetic-target' as SessionId;
const delegatedMessage: SessionHistoryParsed = {
  id: 'delegated-user-turn',
  role: 'user',
  timestamp: '2026-10-05T12:04:00.000Z',
  read: true,
  author: {
    v: 1,
    kind: 'agent',
    sessionId: 'synthetic-source',
    turnId: 'synthetic-turn',
    name: 'Claude Code',
    cliType: 'builtin',
    agentType: 'claude_code',
    role: { id: 'dispatcher', revision: 1, name: 'Opus Manager', emoji: '🧭' },
    model: { id: 'claude-opus-4-6', source: 'runtime' },
    reasoningEffort: 'medium',
  },
  items: [
    {
      type: 'text',
      text: 'Please fix the flaky portal assertion in review-page.test.tsx and report back once it passes 20 consecutive runs.',
    },
  ],
};

function DelegatedMessageRowDemo() {
  const store = useMemo(() => {
    const next = createStore();
    next.set(setDocMetaByRoomIdAtom, getSessionRoomId('synthetic-source' as SessionId), {
      id: 'synthetic-source',
      title: 'Coordinate PR #789 regression fix',
    });
    return next;
  }, []);

  return (
    <JotaiProvider store={store}>
      <div className="w-[720px] max-w-full bg-background py-6">
        <ConversationColumn>
          <MessageRowView
            message={delegatedMessage}
            sessionId={targetSessionId}
            showSenderIdentity={false}
            onNavigateSession={() => {}}
          />
        </ConversationColumn>
      </div>
    </JotaiProvider>
  );
}

export const DelegatedMessageRow: Story = {
  render: () => <DelegatedMessageRowDemo />,
};
