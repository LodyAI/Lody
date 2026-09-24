import type { Meta, StoryObj } from '@storybook/react';
import { PagedFileViewer } from '@/components/sessions/paged-file-viewer';

const meta = {
  title: 'Sessions/PagedFileViewer',
  component: PagedFileViewer,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-[600px] bg-background text-foreground">
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
