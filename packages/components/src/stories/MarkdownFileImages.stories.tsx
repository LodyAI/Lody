import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { MarkdownFileResources } from '@/components/ai-gui/markdown-file-image';
import { createFakeFileWorkspaceProvider } from '@/lib/file-workspace-provider';

const provider = createFakeFileWorkspaceProvider({
  files: [{ path: 'images/chart.svg', kind: 'text', sourceState: 'live-readonly' }],
  snapshots: {
    'images/chart.svg': {
      kind: 'text',
      text: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#324967"/><text x="24" y="88" fill="white" font-size="24">Markdown image</text></svg>',
    },
  },
});
const meta = {
  title: 'Files/Markdown images',
  component: MarkdownFileResources,
  args: {
    provider,
    documentPath: 'docs/guide.md',
    automatic: false,
    active: true,
    children: (
      <MarkdownRenderer
        text={
          '# Document\n\nThe text is available immediately.\n\n![Chart](../images/chart.svg)\n\nMore text after the image.\n\n![Missing image](./missing.png)'
        }
      />
    ),
  },
} satisfies Meta<typeof MarkdownFileResources>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RemoteClickToLoad: Story = {};
export const AutomaticLocal: Story = { args: { automatic: true } };
export const Loading: Story = {
  args: { automatic: true, provider: { openFile: () => new Promise(() => {}) } },
};
