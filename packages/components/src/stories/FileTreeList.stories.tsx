import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { FileTreeProviderView } from '@/components/sessions/components/file-tree-view';
import { createFakeSessionFileProvider } from '@/lib/session-file-provider';

// Renders the REAL session "Files" surface. `FileTreeProviderView` owns the
// ScrollArea, the flat virtualized row list, and the row height / indent, so this
// story exercises production rows rather than re-composing them here.
const folderPaths = [
  '.changeset',
  '.cursor',
  '.devcontainer',
  '.github',
  '.vscode',
  'crates',
  'docs',
  'examples',
  'moon',
  'packages',
  'plans',
  'scripts',
  'skills',
  'sponsorkit',
  'supply-chain',
];

const rootFiles = [
  '.editorconfig',
  '.gitignore',
  'AGENTS.md',
  'Cargo.lock',
  'Cargo.toml',
  'cliff.toml',
  'CONTRIBUTING.md',
  'deno.lock',
  'deny.toml',
  'LICENSE',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'README.md',
  'rust-toolchain',
  'sponsorkit.config.js',
];

// One nested file per folder so each directory is a real expandable node, which
// is how the provider file index actually reports directories.
const repoRootPaths = [...folderPaths.map((folder) => `${folder}/README.md`), ...rootFiles];

// Well past the virtualization threshold, so this story covers the windowed row
// path that large repositories hit.
const largeRepoPaths = Array.from(
  { length: 600 },
  (_, index) => `packages/app/src/module-${String(index).padStart(3, '0')}.ts`
);

function FileTreeStory({
  paths,
  isLocalMachine,
}: {
  readonly paths: readonly string[];
  /**
   * True renders the LOCAL row menu (open in an editor + reveal in the file
   * manager); false renders the remote one (download). Both keep the mention
   * and copy-path entries. Right-click any row.
   */
  readonly isLocalMachine?: boolean;
}) {
  const provider = useMemo(
    () =>
      createFakeSessionFileProvider({
        sourceState: 'live-collaborative',
        files: paths.map((path) => ({
          path,
          kind: 'text' as const,
          sourceState: 'live-collaborative' as const,
        })),
      }),
    [paths]
  );
  const rowMenu = useMemo(
    () => ({
      provider,
      workspaceRootPath: '/Users/me/project',
      isLocalMachine: isLocalMachine ?? false,
      onMentionFile: () => true,
    }),
    [isLocalMachine, provider]
  );

  return (
    <FileTreeProviderView
      fileProvider={provider}
      fileProviderPending={false}
      handleOpenFile={fn()}
      rowMenu={rowMenu}
    />
  );
}

const meta = {
  title: 'Sessions/FileTreeList',
  component: FileTreeStory,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[320px] border border-border bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FileTreeStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RepoRoot: Story = {
  args: { paths: repoRootPaths },
};

// Scroll this one: only a viewport-sized window of rows is ever mounted.
export const LargeVirtualizedTree: Story = {
  args: { paths: largeRepoPaths },
};

// Right-click a row: a workspace on another machine can only be downloaded.
export const RemoteRowMenu: Story = {
  args: { paths: repoRootPaths },
};

// The same tree whose files are on THIS machine — download would write a second
// copy of a file the user already has, so the row reveals it instead.
export const LocalRowMenu: Story = {
  args: { paths: repoRootPaths, isLocalMachine: true },
};
