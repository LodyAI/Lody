import type { Meta, StoryObj } from '@storybook/react';
import type { SessionMeta } from '@lody/shared';
import { useMemo } from 'react';
import { userEvent, within } from 'storybook/test';

import { SessionFileContentView } from '@/components/sessions/session-file-content-view';
import {
  createFakeSessionFileProvider,
  type SessionFileProviderEntry,
} from '@/lib/session-file-provider';

const HTML_FILE: SessionFileProviderEntry = {
  fileId: 't:result-html',
  path: 'artifacts/result.html',
  kind: 'text',
  sourceState: 'live-readonly',
  sizeBytes: 1_024,
};

const HTML_SOURCE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Agent HTML result</title>
    <style>
      body { margin: 0; padding: 40px; font: 16px system-ui; background: #f6f6f3; color: #20201e; }
      main { max-width: 560px; margin: 0 auto; padding: 32px; border: 1px solid #d8d8d2; background: white; }
      button { padding: 8px 12px; border: 1px solid #aaa; background: #fff; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <h1>Self-contained HTML preview</h1>
      <p>Inline CSS and JavaScript run inside the sandboxed document.</p>
      <p><a href="#details">Jump to details</a></p>
      <p><a id="cancelled-fragment" href="#details">Cancel details jump</a></p>
      <p><a id="stopped-fragment" href="#details">Stop propagation and jump</a></p>
      <p><a href="about:blank">Try blocked navigation</a></p>
      <button id="counter" type="button">Clicked 0 times</button>
      <h2 id="details">Details</h2>
      <p>Fragment links stay in this document.</p>
    </main>
    <script>
      let count = 0;
      document.querySelector('#counter').addEventListener('click', (event) => {
        count += 1;
        event.currentTarget.textContent = 'Clicked ' + count + ' times';
      });
      document.querySelector('#cancelled-fragment').addEventListener('click', (event) => {
        event.preventDefault();
      });
      document.querySelector('#stopped-fragment').addEventListener('click', (event) => {
        event.stopPropagation();
      });
    </script>
  </body>
</html>`;

const storySession = {
  id: 'storybook-code-collab-html',
  machineId: 'storybook-machine',
  createdAt: '2026-08-20T00:00:00.000Z',
  userId: 'storybook-user',
  cliType: 'codex',
  agentType: 'codex',
} as unknown as SessionMeta;

function HtmlPreviewStory({ mobile = false }: { mobile?: boolean }) {
  const provider = useMemo(
    () =>
      createFakeSessionFileProvider({
        files: [HTML_FILE],
        snapshots: {
          [HTML_FILE.path]: { kind: 'text', text: HTML_SOURCE },
        },
      }),
    []
  );

  return (
    <div
      style={{ width: mobile ? 390 : 760, height: 640 }}
      className="flex flex-col overflow-hidden rounded-md border border-border bg-background"
    >
      <SessionFileContentView
        sessionId={storySession.id}
        session={storySession}
        filePath={HTML_FILE.path}
        fileId={HTML_FILE.fileId}
        fileProvider={provider}
        defaultHtmlPreview={mobile}
      />
    </div>
  );
}

const meta = {
  title: 'Sessions/CodeCollabHtmlPreview',
  component: HtmlPreviewStory,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof HtmlPreviewStory>;

export default meta;
type Story = StoryObj<typeof HtmlPreviewStory>;

export const CodeMode: Story = {};

export const RenderedMode: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /preview html/i }));
  },
};

export const MobilePreview: Story = {
  args: { mobile: true },
  parameters: { layout: 'fullscreen' },
};
