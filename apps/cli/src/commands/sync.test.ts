import { describe, expect, it, vi } from 'vitest';
import { buildSyncDocIds, createWorkspaceSummary, mergeSummaries, syncItems } from './sync';

describe('buildSyncDocIds', () => {
  it('returns a stable order of alive rooms', () => {
    expect(buildSyncDocIds(['session-b', 'session-a', 'machine-1'])).toEqual([
      'machine-1',
      'session-a',
      'session-b',
    ]);
  });
});

describe('sync command helpers', () => {
  it('continues syncing remaining items after one item fails', async () => {
    const summary = createWorkspaceSummary('workspace-1');
    const syncOne = vi.fn(async (id: string) => {
      if (id === 'doc-2') {
        throw new Error('network unavailable');
      }
    });

    await syncItems({
      summary,
      kind: 'doc',
      ids: ['doc-1', 'doc-2', 'doc-3'],
      concurrency: 2,
      outputMode: 'json',
      syncOne,
    });

    expect(syncOne).toHaveBeenCalledTimes(3);
    expect(summary.totals.doc).toBe(3);
    expect(summary.completed.doc).toBe(2);
    expect(summary.failed.doc).toBe(1);
    expect(summary.failures).toEqual([
      {
        workspaceId: 'workspace-1',
        kind: 'doc',
        id: 'doc-2',
        error: 'network unavailable',
      },
    ]);
  });

  it('merges workspace summaries into final exit summary counters', async () => {
    const first = createWorkspaceSummary('workspace-1');
    first.totals.meta = 1;
    first.completed.meta = 1;

    const second = createWorkspaceSummary('workspace-2');
    second.totals.meta = 1;
    second.failed.meta = 1;
    second.failures.push({
      workspaceId: 'workspace-2',
      kind: 'meta',
      id: 'meta',
      error: 'timeout',
    });

    expect(mergeSummaries([first, second])).toMatchObject({
      ok: false,
      total: 2,
      completed: 1,
      failed: 1,
      failures: [
        {
          workspaceId: 'workspace-2',
          kind: 'meta',
          id: 'meta',
          error: 'timeout',
        },
      ],
    });
  });
});
