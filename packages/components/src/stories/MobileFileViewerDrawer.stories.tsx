import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useMemo, useState } from 'react';
import type { SessionMeta } from '@lody/shared';
import { SessionFileContentView } from '@/components/sessions/session-file-content-view';
import { createFakeSessionFileProvider } from '@/lib/session-file-provider';
import { fn } from 'storybook/test';
import { Button } from '@lody/ui/button';

import { MobileFileViewerDrawer } from '@/components/mobile/mobile-file-viewer-drawer';
import { SessionFileErrorState } from '@/components/sessions/session-file-error-state';
const viewerStory = stylex.create({
  source: {
    height: '100%',
    overflow: 'auto',
    padding: 'calc(var(--spacing) * 4)',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'calc(var(--spacing) * 5)',
    color: 'hsl(var(--foreground) / 1)',
  },
});
const storyLayout = stylex.create({
  frame: {
    height: '100dvh',
    'background-color': 'hsl(var(--background) / 1)',
  },
});

function MobileFileViewerDrawerStory({
  error,
  editable = false,
  long = false,
  rtl = false,
}: {
  readonly error?: string;
  readonly editable?: boolean;
  readonly long?: boolean;
  readonly rtl?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const filePath = 'docs/README.md';
  useEffect(() => {
    const previous = document.documentElement.dir;
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    return () => {
      document.documentElement.dir = previous;
    };
  }, [rtl]);
  const session = useMemo(
    () =>
      ({
        id: 'mobile-file-story',
        machineId: 'story-machine',
      }) as SessionMeta,
    []
  );
  const provider = useMemo(
    () =>
      createFakeSessionFileProvider({
        files: [
          { path: filePath, fileId: 'readme', kind: 'text', sourceState: 'live-collaborative' },
        ],
        snapshots: {
          [filePath]: { kind: 'text', text: '# Project documentation\n\nReview before editing.\n' },
        },
      }),
    []
  );

  return (
    <main {...stylex.props(storyLayout.frame)} data-file-viewer-fixture data-rtl={rtl}>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Reopen file viewer
      </Button>
      <MobileFileViewerDrawer
        open={open}
        onOpenChange={setOpen}
        filePath={filePath}
        onCopyPath={fn()}
        onCopyMarkdown={fn()}
      >
        {error ? (
          <SessionFileErrorState message={error} />
        ) : editable ? (
          <SessionFileContentView
            sessionId={session.id}
            session={session}
            filePath={filePath}
            fileId="readme"
            fileProvider={provider}
            fileProviderRole="write"
            active={open}
            defaultReadOnly
            preferNativeMarkdownSelection
          />
        ) : (
          <pre {...stylex.props(viewerStory.source)}>
            {long
              ? Array.from(
                  { length: 60 },
                  (_, index) =>
                    `Synthetic file line ${String(index + 1).padStart(2, '0')} · UI width migration`
                ).join('\n')
              : '# Project documentation\n\nLong-press to select this Markdown source.\n'}
          </pre>
        )}
      </MobileFileViewerDrawer>
    </main>
  );
}

const meta = {
  title: 'Mobile/MobileFileViewerDrawer',
  component: MobileFileViewerDrawerStory,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof MobileFileViewerDrawerStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FileContent: Story = {
  args: {},
};

export const OutsideWorkspaceError: Story = {
  args: {
    error: 'Path escapes workspace root.',
  },
};

export const LongContentRTL: Story = {
  args: { long: true, rtl: true },
};

export const ReadOnlyWithEditToggle: Story = {
  args: { editable: true },
};
