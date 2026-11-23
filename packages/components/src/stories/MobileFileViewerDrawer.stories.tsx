import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import type { SessionMeta } from '@lody/shared';
import { SessionFileContentView } from '@/components/sessions/session-file-content-view';
import { createFakeSessionFileProvider } from '@/lib/session-file-provider';
import { fn } from 'storybook/test';

import { MobileFileViewerDrawer } from '@/components/mobile/mobile-file-viewer-drawer';
import { SessionFileErrorState } from '@/components/sessions/session-file-error-state';

function MobileFileViewerDrawerStory({
  error,
  editable = false,
}: {
  readonly error?: string;
  readonly editable?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const filePath = 'docs/README.md';
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
    <main className="h-dvh bg-background">
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
          <pre className="h-full overflow-auto p-4 font-mono text-xs leading-5 text-foreground">
            {'# Project documentation\n\nLong-press to select this Markdown source.\n'}
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

export const ReadOnlyWithEditToggle: Story = {
  args: { editable: true },
};
