import { LoroRepo } from 'loro-repo';
import { ScheduleRepository, type WorkspaceId } from '@lody/shared';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { LoroDocumentManager } from '../loro/doc';
import { exportWorkspaceData } from './export-service';

vi.mock('./workspace-usage', () => ({
  fetchWorkspaceUsageBundle: async () => ({ summary: {}, timelines: [] }),
}));

it('writes decrypted sessions and encrypted Schedule definitions to the local export', async () => {
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
  const repo = await LoroRepo.create({});
  await repo.upsertDocMeta('session-synthetic', session);
  const repository = new ScheduleRepository(repo, 'protected' as WorkspaceId, {
    protectedContent: true,
  });
  await repository.save({
    scheduleId: 'synthetic-schedule',
    actorId: 'owner',
    now: 0,
    activationId: 'active',
    activityId: 'create',
    create: true,
    draft: {
      title: 'Private schedule',
      prompt: 'SYNTHETIC_SCHEDULE_EXPORT',
      machineId: 'machine',
      trigger: { kind: 'once', at: '1970-01-01T00:01:00.000Z' },
      misfirePolicy: { kind: 'run_once' },
      overlapPolicy: 'queue_one',
      agent: { agentConfigId: 'agent' },
      retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86400000 },
    },
  });
  const manager = {
    repo,
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
    expect(result.manifest).toMatchObject({ sessionCount: 1, scheduleCount: 1 });
    expect(
      await readFile(path.join(outputDir, 'sessions/synthetic/transcript.md'), 'utf8')
    ).toContain('SYNTHETIC_DECRYPTED_EXPORT');
    expect(
      JSON.parse(await readFile(path.join(outputDir, 'schedules/index.json'), 'utf8'))
    ).toEqual([{ scheduleId: 'synthetic-schedule', title: 'Private schedule' }]);
    expect(
      await readFile(path.join(outputDir, 'schedules/synthetic-schedule/schedule.md'), 'utf8')
    ).toContain('SYNTHETIC_SCHEDULE_EXPORT');
  } finally {
    await repo.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
