import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { parseDiffFromFile } from '@pierre/diffs';
import { DiffViewer } from '@/ui/diff-viewer/diff-viewer';
const storyLayoutStyles = stylex.create({
  row: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'background-color': 'color-mix(in oklab, hsl(var(--muted) / 1) 30%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
  },
  label: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--foreground) / 1)',
  },
  canvas: {
    'margin-left': 'auto',
    'flex-shrink': '0',
    'border-radius': 'var(--radius-sm)',
    'background-color': 'color-mix(in oklab, var(--color-green-500) 20%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-block': 'calc(var(--spacing) * 0.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'var(--color-green-600)',
  },
  label2: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  row2: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
  },
  label3: {
    'margin-left': 'auto',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  frame: {
    height: '100vh',
    overflow: 'auto',
  },
  canvas: {
    'margin-inline': 'auto',
    'max-width': '64rem',
    overflow: 'auto',
    padding: 'calc(var(--spacing) * 6)',
  },
  frame2: {
    height: '100%',
    overflow: 'auto',
  },
  frame3: {
    'margin-inline': 'calc(var(--spacing) * 2)',
    height: 'calc(var(--spacing) * 4)',
    width: '1px',
    'background-color': 'hsl(var(--border) / 1)',
  },
  frame4: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
});


const multiFileStyles = stylex.create({
  filePath: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: { default: 'none', '@media (width >= 40rem)': 'inline' },
    marginLeft: 'calc(var(--spacing) * 2)',
  },
  deletions: {
    flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    backgroundColor: 'color-mix(in oklab, var(--color-red-500) 20%, transparent)',
    paddingInline: 'calc(var(--spacing) * 1.5)',
    paddingBlock: 'calc(var(--spacing) * 0.5)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'var(--color-red-600)',
  },
  adjacentCount: { marginLeft: 'calc(var(--spacing) * 1)' },
  trailingCount: { marginLeft: 'auto' },
  toolbar: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    backgroundColor: 'color-mix(in oklab, hsl(var(--background) / 1) 95%, transparent)',
    padding: 'calc(var(--spacing) * 3)',
    backdropFilter: 'blur(var(--blur-xs))',
  },
  styleChoice: {
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  selectedChoice: {
    backgroundColor: 'hsl(var(--primary) / 1)',
    color: 'hsl(var(--primary-foreground) / 1)',
  },
  idleChoice: {
    backgroundColor: {
      default: 'hsl(var(--muted) / 1)',
      '@media (hover: hover)': {
        ':hover': 'color-mix(in oklab, hsl(var(--muted) / 1) 80%, transparent)',
      },
    },
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  fileList: {
    padding: 'calc(var(--spacing) * 3)',
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 4)',
    },
  },
});

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
      <div className={clsx(stylex.props(storyLayout.frame).className, 'scrollbar-pro')}>
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
    <div className={clsx(stylex.props(storyLayout.canvas).className, 'scrollbar-pro')}>
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
    <div className={clsx(stylex.props(storyLayout.canvas).className, 'scrollbar-pro')}>
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
    <div className={clsx(stylex.props(storyLayout.canvas).className, 'scrollbar-pro')}>
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
    <div className={clsx(stylex.props(storyLayout.canvas).className, 'scrollbar-pro')}>
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
    <div className={clsx(stylex.props(storyLayout.canvas).className, 'scrollbar-pro')}>
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
    <div className={clsx(stylex.props(storyLayout.canvas).className, 'scrollbar-pro')}>
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
    <div className={clsx(stylex.props(storyLayout.canvas).className, 'scrollbar-pro')}>
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
    <div className={clsx(stylex.props(storyLayout.canvas).className, 'scrollbar-pro')}>
      <DiffViewer {...args} />
    </div>
  ),
};

const largeContext = Array.from(
  { length: 2_400 },
  (_, index) => `export const generated_${index} = ${index};\n`
).join('');
const largePreparsedDiff = parseDiffFromFile(
  {
    name: 'src/generated/large-snapshot.ts',
    contents: `${largeContext}export const mode = "old";\n`,
  },
  {
    name: 'src/generated/large-snapshot.ts',
    contents: `${largeContext}export const mode = "new";\n`,
  }
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
    <div className={clsx(stylex.props(storyLayout.canvas).className, 'scrollbar-pro')}>
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
    <div {...stylex.props(storyLayoutStyles.row)}>
      <CollapseToggle />
      <span {...stylex.props(storyLayoutStyles.label)}>{fileName}</span>
      <span {...stylex.props(multiFileStyles.filePath)}>{path}</span>
      {additions > 0 && <span {...stylex.props(storyLayoutStyles.canvas)}>+{additions}</span>}
      {deletions > 0 && (
        <span
          {...stylex.props(multiFileStyles.deletions, additions > 0 ? multiFileStyles.adjacentCount : multiFileStyles.trailingCount)}
        >
          -{deletions}
        </span>
      )}
    </div>
  );

  return (
    <div className={clsx(stylex.props(storyLayout.frame2).className, 'scrollbar-pro')}>
      <div {...stylex.props(multiFileStyles.toolbar)}>
        <span {...stylex.props(storyLayoutStyles.label2)}>Diff Style:</span>
        <button
          type="button"
          onClick={() => setDiffStyle('unified')}
          {...stylex.props(multiFileStyles.styleChoice, diffStyle === 'unified' ? multiFileStyles.selectedChoice : multiFileStyles.idleChoice)}
        >
          Stack
        </button>
        <button
          type="button"
          onClick={() => setDiffStyle('split')}
          {...stylex.props(multiFileStyles.styleChoice, diffStyle === 'split' ? multiFileStyles.selectedChoice : multiFileStyles.idleChoice)}
        >
          Split
        </button>
        <div {...stylex.props(storyLayout.frame3)} />
        <label {...stylex.props(storyLayoutStyles.row2)}>
          <input
            type="checkbox"
            checked={useCustomHeader}
            onChange={(e) => setUseCustomHeader(e.target.checked)}
            {...stylex.props(storyLayout.frame4)}
          />
          Custom Header
        </label>
        <span {...stylex.props(storyLayoutStyles.label3)}>
          {multiFileDiffs.length} files changed
        </span>
      </div>
      <div {...stylex.props(multiFileStyles.fileList)}>
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
