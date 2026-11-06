import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn, userEvent, within } from 'storybook/test';

import { AssistantEditedFiles } from '@/components/ai-gui/assistant-edited-files';

const sceneStyles = stylex.create({
  ancestorState: {
    color: { default: null, ':hover': 'rgb(211 24 151)', ':focus-visible': 'rgb(20 134 190)' },
  },
});

const hundredFiles = Array.from({ length: 100 }, (_, index) => ({
  filePath: `packages/components/src/${index % 3 === 0 ? 'components' : 'lib'}/feature-${String(index + 1).padStart(3, '0')}.tsx`,
  add: (index * 17 + 3) % 180,
  del: (index * 7 + 1) % 90,
}));

const meta = {
  title: 'AI/AssistantEditedFiles',
  component: AssistantEditedFiles,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof AssistantEditedFiles>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourFiles: Story = {
  args: {
    files: [
      { filePath: 'packages/components/src/components/ai-gui/view.tsx', add: 124, del: 38 },
      {
        filePath: 'packages/components/src/lib/format-conversation-timestamp.ts',
        add: 24,
        del: 11,
      },
      {
        filePath: 'packages/components/src/stories/AssistantEditedFiles.stories.tsx',
        add: 48,
        del: 0,
      },
      { filePath: 'locales/en.json', add: 5, del: 5 },
    ],
    onFileClick: fn(),
  },
};

export const ManyFiles: Story = {
  args: {
    files: hundredFiles,
    onFileClick: fn(),
  },
};

export const ManyFilesExpanded: Story = {
  ...ManyFiles,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { expanded: false }));
  },
};

export const LongPaths: Story = {
  args: {
    files: [
      {
        filePath:
          'packages/components/src/components/sessions/really-long-directory-name/session-conversation-diff-viewer-with-an-even-longer-name.tsx',
        add: 218,
        del: 64,
      },
      {
        filePath:
          'packages/shared/src/agent-runtime/providers/codex/compatibility/normalize-streaming-tool-call-output.ts',
        add: 37,
        del: 19,
      },
      { filePath: 'README.md', add: 12, del: 0 },
    ],
    onFileClick: fn(),
  },
};

export const DarkManyFiles: Story = {
  ...ManyFiles,
  globals: { theme: 'dark' },
};

export const MissingLegacyStats: Story = {
  args: {
    files: [{ filePath: 'src/legacy-import.ts' }, { filePath: 'src/partially-known.ts', add: 12 }],
  },
};

export const UncountedChanges: Story = {
  args: {
    files: [
      { filePath: 'README.md', add: 0, del: 0 },
      { filePath: 'assets/screenshot.png', add: 0, del: 0 },
      { filePath: 'src/app.ts', add: 12, del: 3 },
    ],
  },
};

function InteractiveFiles({ rowXstyle }: { rowXstyle?: stylex.StyleXStyles }) {
  const [selected, setSelected] = useState('None');
  return (
    <div data-edited-files-fixture>
      <AssistantEditedFiles
        files={hundredFiles.slice(0, 6)}
        rowXstyle={rowXstyle}
        onFileClick={setSelected}
      />
      <output data-edited-files-selected>{selected}</output>
    </div>
  );
}

export const InteractiveExpansion: Story = {
  args: { files: hundredFiles.slice(0, 6) },
  render: () => <InteractiveFiles />,
};

export const AncestorStateOverride: Story = {
  args: { files: hundredFiles.slice(0, 6) },
  render: () => <InteractiveFiles rowXstyle={sceneStyles.ancestorState} />,
};
