import { LoroRepo } from 'loro-repo';
import { ScheduleRepository, type SessionMeta, type WorkspaceId } from '@lody/shared';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoroDocumentManager } from '../loro/doc';
import { exportWorkspaceData } from './export-service';
import { toExportSessionSummary } from './formatters';
import { buildTranscriptMarkdown } from './markdown';
import { prepareExportOutputDir } from './output-dir';

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
    // Export never verifies declarations; a well-formed placeholder record suffices.
    signDeclaration: async () => 'A'.repeat(131),
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

describe('session export formatters', () => {
  const createSessionMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
    id: 'session-1',
    machineId: 'machine-1',
    createdAt: '2026-03-23T10:00:00.000Z',
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'claude',
    ...overrides,
  });

  it('renders transcript markdown with thought blocks and attachment links', () => {
    const markdown = buildTranscriptMarkdown({
      session: toExportSessionSummary(createSessionMeta({ title: 'Exporter' }), 'workspace-1'),
      turns: [
        {
          turnId: 'turn-1',
          role: 'assistant',
          timestamp: '2026-03-23T10:01:00.000Z',
          finished: true,
          sendStatus: undefined,
          startedAt: null,
          endedAt: null,
          modelInfo: undefined,
          items: [
            { type: 'text', text: 'Implemented the command. See [Old](session://child).' },
            { type: 'thought', text: 'Need to keep this independent.' },
            {
              type: 'image',
              imageId: 'img-1',
              mimeType: 'image/png',
              fileName: 'diagram.png',
              sizeBytes: 30,
            },
          ],
        },
      ],
      attachments: [
        {
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: 'img-1.png',
          originalFileName: 'diagram.png',
          sizeBytes: 30,
          width: null,
          height: null,
          sourceTurnIds: ['turn-1'],
          relativePath: 'artifacts/attachments/files/img-1.png',
        },
      ],
    });

    expect(markdown).toContain('# Exporter');
    expect(markdown).toContain('[Open in Lody](lody://session/session-1?workspace=workspace-1)');
    expect(markdown).toContain('[Old](lody://session/child?workspace=workspace-1)');
    expect(markdown).toContain('#### Thought');
    expect(markdown).toContain('Need to keep this independent.');
    expect(markdown).toContain('![diagram.png](artifacts/attachments/files/img-1.png)');
  });
});

describe('prepareExportOutputDir', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      })
    );
  });

  it('rejects directories with real content', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'lody-export-test-'));
    tempDirs.push(target);
    await writeFile(path.join(target, 'notes.txt'), 'keep out', 'utf8');

    await expect(prepareExportOutputDir(target)).rejects.toThrow(/Output directory is not empty/);
  });
});
