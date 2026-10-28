import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { LoroDocumentManager } from '../loro/doc';
import { exportWorkspaceData } from './export-service';

vi.mock('./workspace-usage', () => ({
  fetchWorkspaceUsageBundle: async () => ({ summary: {}, timelines: [] }),
}));

it('writes decrypted session history locally without touching unsupported encrypted schedule rooms', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-encrypted-export-'));
  const outputDir = path.join(root, 'export');
  const session = { id: 'synthetic', title: 'Private export', createdAt: '2026-01-01T00:00:00Z' };
  const history = [
    {
      id: 'turn',
      role: 'user',
      timestamp: session.createdAt,
      items: [{ type: 'text', text: 'SYNTHETIC_DECRYPTED_EXPORT' }],
    },
  ];
  const manager = {
    repo: {
      metaFlock: { exportJson: () => ({}) },
      getMeta: () => ({ scan: async () => [{ key: ['m', 'session-synthetic'] }] }),
      getDocMeta: async () => ({ meta: session }),
      openFlockDoc: async () => {
        throw new Error('encrypted schedule room must stay closed');
      },
    },
    getSessionHistorySnapshot: async () => history,
  } as unknown as LoroDocumentManager;
  try {
    const result = await exportWorkspaceData({
      manager,
      workspace: {
        id: 'protected',
        slug: null,
        name: 'Protected',
        contentMode: 'e2ee',
      },
      cliToken: 'synthetic',
      outputDir,
      downloadImages: false,
    });
    expect(result.manifest).toMatchObject({ sessionCount: 1, scheduleCount: 0 });
    expect(
      await readFile(path.join(outputDir, 'sessions/synthetic/transcript.md'), 'utf8')
    ).toContain('SYNTHETIC_DECRYPTED_EXPORT');
    expect(
      JSON.parse(await readFile(path.join(outputDir, 'schedules/index.json'), 'utf8'))
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
