import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

const execGit = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execGit }) };
});

import { scanGitDirectoryEntries } from './file-index-scan-core';

describe('Git scan subprocess lifecycle', () => {
  it('waits for the sibling Git process before returning a failed-listing fallback', async () => {
    const { promise: deleted, resolve: finishDeleted } = Promise.withResolvers<{
      stdout: string;
    }>();
    execGit.mockRejectedValueOnce(new Error('not a Git repository')).mockReturnValueOnce(deleted);

    let settled = false;
    const scan = scanGitDirectoryEntries({
      directoryAbsolutePath: 'synthetic-workspace',
      directoryWorkspacePath: '',
      entryBudget: 100,
      recursive: true,
    }).finally(() => {
      settled = true;
    });
    try {
      // Flush promise reactions through an event-loop boundary, with no clock
      // delay. The sibling process remains held by the explicit deferred result.
      await setImmediate();
      expect(settled).toBe(false);
    } finally {
      finishDeleted({ stdout: '' });
    }
    await expect(scan).resolves.toBeNull();
  });
});
