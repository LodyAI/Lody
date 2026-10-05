import type { Meta, StoryObj } from '@storybook/react';
import { MessageAuthorIdentity } from '@/components/ai-gui/message-author-identity';

const meta = {
  title: 'Sessions/MessageAuthorIdentity',
  component: MessageAuthorIdentity,
  args: {
    compact: true,
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
export const Avatar: Story = { args: { ...Role.args, compact: false } };
export const DeletedRoleSnapshot: Story = {
  args: {
    author: {
      ...meta.args.author,
      role: { id: 'deleted-role', revision: 3, name: 'Historical reviewer', emoji: '🧭' },
    },
  },
};
