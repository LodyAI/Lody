import * as stylex from '@stylexjs/stylex';
import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { FileTreeProviderView } from '@/components/sessions/components/file-tree-view';
import { createFakeSessionFileProvider } from '@/lib/session-file-provider';
const storyLayout = stylex.create({
  frame: {
    height: '640px',
    width: '320px',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border) / 1)',
    'background-color': 'hsl(var(--background) / 1)',
  },
});

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

function FileTreeStory({ paths }: { readonly paths: readonly string[] }) {
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

  return (
    <FileTreeProviderView
      fileProvider={provider}
      fileProviderPending={false}
      handleOpenFile={fn()}
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
      <div {...stylex.props(storyLayout.frame)}>
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
