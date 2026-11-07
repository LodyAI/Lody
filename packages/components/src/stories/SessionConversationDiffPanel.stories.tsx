import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState, type ComponentProps } from 'react';
import { gzipSync } from 'fflate';
import { CodeCollabSessionFileProvider } from '@/lib/code-collab-session-file-provider';
import { useSessionDiffSummary } from '@/components/sessions/use-session-diff-summary';
import { useTranslation } from 'react-i18next';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { CodeCollabDiffManifestEntry, SessionId } from '@lody/shared';
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
export const AllChangesStaleIndex: Story = {
  args: { mode: 'base', turnId: 'all-changes', filePaths: ['stale-index.ts'] },
};
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
function RemoteHunksHarness({
  retainOthers = false,
  ...args
}: ComponentProps<typeof SessionConversationDiffPanel> & { retainOthers?: boolean }) {
  const [transferred, setTransferred] = useState(0);
  const remoteProvider = useMemo(() => {
    let failReads = false;
    let advanced = false;
    const bodies = new Map<string, Uint8Array>();
    const remoteKeys = new Set<string>();
    const remotePath = 'src/remote-large.ts';
    const allPaths = retainOthers
      ? ['src/a-stable.ts', remotePath, 'src/z-stable.ts']
      : [remotePath];
    const describe = async (text: string, remote: boolean) => {
      const bytes = new TextEncoder().encode(text);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const key = `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      bodies.set(key, bytes);
      if (remote) remoteKeys.add(key);
      return { key, rawBytes: bytes.length, format: { encoding: 'utf8' as const } };
    };
    const entry = async (path: string): Promise<CodeCollabDiffManifestEntry> => {
      const remote = path === remotePath;
      const prefix = remote ? 'value' : path.includes('a-stable') ? 'stableA' : 'stableZ';
      const changed = remote ? 'changed' : path.includes('a-stable') ? 'editedA' : 'editedZ';
      const lines = Array.from(
        { length: 2000 },
        (_, i) => `export const ${prefix}${i} = "${'x'.repeat(120)}";`
      );
      const before = lines.join('\n') + '\n';
      const after = before.replace(`${prefix}1000 =`, `${changed}1000 =`);
      const head = await describe(after, remote);
      return {
        path,
        status: advanced && remote ? 'not_changed' : 'ok',
        base: advanced && remote ? head : await describe(before, remote),
        head,
        add: 1,
        del: 1,
        hunks:
          `--- ${path}\n+++ ${path}\n@@ -998,7 +998,7 @@\n` +
          lines
            .slice(997, 1004)
            .map((line, i) =>
              i === 3
                ? `-${line}\n+${line.replace(`${prefix}1000 =`, `${changed}1000 =`)}\n`
                : ` ${line}\n`
            )
            .join(''),
      };
    };
    const provider = new CodeCollabSessionFileProvider({
      allChanges: { 'stale-index.ts': true },
      role: 'write',
      runtime: {
        sessionId: args.sessionId,
        previewFile: async () => null,
        openText: async () => null,
        refreshText: async () => null,
        saveText: async () => null,
        openCurrentDiff: async () => null,
        openAllChangesDiff: async () => null,
        openTurnDiff: async () => null,
        initDirectory: async () => null,
        lspDefinition: async () => null,
        lspReferences: async () => null,
        diffBlobTransportOptions: async () => ({
          supported: true,
          scope: 'synthetic-remote',
          persist: false,
        }),
        openDiffManifest: async (request) => ({
          status: 'ok',
          base: (advanced ? '2' : '1').repeat(40),
          nextCursor: null,
          entries: await Promise.all(
            (request.path
              ? [request.path]
              : allPaths.filter((path) => !advanced || path !== remotePath)
            ).map(entry)
          ),
        }),
        readDiffBlob: async (key, offset, length) => {
          if (failReads)
            return {
              status: 'error',
              code: 'transient_io',
              message: 'Synthetic connection unavailable.',
            };
          if (advanced && remoteKeys.has(key)) return { status: 'error', code: 'stale' };
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
      },
    });
    return {
      provider,
      fail: () => {
        failReads = true;
      },
      restore: () => {
        failReads = false;
      },
      advance: () => {
        advanced = true;
      },
    };
  }, [args.sessionId, retainOthers]);
  const summary = useSessionDiffSummary(args.sessionId, { fileProvider: remoteProvider.provider });
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, flexDirection: 'column' }}>
      <div>
        <output aria-label="Transferred blob bytes">{transferred}</output>
        {args.mode === 'base' && (
          <output aria-label="Changed files">
            {summary.summary.changeFilePaths.join(', ') || 'None'}
          </output>
        )}
        <Button onClick={remoteProvider.fail}>Simulate read failure</Button>
        <Button onClick={remoteProvider.restore}>Restore reads</Button>
        <Button onClick={remoteProvider.advance}>Advance comparison</Button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SessionConversationDiffPanel
          {...args}
          filePaths={args.mode === 'base' ? summary.summary.changeFilePaths : args.filePaths}
          fileProvider={remoteProvider.provider}
        />
      </div>
    </div>
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

export const RemoteHunksChangingBase: Story = {
  args: { ...RemoteHunks.args, mode: 'base', focusFilePath: 'src/remote-large.ts' },
  render: (args) => <RemoteHunksHarness {...args} />,
};

export const RemoteHunksRetainedState: Story = {
  args: { ...RemoteHunksChangingBase.args },
  render: (args) => <RemoteHunksHarness {...args} retainOthers />,
};
