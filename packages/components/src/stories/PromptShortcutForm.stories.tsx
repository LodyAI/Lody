import type { Meta, StoryObj } from '@storybook/react';
import { PromptShortcutForm } from '@/components/settings/prompt-shortcut-form';

const meta = {
  title: 'Settings/Prompt Shortcuts/Editor',
  component: PromptShortcutForm,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="max-h-[calc(100dvh-32px)] w-[min(640px,calc(100vw-32px))] overflow-y-auto rounded-lg border bg-background p-5">
        <Story />
      </div>
    ),
  ],
  args: {
    initial: {
      v: 1,
      id: 'example',
      workspaceId: 'workspace',
      ownerUserId: 'user',
      visibility: 'private',
      name: 'Review changes',
      slug: 'review',
      description: 'Review a change against its requirements.',
      prompt:
        'Review !{topic}.\n\nFocus on correctness, security and missing tests.\nReport concrete findings with file references.',
      scope: {},
      mentions: [],
      variables: [{ name: 'topic' }],
      revision: 'r1',
      createdAt: 1,
      updatedAt: 1,
    },
    options: {
      projects: [
        { value: { kind: 'github', repository: 'example/project' }, label: 'example/project' },
      ],
      machines: [{ value: 'laptop', label: 'Development laptop' }],
      providers: [{ value: 'builtin:codex', label: 'Codex' }],
    },
    canShare: true,
    saving: false,
    onSave: async () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof PromptShortcutForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Private: Story = {};
export const SharedWithScope: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      visibility: 'workspace',
      scope: {
        project: { kind: 'github', repository: 'example/project' },
        providerKey: 'builtin:codex',
      },
    },
  },
};
export const LocalOnly: Story = { args: { canShare: false, allowMachineSelection: false } };
export const Saving: Story = { args: { saving: true } };
export const InvalidMentionScope: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      prompt: 'Review @src/app.ts',
      variables: [],
      mentions: [
        {
          start: 7,
          end: 18,
          label: '@src/app.ts',
          target: {
            kind: 'file',
            path: 'src/app.ts',
            project: { kind: 'github', repository: 'example/project' },
          },
        },
      ],
    },
  },
};
