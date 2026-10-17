import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { SessionId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import { SessionConversationDiffPanel } from '@/components/sessions/session-conversation-diff-panel';
import {
  createFakeSessionFileProvider,
  type SessionFileDiffResult,
} from '@/lib/session-file-provider';

const platform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'unauthenticated' }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});
const paths = Array.from(
  { length: 200 },
  (_, index) => `src/file-${String(index).padStart(3, '0')}.ts`
);
const oldText = Array.from(
  { length: 200 },
  (_, index) => `export const before${index} = ${index};\n`
).join('');
const newText = Array.from(
  { length: 200 },
  (_, index) => `export const after${index} = ${index + 1};\n`
).join('');
const diffs = Object.fromEntries(
  paths.map((path) => [
    path,
    {
      status: 'ready',
      path,
      oldSnapshot: { kind: 'text', text: oldText },
      newSnapshot: { kind: 'text', text: newText },
    } satisfies SessionFileDiffResult,
  ])
);
const fileProvider = createFakeSessionFileProvider({ diffs });
fileProvider.getAllChangesDiff = async () => ({
  status: 'ready',
  base: 'synthetic-base',
  truncated: false,
  entries: paths.map((path) => ({ path, diff: { status: 'deferred' } })),
});

const meta = {
  title: 'Sessions/ConversationDiffPanel',
  component: SessionConversationDiffPanel,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <PlatformContext.Provider value={platform}>
        <div style={{ height: '100vh' }}>
          <Story />
        </div>
      </PlatformContext.Provider>
    ),
  ],
  args: {
    sessionId: 'synthetic-diff-session' as SessionId,
    turnId: 'synthetic-turn',
    filePaths: paths,
    fileDiffs: paths.map((filePath) => ({
      filePath,
      add: 200,
      del: 200,
      cc: { v: 1, fileId: filePath, opId: '1:1', baseOpId: '0:1' },
    })),
    fileProvider,
  },
} satisfies Meta<typeof SessionConversationDiffPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

// Exercise the production sidebar transition and diff mount together. The
// synthetic opener does not run SessionDetail's session/tab/RPC controllers.
function OpenFromChangesHarness(args: ComponentProps<typeof SessionConversationDiffPanel>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <DesktopSessionDetailLayout
      defaultSizes={{ main: 50, sidebar: 50 }}
      topBar={
        <Button variant="secondary" disabled={!open} onClick={() => setOpen(false)}>
          {t('common.close')}
        </Button>
      }
      chatSurfaces={<Button onClick={() => setOpen(true)}>{t('sessions.changes.title')}</Button>}
      terminalDock={null}
      secondaryPanel={open ? <SessionConversationDiffPanel {...args} active /> : null}
      sidebarOpen={open}
      onSidebarCollapse={() => setOpen(false)}
      deleteConfirmDialog={null}
    />
  );
}

export const OpenFromChanges: Story = {
  render: (args) => <OpenFromChangesHarness {...args} />,
};
export const ManyFiles: Story = {};
export const FocusLastFile: Story = { args: { focusFilePath: paths.at(-1) } };
export const AllChanges: Story = { args: { mode: 'base', turnId: 'all-changes' } };
export const Hidden: Story = { args: { active: false } };
