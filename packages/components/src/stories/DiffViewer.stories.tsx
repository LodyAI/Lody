import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { parseDiffFromFile } from '@pierre/diffs';
import { DiffViewer } from '@/ui/diff-viewer/diff-viewer';

const meta = {
  title: 'UI/DiffViewer',
  component: DiffViewer,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  argTypes: {
    diffStyle: {
      control: { type: 'radio' },
      options: ['unified', 'split'],
    },
    showHeader: {
      control: { type: 'boolean' },
    },
  },
  decorators: [
    (Story) => (
      <div className="scrollbar-pro h-screen overflow-auto">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiffViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

const oldText = `import { useMemo } from 'react';
import type { Project } from '../types';

const STATUS_LABELS = {
  active: 'Running',
  paused: 'Paused',
  error: 'Failed',
};

export function ProjectList({ projects }: { projects: Project[] }) {
  const visible = useMemo(() => {
    return projects.filter((project) => !project.archived);
  }, [projects]);

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Projects</h2>
        <span className="text-xs text-muted-foreground">
          {visible.length} total
        </span>
      </header>
      <ul className="divide-y divide-border/70">
        {visible.map((project) => (
          <li key={project.id} className="flex items-center justify-between py-3">
            <div className="space-y-1">
              <div className="text-sm font-medium">{project.name}</div>
              <div className="text-xs text-muted-foreground">
                {STATUS_LABELS[project.status] ?? 'Unknown'}
              </div>
            </div>
            <button className="text-xs text-primary hover:underline">Open</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
`;

const newText = `import { useMemo } from 'react';
import type { Project } from '../types';
import { cn } from '../lib/cn';

const STATUS_LABELS = {
  active: 'Running',
  paused: 'Idle',
  error: 'Needs attention',
};

const getStatusLabel = (state: Project['state']) => STATUS_LABELS[state] ?? 'Unknown';

export function ProjectList({
  projects,
  showCount = true,
}: {
  projects: Project[];
  showCount?: boolean;
}) {
  const visible = useMemo(
    () => projects.filter((project) => !project.archived),
    [projects]
  );

  if (visible.length === 0) {
    return (
      <section className="rounded-lg border border-dashed border-border/60 p-6 text-sm text-muted-foreground">
        No projects yet. Create your first workspace.
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Projects</h2>
        {showCount ? (
          <span className="text-xs text-muted-foreground">
            {visible.length} total
          </span>
        ) : null}
      </header>
      <ul className="divide-y divide-border/70">
        {visible.map((project) => (
          <li
            key={project.id}
            className={cn(
              'flex items-center justify-between py-3',
              project.state === 'error' ? 'bg-amber-50/40' : ''
            )}
          >
            <div className="space-y-1">
              <div className="text-sm font-medium">{project.name}</div>
              <div className="text-xs text-muted-foreground">
                {getStatusLabel(project.state)}
              </div>
            </div>
            <button className="text-xs text-primary hover:underline">View</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
`;

export const ComplexExample: Story = {
  args: {
    path: 'apps/web/src/components/ProjectList.tsx',
    oldText,
    newText,
  },
  render: (args) => (
    <div className="scrollbar-pro mx-auto max-w-5xl p-6 overflow-auto">
      <DiffViewer {...args} />
    </div>
  ),
};

export const WithFileHeaderActions: Story = {
  args: {
    path: 'docs/acp-session-fork-worktree.md',
    oldText,
    newText,
    onOpenFile: fn(),
  },
  render: (args) => (
    <div className="scrollbar-pro mx-auto max-w-5xl p-6 overflow-auto">
      <DiffViewer {...args} />
    </div>
  ),
};

export const SplitView: Story = {
  args: {
    path: 'apps/web/src/components/ProjectList.tsx',
    oldText,
    newText,
    diffStyle: 'split',
  },
  render: (args) => (
    <div className="scrollbar-pro mx-auto max-w-5xl p-6 overflow-auto">
      <DiffViewer {...args} />
    </div>
  ),
};

export const WithoutHeader: Story = {
  args: {
    path: 'apps/web/src/components/ProjectList.tsx',
    oldText,
    newText,
    showHeader: false,
  },
  render: (args) => (
    <div className="scrollbar-pro mx-auto max-w-5xl p-6 overflow-auto">
      <DiffViewer {...args} />
    </div>
  ),
};

const makeBlock = (label: string, lines: number) =>
  Array.from({ length: lines }, (_, i) => `${label} ${String(i + 1).padStart(3, '0')}`).join('\n');

const sparseOldText = [
  'export const config = {',
  `  version: '1.0.0',`,
  `  mode: 'dev',`,
  `  flags: {`,
  makeBlock('// unchanged', 80),
  `  },`,
  `  endpoints: {`,
  `    api: 'https://example.com',`,
  `  },`,
  makeBlock('// unchanged', 80),
  `};`,
].join('\n');

const sparseNewText = [
  'export const config = {',
  `  version: '1.1.0',`,
  `  mode: 'prod',`,
  `  flags: {`,
  makeBlock('// unchanged', 80),
  `  },`,
  `  endpoints: {`,
  `    api: 'https://api.example.com',`,
  `    cdn: 'https://cdn.example.com',`,
  `  },`,
  makeBlock('// unchanged', 80),
  `};`,
].join('\n');

export const SparseChanges: Story = {
  args: {
    path: 'packages/shared/src/config.ts',
    oldText: sparseOldText,
    newText: sparseNewText,
  },
  render: (args) => (
    <div className="scrollbar-pro mx-auto max-w-5xl p-6 overflow-auto">
      <DiffViewer {...args} />
    </div>
  ),
};

export const SparseChangesSplit: Story = {
  args: {
    path: 'packages/shared/src/config.ts',
    oldText: sparseOldText,
    newText: sparseNewText,
    diffStyle: 'split',
  },
  render: (args) => (
    <div className="scrollbar-pro mx-auto max-w-5xl p-6 overflow-auto">
      <DiffViewer {...args} />
    </div>
  ),
};

const newFileText = `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export function farewell(name: string): string {
  return \`Goodbye, \${name}!\`;
}
`;

export const NewFile: Story = {
  args: {
    path: 'src/utils/greeting.ts',
    oldText: '',
    newText: newFileText,
  },
  render: (args) => (
    <div className="scrollbar-pro mx-auto max-w-5xl p-6 overflow-auto">
      <DiffViewer {...args} />
    </div>
  ),
};

export const DeletedFile: Story = {
  args: {
    path: 'src/utils/deprecated.ts',
    oldText: newFileText,
    newText: '',
  },
  render: (args) => (
    <div className="scrollbar-pro mx-auto max-w-5xl p-6 overflow-auto">
      <DiffViewer {...args} />
    </div>
  ),
};

const largeContext = Array.from(
  { length: 2_400 },
  (_, index) => `export const generated_${index} = ${index};\n`
).join('');
const largePreparsedDiff = parseDiffFromFile(
  { name: 'src/generated/large-snapshot.ts', contents: `${largeContext}export const mode = "old";\n` },
  { name: 'src/generated/large-snapshot.ts', contents: `${largeContext}export const mode = "new";\n` }
);

export const ProviderSidePreparsedLargeDiff: Story = {
  args: {
    path: 'src/generated/large-snapshot.ts',
    oldText: '',
    newText: '',
    preparsedDiff: largePreparsedDiff,
    preparsedOldTextLength: 640 * 1024,
    preparsedNewTextLength: 640 * 1024,
    commentsEnabled: true,
  },
  render: (args) => (
    <div className="scrollbar-pro mx-auto max-w-5xl p-6 overflow-auto">
      <DiffViewer {...args} />
    </div>
  ),
};

// --- Multi-file diff list story ---

const multiFileDiffs = [
  {
    path: 'apps/web/src/components/ProjectList.tsx',
    oldText,
    newText,
  },
  {
    path: 'packages/shared/src/config.ts',
    oldText: sparseOldText,
    newText: sparseNewText,
  },
  {
    path: 'src/utils/greeting.ts',
    oldText: '',
    newText: newFileText,
  },
  {
    path: 'src/utils/deprecated.ts',
    oldText: newFileText,
    newText: '',
  },
];

function MultiFileDiffListComponent() {
  const [diffStyle, setDiffStyle] = React.useState<'unified' | 'split'>('unified');
  const [useCustomHeader, setUseCustomHeader] = React.useState(false);

  const renderCustomHeader = ({
    fileName,
    path,
    additions,
    deletions,
    CollapseToggle,
  }: {
    fileName: string;
    path: string;
    additions: number;
    deletions: number;
    CollapseToggle: React.FC<{ className?: string }>;
  }) => (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b bg-muted/30">
      <CollapseToggle />
      <span className="truncate text-sm font-medium text-foreground">{fileName}</span>
      <span className="text-xs text-muted-foreground truncate hidden sm:inline ml-2">{path}</span>
      {additions > 0 && (
        <span className="ml-auto shrink-0 rounded-sm bg-green-500/20 px-1.5 py-0.5 text-xs text-green-600">
          +{additions}
        </span>
      )}
      {deletions > 0 && (
        <span
          className={`shrink-0 rounded-sm bg-red-500/20 px-1.5 py-0.5 text-xs text-red-600 ${additions > 0 ? 'ml-1' : 'ml-auto'}`}
        >
          -{deletions}
        </span>
      )}
    </div>
  );

  return (
    <div className="scrollbar-pro h-full overflow-auto">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 p-3 backdrop-blur-xs">
        <span className="text-sm font-medium">Diff Style:</span>
        <button
          type="button"
          onClick={() => setDiffStyle('unified')}
          className={`rounded-md px-3 py-1 text-sm ${
            diffStyle === 'unified'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
        >
          Stack
        </button>
        <button
          type="button"
          onClick={() => setDiffStyle('split')}
          className={`rounded-md px-3 py-1 text-sm ${
            diffStyle === 'split'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
        >
          Split
        </button>
        <div className="mx-2 h-4 w-px bg-border" />
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={useCustomHeader}
            onChange={(e) => setUseCustomHeader(e.target.checked)}
            className="h-4 w-4"
          />
          Custom Header
        </label>
        <span className="ml-auto text-xs text-muted-foreground">
          {multiFileDiffs.length} files changed
        </span>
      </div>
      <div className="space-y-4 p-3">
        {multiFileDiffs.map((file) => (
          <DiffViewer
            key={file.path}
            path={file.path}
            oldText={file.oldText}
            newText={file.newText}
            diffStyle={diffStyle}
            renderHeader={useCustomHeader ? renderCustomHeader : undefined}
          />
        ))}
      </div>
    </div>
  );
}

export const MultiFileDiffList: Story = {
  args: {
    path: '',
    oldText: '',
    newText: '',
  },
  render: () => <MultiFileDiffListComponent />,
};
