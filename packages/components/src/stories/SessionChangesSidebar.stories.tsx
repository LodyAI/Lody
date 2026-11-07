import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { SessionChangesSidebar } from '@/components/sessions/session-changes-sidebar';
import type { SessionDiffChangeEntry } from '@/components/sessions/session-diff-summary';
const storyLayout = stylex.create({
  frame: {
    height: '560px',
    width: '340px',
    overflow: 'hidden',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'hsl(var(--border) / 1)',
    backgroundColor: 'hsl(var(--background) / 1)',
  },
});

const changeEntries: SessionDiffChangeEntry[] = [
  { filePath: 'packages/components/src/components/sessions/session-detail.tsx', add: 113, del: 29 },
  {
    filePath: 'packages/components/src/components/sessions/session-changes-sidebar.tsx',
    add: 274,
    del: 132,
  },
  { filePath: 'packages/components/src/lib/file-change-category.ts', add: 263, del: 0 },
  { filePath: 'packages/components/src/components/tree-view.tsx', add: 4, del: 1 },
  { filePath: 'packages/components/tests/file-change-category.test.ts', add: 58, del: 0 },
  { filePath: 'docs/session-changes.md', add: 18, del: 4 },
  { filePath: 'README.md', add: 6, del: 2 },
  { filePath: 'pnpm-lock.yaml', add: 42, del: 38 },
  { filePath: '.env.example', add: 3, del: 1 },
];

const meta = {
  title: 'Sessions/SessionChangesSidebar',
  component: SessionChangesSidebar,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  args: {
    ready: true,
    synced: true,
    changeEntries,
    changeFilePaths: changeEntries.map((entry) => entry.filePath),
    onOpenChangesDiff: () => undefined,
  },
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionChangesSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Types: Story = {};

const codeOnlyChangeEntries: SessionDiffChangeEntry[] = [
  { filePath: 'packages/components/src/components/sessions/session-detail.tsx', add: 12, del: 4 },
  { filePath: 'apps/cli/src/lib/message-handler.ts', add: 88, del: 16 },
];

export const TypesCodeOnly: Story = {
  args: {
    changeEntries: codeOnlyChangeEntries,
    changeFilePaths: codeOnlyChangeEntries.map((entry) => entry.filePath),
  },
};

export const Files: Story = {
  args: {
    initialViewMode: 'files',
  },
};

export const Empty: Story = {
  args: {
    changeEntries: [],
    changeFilePaths: [],
  },
};

export const Loading: Story = {
  args: {
    ready: false,
  },
};

export const Syncing: Story = {
  args: {
    synced: false,
  },
};

const heavyChangeEntries: SessionDiffChangeEntry[] = [
  ...changeEntries,
  { filePath: 'apps/web/src/routes/index.tsx', add: 12, del: 3 },
  { filePath: 'apps/web/src/routes/$workspaceName/_auth/chat.tsx', add: 240, del: 41 },
  { filePath: 'apps/cli/src/lib/message-handler.ts', add: 88, del: 16 },
  { filePath: 'apps/cli/src/lib/replay-prompt-builder.test.ts', add: 134, del: 12 },
  { filePath: 'packages/shared/src/replay-prompt-builder.ts', add: 64, del: 8 },
  { filePath: 'packages/shared/src/schema.ts', add: 18, del: 2 },
  { filePath: 'docs/architecture.md', add: 22, del: 6 },
  { filePath: 'docs/onboarding.md', add: 8, del: 0 },
  { filePath: 'CHANGELOG.md', add: 6, del: 0 },
  { filePath: 'tsconfig.json', add: 1, del: 1 },
  { filePath: '.github/workflows/ci.yml', add: 14, del: 4 },
];

export const TypesMany: Story = {
  args: {
    changeEntries: heavyChangeEntries,
    changeFilePaths: heavyChangeEntries.map((entry) => entry.filePath),
  },
};

export const FilesMany: Story = {
  args: {
    initialViewMode: 'files',
    changeEntries: heavyChangeEntries,
    changeFilePaths: heavyChangeEntries.map((entry) => entry.filePath),
  },
};
