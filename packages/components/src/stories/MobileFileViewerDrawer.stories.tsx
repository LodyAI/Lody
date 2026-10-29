import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { fn } from 'storybook/test';
import { Button } from '@lody/ui/button';

import { MobileFileViewerDrawer } from '@/components/mobile/mobile-file-viewer-drawer';
import { SessionFileErrorState } from '@/components/sessions/session-file-error-state';

function MobileFileViewerDrawerStory({
  error,
  long = false,
  rtl = false,
}: {
  readonly error?: string;
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

  return (
    <main className="h-dvh bg-background" data-file-viewer-fixture data-rtl={rtl}>
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
        ) : (
          <pre className="h-full overflow-auto p-4 font-mono text-xs leading-5 text-foreground">
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
