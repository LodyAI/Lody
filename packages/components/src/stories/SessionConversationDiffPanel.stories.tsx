import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState, type ComponentProps } from 'react';
import { gzipSync } from 'fflate';
import { DiffBlobCache } from '@/lib/diff-blob-cache';
import { manifestEntryToDiff, readDiffBlob } from '@/lib/diff-blob-client';
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

const uncommittedPaths = paths.slice(0, 3);
const uncommittedProvider = createFakeSessionFileProvider({ diffs });
uncommittedProvider.getAllChangesDiff = async (_focusPath, scope) => ({
  status: 'ready',
  base: scope === 'uncommitted' ? 'abcdef1234567890abcdef1234567890abcdef12' : 'synthetic-base',
  truncated: false,
  entries: (scope === 'uncommitted' ? uncommittedPaths : paths).map((path) => ({
    path,
    diff: diffs[path]!,
  })),
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

function ScopedAllChangesHarness(args: ComponentProps<typeof SessionConversationDiffPanel>) {
  const [scope, setScope] = useState<'branch' | 'uncommitted'>('branch');
  return (
    <SessionConversationDiffPanel
      {...args}
      allChangesScope={scope}
      onAllChangesScopeChange={setScope}
    />
  );
}

export const OpenFromChanges: Story = {
  render: (args) => <OpenFromChangesHarness {...args} />,
};
export const ManyFiles: Story = {};
export const FocusLastFile: Story = { args: { focusFilePath: paths.at(-1) } };
export const AllChanges: Story = { args: { mode: 'base', turnId: 'all-changes' } };
export const AllChangesScopeSwitch: Story = {
  args: {
    mode: 'base',
    allChangesScopeSupported: true,
    fileProvider: uncommittedProvider,
  },
  render: (args) => <ScopedAllChangesHarness {...args} />,
};
export const Hidden: Story = { args: { active: false } };

// Real partial-metadata -> panel -> Pierre expansion, with counted synthetic transport bytes.
function RemoteHunksHarness(args: ComponentProps<typeof SessionConversationDiffPanel>) {
  const [transferred, setTransferred] = useState(0);
  const remoteProvider = useMemo(() => {
    const cache = new DiffBlobCache();
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `export const value${i} = "${'x'.repeat(120)}";`
    );
    const oldText = lines.join('\n') + '\n';
    const newText = oldText.replace('value1000 =', 'changed1000 =');
    const patch =
      '--- src/remote-large.ts\n+++ src/remote-large.ts\n@@ -998,7 +998,7 @@\n' +
      lines
        .slice(997, 1004)
        .map((line, i) =>
          i === 3 ? `-${line}\n+${line.replace('value1000 =', 'changed1000 =')}\n` : ` ${line}\n`
        )
        .join('');
    const provider = createFakeSessionFileProvider({});
    provider.getDiff = async (_path, _turn, _file, options) => {
      const bodies = new Map<string, Uint8Array>();
      const describe = async (text: string) => {
        const bytes = new TextEncoder().encode(text);
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const key = `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
        bodies.set(key, bytes);
        return { key, rawBytes: bytes.length, format: { encoding: 'utf8' as const } };
      };
      const entry = {
        path: 'src/remote-large.ts',
        status: 'ok' as const,
        base: await describe(oldText),
        head: await describe(newText),
        hunks: patch,
      };
      return manifestEntryToDiff(entry, (blob) =>
        readDiffBlob({
          blob,
          cache,
          scope: 'synthetic-remote',
          persist: false,
          signal: options?.signal,
          read: async (key, offset, length) => {
            const bytes = bodies.get(key);
            if (!bytes) throw new Error('Synthetic blob missing.');
            const chunk = bytes.subarray(offset, offset + length);
            setTransferred((total) => total + chunk.length);
            let binary = '';
            for (const byte of gzipSync(chunk)) binary += String.fromCharCode(byte);
            return {
              offset,
              length: chunk.length,
              totalBytes: bytes.length,
              encoding: 'gzip-base64',
              data: btoa(binary),
            };
          },
        })
      );
    };
    return provider;
  }, []);
  return (
    <>
      <output aria-label="Transferred blob bytes">{transferred}</output>
      <SessionConversationDiffPanel {...args} fileProvider={remoteProvider} />
    </>
  );
}
export const RemoteHunks: Story = {
  args: {
    sessionId: 'synthetic-remote-hunk-session' as SessionId,
    turnId: 'remote-hunks',
    filePaths: ['src/remote-large.ts'],
    fileDiffs: [{ filePath: 'src/remote-large.ts', add: 1, del: 1 }],
  },
  render: (args) => <RemoteHunksHarness {...args} />,
};
