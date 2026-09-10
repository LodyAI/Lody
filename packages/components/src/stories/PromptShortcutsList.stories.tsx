import type { Meta, StoryObj } from '@storybook/react';
import {
  projectShortcutIndex,
  type PromptShortcut,
  type PromptShortcutIndexEntry,
} from '@lody/shared/prompt-shortcuts';
import {
  PromptShortcutsList,
  PromptShortcutReadOnlyView,
} from '@/components/settings/prompt-shortcuts-setting';
import type { ShortcutScopeOptions } from '@/components/settings/prompt-shortcut-form';

const options: ShortcutScopeOptions = {
  projects: [
    { value: { kind: 'github', repository: 'loro-dev/lody' }, label: 'loro-dev/lody' },
    { value: { kind: 'local', id: 'local-1', machineId: 'laptop' }, label: 'lody · Mac mini' },
  ],
  machines: [{ value: 'laptop', label: 'Mac mini' }],
  providers: [{ value: 'builtin:codex', label: 'Codex' }],
};

const shortcut = (patch: Partial<PromptShortcut>): PromptShortcut => ({
  v: 1,
  id: patch.id ?? 'shortcut',
  workspaceId: 'workspace',
  ownerUserId: 'me',
  visibility: 'private',
  name: 'Review pull request',
  slug: 'review-pr',
  prompt: 'Review the pull request against our conventions.',
  scope: {},
  mentions: [],
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const entry = (patch: Partial<PromptShortcut>): PromptShortcutIndexEntry =>
  projectShortcutIndex(shortcut(patch), `body-${patch.id ?? 'shortcut'}`);

const entries: PromptShortcutIndexEntry[] = [
  entry({
    id: 'review-pr',
    emoji: '🔍',
    description: 'Review a pull request with the team conventions.',
    prompt: 'Review !{pr_url} focusing on !{focus}.',
  }),
  entry({
    id: 'ship-notes',
    name: 'Release notes',
    emoji: '🚀',
    slug: 'release-notes',
    visibility: 'workspace',
    description: 'Draft release notes from the merged pull requests.',
    scope: { project: { kind: 'github', repository: 'loro-dev/lody' } },
  }),
  entry({
    id: 'bench',
    name: 'Run benchmarks',
    slug: 'bench',
    scope: {
      project: { kind: 'local', id: 'local-1', machineId: 'laptop' },
      machineId: 'laptop',
      providerKey: 'builtin:codex',
    },
    prompt: 'Benchmark !{target} and compare with main.',
  }),
  // Saved with a file in one project, then the scope was moved to another: the
  // row says so instead of failing at call time.
  entry({
    id: 'stale',
    name: 'Audit auth flow',
    slug: 'audit-auth',
    scope: { project: { kind: 'github', repository: 'loro-dev/lody' } },
    prompt: 'Audit @src/auth.ts',
    mentions: [
      {
        start: 6,
        end: 18,
        label: '@src/auth.ts',
        target: {
          kind: 'file',
          path: 'src/auth.ts',
          project: { kind: 'github', repository: 'other/repo' },
        },
      },
    ],
  }),
  entry({
    id: 'shared-by-others',
    name: 'Team incident review',
    slug: 'incident',
    emoji: '🚨',
    ownerUserId: 'someone-else',
    visibility: 'workspace',
    description: 'Shared by a teammate — read-only for everyone else.',
  }),
];

const meta = {
  title: 'Settings/Prompt Shortcuts/List',
  component: PromptShortcutsList,
  parameters: { layout: 'padded' },
  args: {
    entries,
    options,
    currentUserId: 'me',
    loading: false,
    busy: false,
    canCreate: true,
    onCreate: () => {},
    onOpen: () => {},
    onDelete: () => {},
  },
} satisfies Meta<typeof PromptShortcutsList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Catalog: Story = {};

export const Empty: Story = { args: { entries: [] } };

export const Loading: Story = { args: { entries: [], loading: true } };

export const ReadOnlyShared: StoryObj<typeof PromptShortcutReadOnlyView> = {
  render: () => (
    <div className="mx-auto flex max-h-[min(680px,88dvh)] w-[min(620px,96dvw)] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg">
      <header className="shrink-0 border-b border-border/60 px-5 py-3 pr-12">
        <h2 className="text-sm font-semibold">Prompt Shortcut</h2>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
          Shared by another member. Only its author can change it.
        </p>
      </header>
      <PromptShortcutReadOnlyView
        className="min-h-0 flex-1"
        options={options}
        onClose={() => {}}
        shortcut={shortcut({
          id: 'shared-by-others',
          name: 'Team incident review',
          slug: 'incident',
          ownerUserId: 'someone-else',
          visibility: 'workspace',
          description: 'Shared by a teammate — read-only for everyone else.',
          scope: { project: { kind: 'github', repository: 'loro-dev/lody' } },
          prompt:
            'Write an incident review for !{incident}.\n\nCover impact, root cause, and the follow-up actions we agreed on.',
        })}
      />
    </div>
  ),
};
