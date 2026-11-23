import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent } from 'storybook/test';
import type { PromptShortcut } from '@lody/shared/prompt-shortcuts/model';
import { PromptShortcutForm } from '@/components/settings/prompt-shortcut-form';
import { SettingsEditorDialogFrame } from './settings-editor-dialog-frame';


const shortcut: PromptShortcut = {
  v: 1,
  id: 'shortcut-review',
  workspaceId: 'workspace-story',
  ownerUserId: 'user-story',
  name: 'Review PR',
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
  parameters: { layout: 'fullscreen' },
  args: {
    initial: shortcut,
    options: {
      projects: [{ value: { kind: 'github', repository: 'lodyai/lody' }, label: 'lodyai/lody' }],
      machines: [
        { value: 'machine-studio', label: 'Studio' },
        { value: 'machine-build', label: 'Build box' },
      ],
      providers: [
        { value: 'codex:codex', label: 'Codex' },
        { value: 'claude:claude', label: 'Claude Code' },
      ],
    },
    saving: false,
    onSave: fn(async () => {}),
    onCancel: fn(),
  },
  decorators: [
    (Story, { args }) => (
      <SettingsEditorDialogFrame
        title={args.isNew ? 'New Prompt' : 'Edit Prompt'}
        description="Saved to this workspace and sent as one message."
      >

        <Story />
      </SettingsEditorDialogFrame>
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

/** Narrowed to one repository and one agent; the machine stays open. */
export const Scoped: Story = {
  args: {
    initial: {
      ...shortcut,
      scope: { project: { kind: 'github', repository: 'lodyai/lody' }, providerKey: 'codex:codex' },
    },
  },
};

/** A local-only host has one machine, so that axis is a switch. */
export const LocalOnlyMachine: Story = {
  args: {
    allowMachineSelection: false,
    options: { projects: [], machines: [{ value: 'machine-local', label: 'This Mac' }], providers: [] },
  },
};

/** Creating without a name says so beside the field, in the form's own voice. */
export const NameRequired: Story = {
  args: NewShortcut.args,
  play: async ({ canvasElement }) => {
    const create = canvasElement.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!create) throw new Error('create button missing');
    await userEvent.click(create);
  },
};
