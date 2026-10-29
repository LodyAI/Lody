import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  getLocalProjectHistoryProviderKey,
  type LocalProjectId,
  type MachineId,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { MobileAcpHistorySheet } from '@/components/mobile/mobile-acp-history-sheet';
import type {
  ProjectHistoryImportState,
  ProjectSettingsRow,
} from '@/components/settings/project-settings';

const provider = { cliType: 'builtin', agentType: 'codex' } as const;
const providerKey = getLocalProjectHistoryProviderKey(provider);
const sessionId = 'synthetic-history-session';

function HistoryFixture({
  resolve = false,
  spacing = false,
}: {
  resolve?: boolean;
  spacing?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(false);
  const settle = useRef<(() => void) | null>(null);
  const [state, setState] = useState<ProjectHistoryImportState>(() => ({
    provider,
    providerKey,
    canSync: true,
    isSyncing: false,
    isImporting: false,
    catalog: {
      listed: 1,
      lastListedAt: Date.parse('2026-10-22T09:00:00Z'),
      sessions: [
        {
          acpSessionId: sessionId,
          title: 'Synthetic conversation with a long title for the history row',
          updatedAt: '2026-10-22T08:00:00Z',
          status: resolve ? 'sync_conflict' : 'available',
          ...(resolve ? { importedSessionId: 'synthetic-imported-session' } : {}),
        },
      ],
    },
    syncSummary: null,
    selectedSessionIds: resolve ? [] : [sessionId],
    resolvingSessionIds: [],
    errorMessage: null,
  }));
  useLayoutEffect(() => {
    if (!spacing) return;
    const root = document.documentElement;
    const old = root.style.getPropertyValue('--spacing');
    root.style.setProperty('--spacing', '5px');
    return () => {
      if (old) root.style.setProperty('--spacing', old);
      else root.style.removeProperty('--spacing');
    };
  }, [spacing]);
  const row: ProjectSettingsRow = {
    key: 'synthetic-history-project',
    machineId: 'synthetic-history-machine' as MachineId,
    machineName: 'Synthetic local machine',
    shell: 'bash',
    project: {
      id: 'synthetic-history-project' as LocalProjectId,
      name: 'Synthetic history project',
      rootPath: '/synthetic/project',
      createdAtMs: 1,
    },
    sharedWithTeam: false,
    conversationCount: 1,
    isUpdating: false,
    canUpdateSharing: false,
    worktreeSetup: { scripts: {} },
    isWorktreeSetupLoading: false,
    isWorktreeSetupSaving: false,
    worktreeSetupError: null,
    worktreeCleanup: { scripts: {} },
    isWorktreeCleanupLoading: false,
    isWorktreeCleanupSaving: false,
    worktreeCleanupError: null,
    historyImports: [state],
  };
  const run = async () => {
    setPending(true);
    setState((value) => ({
      ...value,
      isImporting: !resolve,
      resolvingSessionIds: resolve ? [sessionId] : [],
    }));
    await new Promise<void>((complete) => {
      settle.current = complete;
    });
    setPending(false);
    setState((value) => ({ ...value, isImporting: false, resolvingSessionIds: [] }));
    settle.current = null;
  };
  return (
    <div data-owned-history-fixture data-pending={String(pending)} style={{ padding: 16 }}>
      <Button onClick={() => setOpen(true)}>Open history fixture</Button>
      <Button disabled={!pending} onClick={() => settle.current?.()}>
        Complete synthetic history operation
      </Button>
      <MobileAcpHistorySheet
        open={open}
        onOpenChange={setOpen}
        row={row}
        state={state}
        onSyncHistory={async () => {}}
        onImportHistory={run}
        onResolveHistoryConflict={run}
        onHistorySelectionChange={(_row, _provider, selectedSessionIds) =>
          setState((value) => ({ ...value, selectedSessionIds }))
        }
      />
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedMobileHistorySpinner',
  component: HistoryFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof HistoryFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Import: Story = {};
export const Resolve: Story = { args: { resolve: true } };
export const ImportRootSpacing: Story = { args: { spacing: true } };
export const ResolveRootSpacing: Story = { args: { resolve: true, spacing: true } };
