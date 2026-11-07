import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent } from 'storybook/test';
import type { PromptShortcut } from '@lody/shared/prompt-shortcuts/model';
import { PromptShortcutForm } from '@/components/settings/prompt-shortcut-form';

const formFrameStyles = stylex.create({
  frame: {
    width: '520px',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
    boxShadow:
      '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 10px 15px -3px rgb(0 0 0 / .1), 0 4px 6px -4px rgb(0 0 0 / .1)',
  },
});

const shortcut: PromptShortcut = {
  v: 1,
  id: 'shortcut-review',
  workspaceId: 'workspace-story',
  ownerUserId: 'user-story',
  visibility: 'private',
  name: 'Review PR',
  emoji: '🔍',
  slug: 'review-pr',
  description: 'Review the current diff as a pull request.',
  prompt: 'Review the current diff. Report correctness issues first, then style.',
  mentions: [],
  scope: {},
  revision: 'rev-1',
  createdAt: 0,
  updatedAt: 0,
};

const meta = {
  title: 'Settings/PromptShortcutForm',
  component: PromptShortcutForm,
  parameters: { layout: 'centered' },
  args: {
    initial: shortcut,
    options: { projects: [], machines: [], providers: [] },
    canShare: true,
    saving: false,
    onSave: fn(async () => {}),
    onCancel: fn(),
  },
  decorators: [
    (Story) => (
      <div {...stylex.props(formFrameStyles.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PromptShortcutForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NewShortcut: Story = {
  args: {
    isNew: true,
    initial: { ...shortcut, name: '', slug: '', description: undefined, prompt: '' },
  },
};

/**
 * A command mid-edit is kept as typed (`a-` on the way to `a-b` no longer loses
 * its `-`), and one that does not match keeps the warning floating above the
 * field instead of being reset.
 */
export const InvalidCommandWarning: Story = {
  play: async ({ canvasElement }) => {
    const command = canvasElement.querySelector<HTMLInputElement>('#shortcut-slug');
    if (!command) throw new Error('shortcut command field missing');
    await userEvent.clear(command);
    await userEvent.type(command, 'a b');
  },
};
