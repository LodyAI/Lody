import type { Meta, StoryObj } from '@storybook/react';
import type { PromptShortcut } from '@lody/shared/prompt-shortcuts';
import { PromptShortcutForm } from '@/components/settings/prompt-shortcut-form';
import { ShortcutPromptField } from '@/components/settings/prompt-shortcuts-setting';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/ui/dialog';
import { SettingsStoryProviders } from './settings-story-shell';

/**
 * Settings → Prompt Shortcuts → editor.
 *
 * Framed exactly as the settings dialog frames it — header, scrolling body,
 * footer — so a screenshot here is what ships rather than a form floating on a
 * card.
 */
const base: PromptShortcut = {
  v: 1,
  id: 'example',
  workspaceId: 'workspace',
  ownerUserId: 'user',
  visibility: 'private',
  name: 'Review changes',
  emoji: '🔍',
  slug: 'review-changes',
  description: 'Review a change against its requirements.',
  prompt:
    'Review !{topic}.\n\nFocus on correctness, security and missing tests.\nReport concrete findings with file references.',
  scope: {},
  mentions: [],
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
};

const meta = {
  title: 'Settings/Prompt Shortcuts/Editor',
  component: PromptShortcutForm,
  parameters: { layout: 'centered' },
  decorators: [
    (Story, context) => {
      const inDialog = context.parameters.shortcutDialog === true;
      const Title = inDialog ? DialogTitle : 'h2';
      const Description = inDialog ? DialogDescription : 'p';
      const content = (
        <>
          <header className="shrink-0 border-b border-border/60 px-5 py-3 pr-12">
            <Title className="text-sm font-semibold">Edit Prompt Shortcut</Title>
            <Description className="mt-0.5 text-xs leading-snug text-muted-foreground">
              Saved to this workspace and sent as one message.
            </Description>
          </header>
          <Story />
        </>
      );
      return inDialog ? (
        <SettingsStoryProviders>
          <Dialog open>
            <DialogContent
              noAnimation
              className="flex max-h-[min(680px,88dvh)] w-[min(620px,96dvw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none sm:p-0"
            >
              {content}
            </DialogContent>
          </Dialog>
        </SettingsStoryProviders>
      ) : (
        <div className="flex max-h-[min(680px,88dvh)] w-[min(620px,96dvw)] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg">
          {content}
        </div>
      );
    },
  ],
  args: {
    initial: base,
    className: 'min-h-0 flex-1',
    options: {
      projects: [
        { value: { kind: 'github', repository: 'example/project' }, label: 'example/project' },
        {
          value: { kind: 'local', id: 'local-1', machineId: 'laptop' },
          label: 'lody · Development laptop',
        },
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

/** The default a new Shortcut starts from: private, no scope. */
export const NewShortcut: Story = {
  parameters: { shortcutDialog: true },
  args: {
    renderPrompt: (editor) => <ShortcutPromptField editor={editor} disabled={false} />,
    isNew: true,
    initial: { ...base, name: '', slug: '', description: undefined, prompt: '' },
  },
};

export const Private: Story = {};

export const SharedWithScope: Story = {
  args: {
    initial: {
      ...base,
      visibility: 'workspace',
      scope: {
        project: { kind: 'github', repository: 'example/project' },
        providerKey: 'builtin:codex',
      },
    },
  },
};

/** A reference the declared scope cannot satisfy: named, and Save is blocked. */
export const OutOfScopeMention: Story = {
  args: {
    initial: {
      ...base,
      prompt: 'Review @src/app.ts',
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

/** Local-only platform: no cloud sharing, and Machine is a single toggle. */
export const LocalOnly: Story = { args: { canShare: false, allowMachineSelection: false } };

export const Saving: Story = { args: { saving: true } };

/**
 * The real prompt field — the composer's mention textarea in template mode —
 * rather than the plain fallback textarea the other stories render.
 */
export const RealPromptField: Story = {
  // The mention textarea reads the platform for its candidate sources.
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
  args: {
    renderPrompt: (editor) => <ShortcutPromptField editor={editor} disabled={false} />,
    initial: {
      ...base,
      prompt: 'Review !{topic} in @src/app.ts before merging.',
    },
  },
};

export const NewShortcutMobile: Story = {
  args: NewShortcut.args,
  parameters: { shortcutDialog: true, viewport: { defaultViewport: 'mobile1' } },
};
