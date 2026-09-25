import type { Meta, StoryObj } from '@storybook/react';
import type { SessionMeta } from '@lody/shared';
import { useMemo } from 'react';
import { within, userEvent } from 'storybook/test';
import { SessionFileContentView } from '@/components/sessions/session-file-content-view';
import {
  createFakeSessionFileProvider,
  type SessionFileProviderEntry,
} from '@/lib/session-file-provider';

const MARKDOWN_FILE: SessionFileProviderEntry = {
  fileId: 't:readme',
  path: 'README.md',
  kind: 'text',
  sourceState: 'live-collaborative',
  sizeBytes: 1_640,
};

const MARKDOWN_SOURCE = [
  '# Loro Code Collab',
  'Host-backed file browsing and digest-checked editing for your repository.',
  '> Markdown files open as rendered documents, with the source editor one toggle away.',
  '## Highlights',
  '- Host RPC open/refresh/save with digest conflict checks',
  '- Path-keyed file tree and current All Changes state',
  '- Rendered previews for `.svg` and `.md` files',
  '## Quick start',
  '```ts',
  'const file = await provider.openFile("README.md");',
  'await provider.saveFile("README.md", file.digest, nextText);',
  '```',
  '## Supported file states',
  '| State              | Editable | Notes                          |',
  '| ------------------ | :------: | ------------------------------ |',
  '| live-collaborative |    ✅    | Host RPC read/write            |',
  '| live-readonly      |    ❌    | Host RPC read-only             |',
  '| historical-turn    |    ❌    | Unavailable in v2              |',
  '### Checklist',
  '1. Open a workspace',
  '2. Pick a file from the tree',
  '3. Toggle **Code** to edit the Markdown source',
  '- [x] Code/Rendered toggle',
  '- [ ] Side-by-side preview',
  'See the [docs](https://example.com) for more.',
].join('\n');

const storySession = {
  id: 'storybook-code-collab-markdown',
  machineId: 'storybook-machine',
  createdAt: '2026-05-09T00:00:00.000Z',
  userId: 'storybook-user',
  cliType: 'codex',
  agentType: 'codex',
} as unknown as SessionMeta;

function MarkdownPreviewStory() {
  const provider = useMemo(
    () =>
      createFakeSessionFileProvider({
        sourceState: 'live-collaborative',
        files: [MARKDOWN_FILE],
        snapshots: {
          'README.md': { kind: 'text', text: MARKDOWN_SOURCE },
        },
      }),
    []
  );

  return (
    <div className="flex h-[640px] w-[760px] flex-col overflow-hidden rounded-md border border-border bg-background">
      <div className="min-h-0 flex-1">
        <SessionFileContentView
          sessionId={storySession.id}
          session={storySession}
          filePath={MARKDOWN_FILE.path}
          fileId={MARKDOWN_FILE.fileId}
          fileProvider={provider}
          fileProviderRole="write"
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Sessions/CodeCollabMarkdownPreview',
  component: MarkdownPreviewStory,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof MarkdownPreviewStory>;

export default meta;

type Story = StoryObj<typeof MarkdownPreviewStory>;

// Default: a Markdown file opens as a rendered document. The eye button switches
// back to the editable source view.
export const RenderedMode: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Markdown files open as formatted documents by default. The top bar shows a closed preview eye that switches back to the editable source.',
      },
    },
  },
  render: () => <MarkdownPreviewStory />,
};

// Code: the play function hides the default preview and reveals Monaco with the
// Markdown source plus search controls.
export const CodeMode: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'After clicking the closed preview eye, the Markdown source opens in Monaco with editing and search controls.',
      },
    },
  },
  render: () => <MarkdownPreviewStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const previewButton = await canvas.findByRole('button', { name: /^hide preview$/i });
    await userEvent.click(previewButton);
  },
};
