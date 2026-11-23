import { describe, expect, it, vi } from 'vitest';

import { importProjectHistoryForLocalProject } from '../src/lib/project-history-control-client';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalProjectHistoryCatalogResult,
  LocalProjectHistoryImportResult,
  LocalProjectId,
  MachineId,
  WorkspaceId,
} from '@lody/shared';

function makeCatalog(listed: number): LocalProjectHistoryCatalogResult {
  return { listed, lastListedAt: listed, sessions: [] };
}

function makeImportResult(
  overrides: Partial<LocalProjectHistoryImportResult['summary']>,
  catalog: LocalProjectHistoryCatalogResult
): LocalProjectHistoryImportResult {
  return {
    summary: {
      listed: 0,
      imported: 0,
      refreshed: 0,
      skipped: 0,
      conflicted: 0,
      failed: 0,
      failures: [],
      ...overrides,
    },
    catalog,
  };
}

function makeRuntime(
  handler: (
    request: Extract<LocalProjectControlRequest, { type: 'local-project/import-history' }>
  ) => LocalProjectHistoryImportResult
): { runtime: WorkspaceRuntime; calls: string[][] } {
  const calls: string[][] = [];
  const requestLocalProjectControl = vi.fn(
    async (request: LocalProjectControlRequest): Promise<LocalProjectControlResponse | null> => {
      if (request.type !== 'local-project/import-history') {
        throw new Error(`unexpected request type: ${request.type}`);
      }
      calls.push(request.acpSessionIds);
      return {
        ok: true,
        type: 'local-project/import-history',
        result: handler(request),
      };
    }
  );
  const runtime = { requestLocalProjectControl } as unknown as WorkspaceRuntime;
  return { runtime, calls };
}

const baseArgs = {
  provider: 'claude-code' as never,
  localMachineId: 'machine-1' as MachineId,
  machineId: 'machine-1' as MachineId,
  workspaceId: 'workspace-1' as WorkspaceId,
  localProjectId: 'project-1' as LocalProjectId,
  requestedByUserId: 'user-1',
};

describe('importProjectHistoryForLocalProject batching', () => {
  it('merges per-batch summaries and keeps the last catalog', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `session-${i}`);
    let call = 0;
    const { runtime } = makeRuntime((request) => {
      call += 1;
      // First batch: all imported. Second batch: one failure + one refreshed.
      if (call === 1) {
        return makeImportResult({ imported: 5 }, makeCatalog(100));
      }
      return makeImportResult(
        {
          refreshed: 1,
          failed: 1,
          failures: [{ acpSessionId: request.acpSessionIds[1] ?? 'x', message: 'boom' }],
        },
        makeCatalog(200)
      );
    });

    const result = await importProjectHistoryForLocalProject({
      ...baseArgs,
      runtime,
      acpSessionIds: ids,
    });

    expect(result.summary.imported).toBe(5);
    expect(result.summary.refreshed).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.failures).toHaveLength(1);
    // Last batch's catalog wins (it is the most complete snapshot).
    expect(result.catalog.listed).toBe(200);
  });
});
