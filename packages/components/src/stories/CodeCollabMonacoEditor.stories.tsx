import type { Meta, StoryObj } from '@storybook/react';
import { useMemo } from 'react';
import { Provider, createStore } from 'jotai';
import {
  getMachineRoomId,
  getServerNow,
  type MachineId,
  type MachineViewMeta,
  type SessionMeta,
} from '@lody/shared';
import {
  SessionFileConflictActionRow,
  SessionFileContentView,
  SessionFileRealtimeStatusBar,
} from '@/components/sessions/session-file-content-view';
import {
  createFakeSessionFileProvider,
  type SessionFileProviderEntry,
} from '@/lib/session-file-provider';
import { machineMetaCacheAtom } from '@/atoms/doc-meta';

const meta: Meta = {
  title: 'Sessions/CodeCollabMonacoEditor',
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;

type Story = StoryObj;

const sampleText = [
  'export function buildSnapshot(input: SnapshotInput): SessionSnapshot {',
  '  const meta = normalizeMeta(input.meta);',
  '  const files = input.files.map((file) => ({',
  '    fileId: file.id,',
  '    path: file.path.replace(/\\\\/g, "/"),',
  '    sizeBytes: file.sizeBytes ?? 0,',
  '  }));',
  '  return {',
  '    meta,',
  '    files,',
  '    builtAt: Date.now(),',
  '  };',
  '}',
].join('\n');

const FILE_ID = 'monaco-story-file-1';

const storySession = {
  id: 'code-collab-monaco-editor-story',
  machineId: 'story-machine',
  userId: 'storybook-user',
  title: 'Code Collab Monaco editor',
  status: { type: 'running' },
  createdAt: '2026-06-01T00:00:00.000Z',
  cliType: 'codex',
  agentType: 'codex',
} as unknown as SessionMeta;

const storyMachineId = storySession.machineId as MachineId;

function createStoryMachineStore(machineOnline: boolean) {
  const store = createStore();
  const machine: MachineViewMeta = {
    id: storyMachineId,
    name: 'Story Machine',
    cliVersion: '0.56.0',
    os: 'macOS',
    sessions: [],
    raceLimits: {},
    needToArchiveSessions: {},
    needToDeleteSessions: {},
    lastSeen: getServerNow() - (machineOnline ? 0 : 600_000),
  };
  store.set(machineMetaCacheAtom, {
    [getMachineRoomId(storyMachineId)]: machine,
  });
  return store;
}

const liveProviderEntry: SessionFileProviderEntry = {
  fileId: FILE_ID,
  path: 'src/lib/build-snapshot.ts',
  kind: 'text',
  sourceState: 'live-collaborative',
  sizeBytes: sampleText.length,
};

const renamedProviderEntry: SessionFileProviderEntry = {
  fileId: FILE_ID,
  path: 'src/snapshot/build-snapshot.ts',
  kind: 'text',
  sourceState: 'live-collaborative',
  sizeBytes: sampleText.length,
};

const deletedProviderEntry: SessionFileProviderEntry = {
  fileId: FILE_ID,
  path: 'src/lib/build-snapshot.ts',
  kind: 'deleted',
  sourceState: 'historical-turn',
  readonly: true,
  unavailableReason: 'deleted',
};

const recreatedProviderEntry: SessionFileProviderEntry = {
  fileId: 'monaco-story-file-2',
  path: 'src/lib/build-snapshot.ts',
  kind: 'text',
  sourceState: 'live-collaborative',
  sizeBytes: sampleText.length,
};

function StatusBarFrame({
  machineOnline = true,
  width = 900,
}: {
  readonly machineOnline?: boolean;
  readonly width?: number;
}) {
  const store = useMemo(() => createStoryMachineStore(machineOnline), [machineOnline]);
  const provider = useMemo(
    () =>
      createFakeSessionFileProvider({
        sourceState: 'live-collaborative',
        files: [liveProviderEntry],
        snapshots: {
          [liveProviderEntry.path]: { kind: 'text', text: sampleText },
        },
      }),
    []
  );
  return (
    <Provider store={store}>
      <div
        className="h-[520px] overflow-hidden rounded-md border border-border bg-background"
        style={{ width }}
      >
        <SessionFileContentView
          sessionId={storySession.id}
          session={storySession}
          filePath={liveProviderEntry.path}
          fileId={liveProviderEntry.fileId}
          fileProvider={provider}
          fileProviderPending={false}
          fileProviderRole="host"
        />
      </div>
    </Provider>
  );
}

function t(key: string, defaultValue: string): string {
  void key;
  return defaultValue;
}

function StaticConflictStatusFrame() {
  return (
    <div className="flex h-[300px] w-[560px] flex-col overflow-hidden rounded-md border border-border bg-background">
      <div className="min-h-0 flex-1 overflow-hidden bg-[#1e1e1e] px-4 py-3 font-mono text-[13px] leading-6 text-[#d4d4d4]">
        <div>export function saveSnapshot() {' {'}</div>
        <div className="pl-4 text-[#9cdcfe]">return writeFile(snapshot);</div>
        <div>{'}'}</div>
      </div>
      <SessionFileConflictActionRow onResolveConflict={async () => undefined} t={t} />
      <SessionFileRealtimeStatusBar
        saveStatus={{ kind: 'conflict', conflict: 'modified_on_disk', at: 0 }}
        liveStatus={{ kind: 'idle' }}
        showSaveStatus
        t={t}
      />
    </div>
  );
}

export const RealtimeStatusBarOnline: Story = {
  name: 'Realtime status bar - machine online',
  render: () => <StatusBarFrame />,
};

export const RealtimeStatusBarOffline: Story = {
  name: 'Realtime status bar - machine offline',
  render: () => <StatusBarFrame machineOnline={false} />,
};

export const RealtimeStatusBarNarrow: Story = {
  name: 'Realtime status bar - narrow width',
  render: () => <StatusBarFrame width={320} />,
};

export const RealtimeStatusBarConflict: Story = {
  name: 'Realtime status bar - conflict',
  render: () => <StaticConflictStatusFrame />,
};

export const DeletedOpenFile: Story = {
  name: 'Deleted open file',
  render: () => {
    const provider = createFakeSessionFileProvider({
      sourceState: 'live-collaborative',
      files: [deletedProviderEntry],
    });
    return (
      <div className="h-[520px] w-[900px] overflow-hidden rounded-md border border-border bg-background">
        <SessionFileContentView
          sessionId={storySession.id}
          session={storySession}
          filePath={deletedProviderEntry.path}
          fileId={deletedProviderEntry.fileId}
          fileProvider={provider}
          fileProviderPending={false}
        />
      </div>
    );
  },
};

export const RecreatedSamePath: Story = {
  name: 'Recreated same-path file',
  render: () => {
    const oldProvider = createFakeSessionFileProvider({
      sourceState: 'live-collaborative',
      files: [deletedProviderEntry],
    });
    const newProvider = createFakeSessionFileProvider({
      sourceState: 'live-collaborative',
      files: [recreatedProviderEntry],
      snapshots: {
        [recreatedProviderEntry.path]: {
          kind: 'text',
          text: ['// recreated at same path', '// fresh path-keyed file state', ''].join('\n'),
        },
      },
    });
    return (
      <div className="grid h-[640px] w-[1180px] grid-cols-2 gap-3 overflow-hidden rounded-md border border-border bg-background p-3">
        <section className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border">
          <SessionFileContentView
            sessionId={storySession.id}
            session={storySession}
            filePath={deletedProviderEntry.path}
            fileId={deletedProviderEntry.fileId}
            fileProvider={oldProvider}
            fileProviderPending={false}
          />
        </section>
        <section className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border">
          <SessionFileContentView
            sessionId={storySession.id}
            session={storySession}
            filePath={recreatedProviderEntry.path}
            fileId={recreatedProviderEntry.fileId}
            fileProvider={newProvider}
            fileProviderPending={false}
            fileProviderRole="host"
          />
        </section>
      </div>
    );
  },
};

export const RenamedOpenFile: Story = {
  name: 'Renamed open file',
  render: () => {
    const provider = createFakeSessionFileProvider({
      sourceState: 'live-collaborative',
      files: [renamedProviderEntry],
      snapshots: {
        [renamedProviderEntry.path]: { kind: 'text', text: sampleText },
      },
    });
    return (
      <div className="h-[520px] w-[900px] overflow-hidden rounded-md border border-border bg-background">
        <SessionFileContentView
          sessionId={storySession.id}
          session={storySession}
          filePath={renamedProviderEntry.path}
          fileId={renamedProviderEntry.fileId}
          fileProvider={provider}
          fileProviderPending={false}
          fileProviderRole="host"
        />
      </div>
    );
  },
};
