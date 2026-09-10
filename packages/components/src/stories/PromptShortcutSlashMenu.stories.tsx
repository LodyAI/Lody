import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { PromptShortcutIndexEntry, ShortcutAvailability } from '@lody/shared/prompt-shortcuts';
import { Mention, MentionInput } from '@/ui/mention';
import { MentionTwoLevelMenu } from '@/components/mentions/mention-two-level-menu';
import { useMentionCategories } from '@/components/mentions/mention-registry';
import { usePromptShortcutMentionSource } from '@/components/mentions/mention-prompt-shortcut-source';

const entry: PromptShortcutIndexEntry = {
  v: 1,
  id: 'review',
  workspaceId: 'workspace',
  ownerUserId: 'author',
  visibility: 'private',
  name: 'Review',
  slug: 'review',
  description: 'Review a change against the team checklist',
  scope: {},
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
  bodyDocId: 'body',
  dependencySummary: [],
};
function Harness({
  initialText = '/',
  dependency,
}: {
  initialText?: string;
  dependency?: ShortcutAvailability;
}) {
  const [text, setText] = useState(initialText);
  const input = useMemo(
    () => ({
      entries: [
        {
          ...entry,
          dependencySummary: dependency
            ? [{ kind: 'agent_role' as const, agentRoleId: 'role' }]
            : [],
        },
        { ...entry, id: 'shared', visibility: 'workspace' as const, ownerUserId: 'teammate' },
      ],
      context: { workspaceId: 'workspace', userId: 'author', scope: {} },
      resolveDependency: () => dependency ?? { kind: 'available' as const },
      ownerLabel: (id: string) => (id === 'author' ? 'Alex' : 'Robin'),
    }),
    [dependency]
  );
  const shortcut = usePromptShortcutMentionSource(input);
  const categories = useMentionCategories({
    promptShortcut: shortcut,
    command: {
      enabled: true,
      commands: [{ name: 'review', description: 'Review with the agent' }],
    },
  });
  return (
    <Mention
      open
      trigger="/"
      triggers={['/']}
      inputValue={text}
      onInputValueChange={setText}
      onFilter={(items) => items}
      autoCloseOnEmpty={false}
    >
      <MentionInput
        value={text}
        aria-label="Prompt"
        autoFocus
        onFocus={(event) => event.currentTarget.setSelectionRange(text.length, text.length)}
      />
      <MentionTwoLevelMenu categories={categories} />
    </Mention>
  );
}
const meta = { title: 'Chat/Prompt Shortcut Slash Menu', component: Harness } satisfies Meta<
  typeof Harness
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SameNameCommands: Story = {};
export const Offline: Story = {
  args: { initialText: '/review', dependency: { kind: 'unavailable', reason: 'machine_offline' } },
};
export const CannotVerify: Story = {
  args: {
    initialText: '/review',
    dependency: { kind: 'unknown', reason: 'dependencies_unverified' },
  },
};
export const Checking: Story = {
  args: { initialText: '/review', dependency: { kind: 'unknown', reason: 'dependencies_loading' } },
};
