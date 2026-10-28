import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  listWorkspaceCandidates: async () => [plaintext, encrypted],
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

describe('local encrypted execution log maintenance', () => {
  it('resets through the CLI and reports an evidence archive while fencing the old request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lody-journal-command-'));
    try {
      const { RealtimeJournal } = await import('../lib/e2ee/realtime-journal');
      const filename = join(directory, 'journal.sqlite');
      const original = {
        genesis: 'synthetic-genesis',
        workspaceId: 'synthetic-workspace',
        targetMachineId: 'synthetic-machine',
        requestId: 'synthetic-request',
        requester: 'synthetic-device',
        expiresAt: 1_000,
        frame: Uint8Array.of(1, 2, 3),
      };
      const journal = RealtimeJournal.create(filename, () => 100);
      journal.receive(original);
      expect(journal.claim(original).state).toBe('claimed');
      const before = readFileSync(filename);
      const { e2eeCommand } = await import('./e2ee');
      await e2eeCommand.parseAsync(['journal', 'reset', '--file', filename, '--json'], {
        from: 'user',
      });
      const lines = vi.mocked(console.log).mock.calls.map(([value]) => String(value));
      const receipt = JSON.parse(lines.find((line) => line.includes('archivePath')) ?? '{}') as {
        ok: boolean;
        archivePath: string;
        journalPath: string;
      };
      expect(receipt).toMatchObject({ ok: true, journalPath: filename });
      expect(readFileSync(receipt.archivePath)).toEqual(before);
      const fresh = new RealtimeJournal(filename, () => 100);
      expect(() => fresh.receive(original)).toThrow('archived_request');
      const next = { ...original, requestId: 'synthetic-new-request' };
      fresh.receive(next);
      expect(fresh.claim(next).state).toBe('claimed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
