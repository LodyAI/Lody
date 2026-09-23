import type { Meta, StoryObj } from '@storybook/react';
import { getServerNow, type SessionFilePayload } from '@lody/shared';
import {
  SessionFilePreviewPanel,
  type SessionFilePreviewStatus,
} from '@/components/ai-gui/session-file-preview-dialog';
import { Dialog } from '@/ui/dialog';

const file = (overrides: Partial<SessionFilePayload>): SessionFilePayload => ({
  type: 'file',
  fileId: 'preview-file',
  fileName: 'notes.txt',
  mimeType: 'text/plain',
  sizeBytes: 4_200,
  sha256: 'b'.repeat(64),
  textPreview: true,
  transport: 'r2',
  uploadedAt: getServerNow(),
  ...overrides,
});

const SAMPLE_TEXT = `# Session Files

A quick rundown of how attachments flow through the system:

- Composer uploads bytes to R2 via the workspace-authenticated file API.
- The session history carries only a small \`file\` block (metadata, never bytes).
- Receivers render a card and, for text files, an in-app preview.

## Notes

1. Markdown defaults to the rendered view.
2. Copy always copies the raw source.
3. Previews fetch a bounded 1 MB prefix.

\`\`\`ts
export const isTextPreviewable = (name: string) => name.endsWith('.md');
\`\`\`
`;

const PLAIN_TEXT = Array.from(
  { length: 40 },
  (_, i) => `line ${i + 1}: lorem ipsum dolor sit amet`
).join('\n');

// Content designed to blow past the dialog width: a very long unbreakable
// token, a wide code block (long lines, no spaces), and a wide table. These are
// exactly the shapes that make the preview body overflow the modal instead of
// scrolling inside it.
const LONG_TOKEN = `x${'-verylongunbreakabletoken'.repeat(12)}`;

const WIDE_MARKDOWN = `# Wide content

A paragraph with a giant unbreakable identifier: ${LONG_TOKEN}

\`\`\`ts
export const config = { url: 'https://example.com/api/v1/resource?filter=${'a'.repeat(200)}', retries: 3, timeout: 30000, headers: { authorization: 'Bearer ${'z'.repeat(120)}' } };
\`\`\`

| Column A | Column B | Column C | Column D | Column E | Column F |
| --- | --- | --- | --- | --- | --- |
| ${'wide-cell-value-'.repeat(6)} | b | c | d | e | ${'another-wide-'.repeat(6)} |
`;

const WIDE_PLAIN_TEXT = [
  'A log line with an extremely long unbreakable path/token that should never widen the modal:',
  `/var/log/${'segment-'.repeat(40)}end`,
  ...Array.from({ length: 10 }, (_, i) => `line ${i + 1}: short content`),
].join('\n');

const meta = {
  title: 'AI/SessionFilePreviewPanel',
  component: SessionFilePreviewPanel,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionFilePreviewPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// The panel renders a `Dialog.Title`, which requires a Dialog.Root ancestor — mirror
// the real composition (SessionFilePreviewDialog wraps it in Dialog.Root/Dialog.Content)
// so the story exercises the panel exactly as users see it.
const wrap = (content: React.ReactNode) => (
  <Dialog.Root open>
    <Dialog.Content closeButton={false} className="w-[calc(100vw-2rem)] max-w-3xl">
      {content}
    </Dialog.Content>
  </Dialog.Root>
);

const loaded = (text: string, truncated = false): SessionFilePreviewStatus => ({
  kind: 'loaded',
  text,
  truncated,
});

export const PlainText: Story = {
  args: {
    file: file({ fileName: 'server.log', mimeType: 'text/plain' }),
    status: loaded(PLAIN_TEXT),
    onDownload: () => {},
  },
  render: (args) => wrap(<SessionFilePreviewPanel {...args} />),
};

export const MarkdownRendered: Story = {
  args: {
    file: file({ fileName: 'README.md', mimeType: 'text/markdown' }),
    status: loaded(SAMPLE_TEXT),
    onDownload: () => {},
  },
  render: (args) => wrap(<SessionFilePreviewPanel {...args} />),
};

export const Truncated: Story = {
  args: {
    file: file({ fileName: 'huge-export.csv', mimeType: 'text/csv', sizeBytes: 50_000_000 }),
    status: loaded(PLAIN_TEXT, true),
    onDownload: () => {},
  },
  render: (args) => wrap(<SessionFilePreviewPanel {...args} />),
};

export const WideMarkdown: Story = {
  args: {
    file: file({ fileName: 'WIDE.md', mimeType: 'text/markdown' }),
    status: loaded(WIDE_MARKDOWN),
    onDownload: () => {},
  },
  render: (args) => wrap(<SessionFilePreviewPanel {...args} />),
};

export const WidePlainText: Story = {
  args: {
    file: file({ fileName: 'wide.log', mimeType: 'text/plain' }),
    status: loaded(WIDE_PLAIN_TEXT),
    onDownload: () => {},
  },
  render: (args) => wrap(<SessionFilePreviewPanel {...args} />),
};

export const Loading: Story = {
  args: {
    file: file({ fileName: 'data.json' }),
    status: { kind: 'loading' },
    onDownload: () => {},
  },
  render: (args) => wrap(<SessionFilePreviewPanel {...args} />),
};

export const Error: Story = {
  args: {
    file: file({ fileName: 'broken.txt' }),
    status: { kind: 'error', message: 'Could not load preview' },
    onDownload: () => {},
  },
  render: (args) => wrap(<SessionFilePreviewPanel {...args} />),
};
