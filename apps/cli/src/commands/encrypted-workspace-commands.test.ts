import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getScheduleRegistryFlockDocId } from '@lody/shared';

const plaintext = { id: 'plain', name: 'Plain', slug: null, role: 'owner' };
const encrypted = {
  id: 'protected',
  name: 'Protected',
  slug: null,
  role: 'owner',
  contentMode: 'e2ee',
  genesisHash: 'ab'.repeat(32),
};
const seen = vi.hoisted(() => ({
  exported: [] as string[],
  flock: [] as string[],
  selected: undefined as unknown,
}));

vi.mock('@/lib/command-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/command-runtime')>()),
  getAuthContextOrThrow: () => ({ userId: 'u', token: 't', machineId: 'm' }),
  runOneShotCommand: async (_name: string, _options: unknown, run: () => Promise<void>) => run(),
  resolveWorkspaceOrThrow: async () => seen.selected,
  listAliveRoomIds: async () => [],
  listAliveDocMetas: async () => [],
  withWorkspaceManager: async (
    _auth: unknown,
    _workspace: unknown,
    _name: string,
    run: (manager: unknown) => Promise<unknown>
  ) =>
    run({
      syncMetaOrThrow: async () => undefined,
      syncDocOrThrow: async () => undefined,
      syncFlockDocOrThrow: async (id: string) => {
        seen.flock.push(id);
      },
    }),
}));
vi.mock('@/lib/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace')>()),
  listWorkspacesForToken: async () => [plaintext, encrypted],
}));
vi.mock('@/lib/session-export', () => ({
  exportWorkspaceData: async (input: { workspace: { id: string } }) => {
    seen.exported.push(input.workspace.id);
    return { manifest: { sessionCount: 0 }, warnings: [] };
  },
}));
vi.mock('@/lib/schedules/schedule-documents', () => ({
  listWorkspaceScheduleIds: async () => [],
}));

beforeEach(() => {
  vi.resetModules();
  seen.exported = [];
  seen.flock = [];
  seen.selected = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('encrypted workspaces in one-shot data commands', () => {
  it('export --all-workspace never decrypts an encrypted workspace to disk', async () => {
    const { exportCommand } = await import('./export');
    await exportCommand.parseAsync(['--all-workspace', '--offline', '/tmp/lody-export-test'], {
      from: 'user',
    });
    expect(seen.exported).toEqual(['plain']);
  });

  it('export of an explicitly selected encrypted workspace is refused', async () => {
    seen.selected = encrypted;
    const { exportCommand } = await import('./export');
    await expect(
      exportCommand.parseAsync(['--workspace', 'protected', '--offline', '/tmp/lody-export-test'], {
        from: 'user',
      })
    ).rejects.toThrow('Export is not available for end-to-end encrypted workspaces.');
    expect(seen.exported).toEqual([]);
  });

  it('sync skips the schedule registry only for an encrypted workspace', async () => {
    const { syncCommand } = await import('./sync');
    await syncCommand.parseAsync(['--all-workspace', '--json'], { from: 'user' });
    expect(seen.flock).toEqual([
      getScheduleRegistryFlockDocId('plain' as never),
      getScheduleRegistryFlockDocId('plain' as never),
    ]);
  });
});
