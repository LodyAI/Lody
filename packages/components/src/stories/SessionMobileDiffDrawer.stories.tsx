import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { Button } from '@lody/ui/button';
import type { SessionId } from '@lody/shared';
import {
  SessionMobileDiffDrawer,
  type MobileDiffView,
} from '@/components/sessions/session-mobile-diff-drawer';
import { SessionConversationDiffPanel } from '@/components/sessions/session-conversation-diff-panel';
import { createFakeSessionFileProvider } from '@/lib/session-file-provider';

const platform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'unauthenticated' }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});
const entries = [
  { filePath: 'src/provider-setup-row.tsx', add: 26, del: 21 },
  { filePath: 'docs/provider-setup.md', add: 16, del: 0 },
  { filePath: 'docs/provider-setup.zh.md', add: 14, del: 0 },
  { filePath: 'tests/provider-setup-row.test.tsx', add: 16, del: 0 },
];
const paths = entries.map((entry) => entry.filePath);
const fileProvider = createFakeSessionFileProvider({
  diffs: Object.fromEntries(
    paths.map((path) => [
      path,
      {
        status: 'ready',
        path,
        oldSnapshot: { kind: 'text', text: 'export const enabled = false;\n' },
        newSnapshot: { kind: 'text', text: 'export const enabled = true;\n' },
      },
    ])
  ),
});
fileProvider.getAllChangesDiff = async () => ({
  status: 'ready',
  base: 'synthetic-base',
  truncated: false,
  entries: paths.map((path) => ({ path, diff: { status: 'deferred' } })),
});

function Navigation({
  ready = true,
  unavailableMessage,
}: {
  ready?: boolean;
  unavailableMessage?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<MobileDiffView>('files');
  const [focusFilePath, setFocusFilePath] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  return (
    <PlatformContext.Provider value={platform}>
      <Button
        onClick={() => {
          setView('files');
          setOpen(true);
        }}
      >
        {t('sessions.changes.title')}
      </Button>
      <SessionMobileDiffDrawer
        open={open}
        onOpenChange={setOpen}
        view={view}
        onBackToFiles={() => setView('files-with-diff')}
        changes={{
          ready,
          synced: true,
          unavailableMessage,
          changeEntries: entries,
          changeFilePaths: paths,
          onOpenChangesDiff: (path) => {
            setFocusFilePath(path);
            setSeq((current) => current + 1);
            setView('diff');
          },
        }}
      >
        <SessionConversationDiffPanel
          active={open && view === 'diff'}
          sessionId={'synthetic-mobile-diff' as SessionId}
          turnId="all-changes"
          mode="base"
          filePaths={paths}
          focusFilePath={focusFilePath}
          focusRequestSeq={seq}
          fileProvider={fileProvider}
        />
      </SessionMobileDiffDrawer>
    </PlatformContext.Provider>
  );
}

export default {
  title: 'Sessions/MobileDiffDrawer',
  component: Navigation,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Navigation>;
type Story = StoryObj<typeof Navigation>;
export const Changes: Story = {};
export const Loading: Story = { args: { ready: false } };
