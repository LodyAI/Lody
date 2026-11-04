import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceSummary, syncItems } from './sync';

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
});
