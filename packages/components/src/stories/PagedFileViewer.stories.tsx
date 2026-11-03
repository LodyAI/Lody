import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { PagedFileViewer } from '@/components/sessions/paged-file-viewer';
const storyLayout = stylex.create({
  frame: {
    height: '480px',
    width: '600px',
    'background-color': 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
});

const meta = {
  title: 'Sessions/PagedFileViewer',
  component: PagedFileViewer,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PagedFileViewer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LargeText: Story = {
  args: {
    source: {
      sizeBytes: 3 * 1024 ** 3,
      pageBytes: 65536,
      readPage: async (page) =>
        Array.from(
          { length: 1500 },
          (_, i) => `Page ${page + 1}: synthetic log row ${i + 1} — 中文 😀`
        ).join('\n'),
    },
  },
};
export const FileChanged: Story = {
  args: {
    source: {
      sizeBytes: 3 * 1024 ** 3,
      pageBytes: 65536,
      readPage: async () => {
        throw new Error('File changed');
      },
    },
  },
};
